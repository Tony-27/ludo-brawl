"""Rooms, players and turn orchestration (bots, AFK timeouts, idle cleanup).

Everything here is synchronous and meant to be called from a single asyncio
event loop, so no locking is needed.
"""

from __future__ import annotations

import random
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable

from . import bots
from .game import CLOCKWISE, Color, LudoGame, MoveResult, Phase, RollResult, RuleError

MAX_PLAYERS = 4
MIN_PLAYERS = 2
NAME_MAX = 20
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
CODE_LENGTH = 5
# Preferred colour for each new seat: opposite corners first.
SEAT_PREFERENCE = (Color.RED, Color.YELLOW, Color.GREEN, Color.BLUE)


class RoomState(str, Enum):
    LOBBY = "lobby"
    PLAYING = "playing"
    FINISHED = "finished"


class LudoError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


@dataclass
class Player:
    id: str
    token: str
    name: str
    color: Color
    is_bot: bool = False
    connections: int = 0

    @property
    def connected(self) -> bool:
        return self.is_bot or self.connections > 0


@dataclass
class Room:
    code: str
    host_id: str
    players: list[Player] = field(default_factory=list)
    state: RoomState = RoomState.LOBBY
    game: LudoGame | None = None
    log: deque = field(default_factory=lambda: deque(maxlen=40))
    log_seq: int = 0
    roll_seq: int = 0
    version: int = 0
    last_activity: float = 0.0
    turn_started: float = 0.0

    def player(self, player_id: str) -> Player | None:
        return next((p for p in self.players if p.id == player_id), None)

    def by_color(self, color: Color) -> Player | None:
        return next((p for p in self.players if p.color == color), None)

    @property
    def humans(self) -> list[Player]:
        return [p for p in self.players if not p.is_bot]


@dataclass
class Settings:
    bot_delay: float = 0.9  # seconds a bot "thinks" before each action
    turn_timeout: float = 30.0  # seconds before an idle human is auto-played
    room_idle_ttl: float = 2 * 60 * 60  # seconds before an untouched room is deleted


class RoomManager:
    def __init__(
        self,
        settings: Settings | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        rng: random.Random | None = None,
    ):
        self.settings = settings or Settings()
        self.clock = clock
        self.rng = rng or random.SystemRandom()
        self.rooms: dict[str, Room] = {}
        self._listeners: list[Callable[[Room], None]] = []

    # ------------------------------------------------------------- plumbing
    def subscribe(self, listener: Callable[[Room], None]) -> None:
        self._listeners.append(listener)

    def _changed(self, room: Room, *, new_turn: bool = False) -> None:
        room.version += 1
        room.last_activity = self.clock()
        if new_turn:
            room.turn_started = room.last_activity
        for listener in self._listeners:
            listener(room)

    def _log(self, room: Room, text: str, color: Color | None = None) -> None:
        room.log_seq += 1
        room.log.append({"id": room.log_seq, "text": text, "color": color.value if color else None})

    def _new_code(self) -> str:
        while True:
            code = "".join(self.rng.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            if code not in self.rooms:
                return code

    @staticmethod
    def _clean_name(name: str) -> str:
        name = " ".join((name or "").split())
        if not name:
            raise LudoError("Please enter a name.")
        if len(name) > NAME_MAX:
            raise LudoError(f"Names can be at most {NAME_MAX} characters.")
        return name

    @staticmethod
    def _free_color(room: Room) -> Color:
        taken = {p.color for p in room.players}
        return next(c for c in SEAT_PREFERENCE if c not in taken)

    def _new_player(self, room: Room, name: str, *, is_bot: bool = False) -> Player:
        player = Player(
            id=secrets.token_hex(4),
            token=secrets.token_urlsafe(24),
            name=name,
            color=self._free_color(room),
            is_bot=is_bot,
        )
        room.players.append(player)
        return player

    # ------------------------------------------------------------- lookups
    def get(self, code: str) -> Room:
        room = self.rooms.get((code or "").strip().upper())
        if room is None:
            raise LudoError("Room not found. Check the code and try again.", 404)
        return room

    def authenticate(self, room: Room, token: str | None) -> Player:
        player = next((p for p in room.players if token and secrets.compare_digest(p.token, token)), None)
        if player is None or player.is_bot:
            raise LudoError("You are not a player in this room.", 403)
        return player

    def _require_host(self, room: Room, actor: Player) -> None:
        if room.host_id != actor.id:
            raise LudoError("Only the host can do that.", 403)

    def _require_lobby(self, room: Room) -> None:
        if room.state != RoomState.LOBBY:
            raise LudoError("The game has already started.", 409)

    # ------------------------------------------------------------- lobby
    def create_room(self, name: str) -> tuple[Room, Player]:
        name = self._clean_name(name)
        room = Room(code=self._new_code(), host_id="")
        player = self._new_player(room, name)
        room.host_id = player.id
        self.rooms[room.code] = room
        self._log(room, f"{name} created the room.")
        self._changed(room)
        return room, player

    def join(self, code: str, name: str) -> tuple[Room, Player]:
        room = self.get(code)
        name = self._clean_name(name)
        self._require_lobby(room)
        if len(room.players) >= MAX_PLAYERS:
            raise LudoError("This room is full.", 409)
        if any(p.name.lower() == name.lower() for p in room.players):
            raise LudoError("Someone in this room already uses that name.", 409)
        player = self._new_player(room, name)
        self._log(room, f"{name} joined.", player.color)
        self._changed(room)
        return room, player

    def add_bot(self, room: Room, actor: Player) -> Player:
        self._require_host(room, actor)
        self._require_lobby(room)
        if len(room.players) >= MAX_PLAYERS:
            raise LudoError("This room is full.", 409)
        used = {p.name for p in room.players}
        name = next((n for n in bots.BOT_NAMES if n not in used), f"Bot {len(room.players) + 1}")
        bot = self._new_player(room, name, is_bot=True)
        self._log(room, f"{name} (bot) joined.", bot.color)
        self._changed(room)
        return bot

    def kick(self, room: Room, actor: Player, target_id: str) -> None:
        self._require_host(room, actor)
        self._require_lobby(room)
        target = room.player(target_id)
        if target is None:
            raise LudoError("No such player.", 404)
        if target.id == actor.id:
            raise LudoError("You can't remove yourself. Use Leave instead.")
        room.players.remove(target)
        self._log(room, f"{target.name} was removed.", target.color)
        self._changed(room)

    def set_color(self, room: Room, actor: Player, color: Color) -> None:
        self._require_lobby(room)
        if actor.color == color:
            return
        if room.by_color(color):
            raise LudoError("That colour is taken.", 409)
        actor.color = color
        self._changed(room)

    def start(self, room: Room, actor: Player) -> None:
        self._require_host(room, actor)
        self._require_lobby(room)
        if len(room.players) < MIN_PLAYERS:
            raise LudoError("You need at least 2 players. Invite a friend or add a bot.")
        room.game = LudoGame([p.color for p in room.players])
        room.state = RoomState.PLAYING
        first = room.by_color(room.game.current)
        self._log(room, f"Game on! {first.name} goes first.", first.color)
        self._changed(room, new_turn=True)

    def rematch(self, room: Room, actor: Player) -> None:
        self._require_host(room, actor)
        if room.state != RoomState.FINISHED:
            raise LudoError("The game isn't over yet.", 409)
        room.state = RoomState.LOBBY
        room.game = None
        room.log.clear()
        self._log(room, "Back in the lobby for a rematch.")
        self._changed(room)

    def leave(self, room: Room, actor: Player) -> None:
        if room.state == RoomState.PLAYING:
            # Keep the game fair for everyone else: a bot takes over the seat.
            actor.is_bot = True
            self._log(room, f"{actor.name} left. A bot takes over.", actor.color)
            actor.name = f"{actor.name} (bot)"
        else:
            room.players.remove(actor)
            self._log(room, f"{actor.name} left.", actor.color)

        if not room.humans:
            del self.rooms[room.code]
            return
        if room.host_id == actor.id:
            room.host_id = room.humans[0].id
            self._log(room, f"{room.humans[0].name} is now the host.")
        self._changed(room)

    def set_connected(self, room: Room, player: Player, delta: int) -> None:
        was = player.connected
        player.connections = max(0, player.connections + delta)
        if was != player.connected:
            self._changed(room)

    # ------------------------------------------------------------- gameplay
    def _require_turn(self, room: Room, actor: Player) -> LudoGame:
        if room.state != RoomState.PLAYING or room.game is None:
            raise LudoError("The game isn't running.", 409)
        if room.game.current != actor.color:
            raise LudoError("It's not your turn.", 409)
        return room.game

    def roll(self, room: Room, actor: Player, value: int | None = None) -> RollResult:
        game = self._require_turn(room, actor)
        try:
            result = game.roll(value or self.rng.randint(1, 6))
        except RuleError as e:
            raise LudoError(str(e), 409) from e
        room.roll_seq += 1

        if result.forfeited:
            self._log(room, f"{actor.name} rolled a third six in a row and loses the turn.", actor.color)
        elif result.passed:
            self._log(room, f"{actor.name} rolled {result.value}. No moves possible.", actor.color)
        elif result.auto_move:
            self._log_move(room, actor, result.auto_move)
        self._after_action(room)
        return result

    def move(self, room: Room, actor: Player, piece: int) -> MoveResult:
        game = self._require_turn(room, actor)
        try:
            result = game.move(piece)
        except RuleError as e:
            raise LudoError(str(e), 409) from e
        self._log_move(room, actor, result)
        self._after_action(room)
        return result

    def _log_move(self, room: Room, actor: Player, result: MoveResult) -> None:
        roll = room.game.last_roll if room.game else "?"
        if result.start == -1:
            text = f"{actor.name} rolled {roll} and brought a piece out."
        elif result.finished_piece:
            text = f"{actor.name} rolled {roll} and got a piece home!"
        else:
            text = f"{actor.name} rolled {roll} and moved."
        self._log(room, text, actor.color)
        for cap in result.captures:
            victim = room.by_color(cap.color)
            self._log(room, f"💥 {actor.name} knocked out {victim.name if victim else cap.color.value}!", actor.color)
        if result.finished_player:
            place = len(room.game.ranking) if room.game else 0
            self._log(room, f"🏆 {actor.name} finished in place #{place}!", actor.color)

    def _after_action(self, room: Room) -> None:
        game = room.game
        assert game is not None
        if game.phase == Phase.OVER:
            room.state = RoomState.FINISHED
            winner = room.by_color(game.ranking[0])
            self._log(room, f"🎉 {winner.name} wins the game!", winner.color)
        self._changed(room, new_turn=True)

    # ------------------------------------------------------------- ticking
    def tick(self) -> None:
        """Advance bots / timed-out humans by one action and drop idle rooms."""
        now = self.clock()
        for room in list(self.rooms.values()):
            if now - room.last_activity > self.settings.room_idle_ttl:
                del self.rooms[room.code]
                continue
            if room.state != RoomState.PLAYING or room.game is None:
                continue
            current = room.by_color(room.game.current)
            if current is None:
                continue
            waited = now - room.turn_started
            if current.is_bot and waited >= self.settings.bot_delay:
                self.auto_play(room, current)
            elif not current.is_bot and waited >= self.settings.turn_timeout:
                action = "rolled" if room.game.phase == Phase.ROLL else "moved"
                self._log(room, f"⏰ {current.name} took too long, so we {action} for them.", current.color)
                self.auto_play(room, current)

    def auto_play(self, room: Room, player: Player) -> None:
        game = room.game
        assert game is not None
        if game.phase == Phase.ROLL:
            self.roll(room, player)
        elif game.phase == Phase.MOVE:
            self.move(room, player, bots.choose_piece(game))

    # ------------------------------------------------------------- views
    def view(self, room: Room) -> dict:
        game = room.game
        game_view = None
        if game is not None:
            current = room.by_color(game.current)
            time_left = None
            if room.state == RoomState.PLAYING and current and not current.is_bot:
                time_left = max(0.0, self.settings.turn_timeout - (self.clock() - room.turn_started))
            lm = game.last_move
            game_view = {
                "turnOrder": [c.value for c in game.turn_order],
                "current": game.current.value,
                "phase": game.phase.value,
                "lastRoll": game.last_roll,
                "rollSeq": room.roll_seq,
                "legalPieces": game.legal_pieces(),
                "pieces": {c.value: list(ps) for c, ps in game.pieces.items()},
                "ranking": [c.value for c in game.ranking],
                "turnTimeLeftMs": None if time_left is None else int(time_left * 1000),
                "lastMove": None
                if lm is None
                else {
                    "color": lm.color.value,
                    "piece": lm.piece,
                    "start": lm.start,
                    "end": lm.end,
                    "captures": [{"color": c.color.value, "piece": c.piece} for c in lm.captures],
                },
            }
        return {
            "code": room.code,
            "state": room.state.value,
            "hostId": room.host_id,
            "version": room.version,
            "colors": [c.value for c in CLOCKWISE],
            "players": [
                {
                    "id": p.id,
                    "name": p.name,
                    "color": p.color.value,
                    "isBot": p.is_bot,
                    "connected": p.connected,
                }
                for p in room.players
            ],
            "game": game_view,
            "log": list(room.log),
        }
