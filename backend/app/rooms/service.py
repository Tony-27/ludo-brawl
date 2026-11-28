"""Rooms, seats and turn orchestration (bots, AFK timeouts, idle cleanup).

Synchronous and single-threaded by design: every call happens on the asyncio
event loop, so no locks are needed. Storage sits behind RoomStore so it can
move to Redis when we run more than one server.
"""

from __future__ import annotations

import random
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from ..game import bots
from ..game.board import CLOCKWISE, DEFAULT_MAP, Color, load_board
from ..game.events import _Event, dump
from ..game.heroes import DEFAULT_HERO, HEROES
from ..game.rules import Match, Phase, RuleError
from ..realtime.protocol import MatchView, PlayerView, RoomView

MAX_PLAYERS = 4
MIN_PLAYERS = 2
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
CODE_LENGTH = 5
SEAT_PREFERENCE = (Color.RED, Color.YELLOW, Color.GREEN, Color.BLUE)


class LudoError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


@dataclass
class Seat:
    id: str  # guest id, or "bot-..." for bots
    name: str
    color: Color
    hero: str = DEFAULT_HERO
    skin: str = ""
    is_bot: bool = False
    connections: int = 0

    @property
    def connected(self) -> bool:
        return self.is_bot or self.connections > 0


@dataclass
class Room:
    code: str
    host_id: str
    map_id: str = DEFAULT_MAP
    practice: bool = False  # sandbox: forced dice, free mana, not recorded
    forced_dice: int | None = None
    seats: list[Seat] = field(default_factory=list)
    state: str = "lobby"  # lobby | playing | finished
    match: Match | None = None
    rng: random.Random = field(default_factory=random.SystemRandom)
    seed: int | None = None
    version: int = 0
    seq: int = 0
    last_activity: float = 0.0
    turn_started: float = 0.0
    started_at: float = 0.0

    def seat(self, seat_id: str) -> Seat | None:
        return next((s for s in self.seats if s.id == seat_id), None)

    def by_color(self, color: Color) -> Seat | None:
        return next((s for s in self.seats if s.color == color), None)

    @property
    def humans(self) -> list[Seat]:
        return [s for s in self.seats if not s.is_bot]


class RoomStore(Protocol):
    def get(self, code: str) -> Room | None: ...
    def add(self, room: Room) -> None: ...
    def remove(self, code: str) -> None: ...
    def all(self) -> list[Room]: ...


class MemoryRoomStore:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}

    def get(self, code: str) -> Room | None:
        return self._rooms.get(code)

    def add(self, room: Room) -> None:
        self._rooms[room.code] = room

    def remove(self, code: str) -> None:
        self._rooms.pop(code, None)

    def all(self) -> list[Room]:
        return list(self._rooms.values())


@dataclass
class Timings:
    bot_delay: float = 1.1  # seconds a bot waits before acting (lets animations breathe)
    turn_timeout: float = 30.0  # seconds before an idle human is auto-played
    act_timeout: float = 12.0  # seconds to cast after moving before the turn ends by itself
    room_idle_ttl: float = 2 * 60 * 60


@dataclass
class MatchRecord:
    """What gets persisted when a match ends."""

    room_code: str
    map_id: str
    seed: int | None
    duration_s: float
    turns: int
    participants: list[dict]  # {guest_id|None, name, color, hero, skin, is_bot, place}


Listener = Callable[[Room, list[dict]], None]


def _default_skin(hero: str) -> str:
    return HEROES[hero].skins[0].id


class RoomService:
    def __init__(
        self,
        timings: Timings | None = None,
        *,
        store: RoomStore | None = None,
        clock: Callable[[], float] = time.monotonic,
        rng_factory: Callable[[], random.Random] = random.SystemRandom,
    ):
        self.timings = timings or Timings()
        self.store = store or MemoryRoomStore()
        self.clock = clock
        self.rng_factory = rng_factory
        self._listeners: list[Listener] = []
        self.on_match_finished: Callable[[MatchRecord], None] = lambda record: None

    # ------------------------------------------------------------- plumbing
    def subscribe(self, listener: Listener) -> None:
        self._listeners.append(listener)

    def _changed(self, room: Room, events: list[_Event] | None = None, *, new_turn: bool = False) -> None:
        room.version += 1
        room.last_activity = self.clock()
        if new_turn:
            room.turn_started = room.last_activity
        payload = dump(events or [])
        if payload:
            room.seq += 1
        for listener in self._listeners:
            listener(room, payload)

    def _new_code(self) -> str:
        rng = random.SystemRandom()
        while True:
            code = "".join(rng.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            if self.store.get(code) is None:
                return code

    @staticmethod
    def _free_color(room: Room) -> Color:
        taken = {s.color for s in room.seats}
        board = load_board(room.map_id)
        return next(c for c in SEAT_PREFERENCE if c not in taken and c in board.teams)

    # ------------------------------------------------------------- lookups
    def get(self, code: str) -> Room:
        room = self.store.get((code or "").strip().upper())
        if room is None:
            raise LudoError("Room not found. Check the code and try again.", 404)
        return room

    def seat_of(self, room: Room, guest_id: str) -> Seat:
        seat = room.seat(guest_id)
        if seat is None or seat.is_bot:
            raise LudoError("You are not a player in this room.", 403)
        return seat

    def rooms_of(self, guest_id: str) -> list[Room]:
        return [r for r in self.store.all() if r.seat(guest_id) and not r.seat(guest_id).is_bot]

    def _require_host(self, room: Room, seat: Seat) -> None:
        if room.host_id != seat.id:
            raise LudoError("Only the host can do that.", 403)

    def _require_lobby(self, room: Room) -> None:
        if room.state != "lobby":
            raise LudoError("The game has already started.", 409)

    # ------------------------------------------------------------- lobby
    def create_room(self, guest_id: str, name: str, map_id: str = DEFAULT_MAP) -> Room:
        try:
            load_board(map_id)
        except KeyError:
            raise LudoError("Unknown map.") from None
        room = Room(code=self._new_code(), host_id=guest_id, map_id=map_id)
        room.seats.append(Seat(guest_id, name, self._free_color(room), skin=_default_skin(DEFAULT_HERO)))
        self.store.add(room)
        self._changed(room)
        return room

    def join(self, code: str, guest_id: str, name: str) -> Room:
        room = self.get(code)
        if room.seat(guest_id):
            return room  # rejoining is a no-op
        self._require_lobby(room)
        if len(room.seats) >= min(MAX_PLAYERS, len(load_board(room.map_id).teams)):
            raise LudoError("This room is full.", 409)
        if any(s.name.lower() == name.lower() for s in room.seats):
            name = f"{name} {len(room.seats) + 1}"
        room.seats.append(Seat(guest_id, name, self._free_color(room), skin=_default_skin(DEFAULT_HERO)))
        self._changed(room)
        return room

    def add_bot(self, room: Room, seat: Seat, hero: str | None = None) -> None:
        self._require_host(room, seat)
        self._require_lobby(room)
        if len(room.seats) >= min(MAX_PLAYERS, len(load_board(room.map_id).teams)):
            raise LudoError("This room is full.", 409)
        hero = hero or random.choice([h.id for h in HEROES.values() if h.selectable])
        self._check_hero(hero)
        used = {s.name for s in room.seats}
        name = next((n for n in bots.BOT_NAMES if n not in used), f"Bot {len(room.seats) + 1}")
        room.seats.append(
            Seat(f"bot-{secrets.token_hex(3)}", name, self._free_color(room), hero, _default_skin(hero), is_bot=True)
        )
        self._changed(room)

    def kick(self, room: Room, seat: Seat, target_id: str) -> None:
        self._require_host(room, seat)
        self._require_lobby(room)
        target = room.seat(target_id)
        if target is None:
            raise LudoError("No such player.", 404)
        if target.id == seat.id:
            raise LudoError("You can't remove yourself. Use Leave instead.")
        room.seats.remove(target)
        self._changed(room)

    @staticmethod
    def _check_hero(hero: str) -> None:
        if hero not in HEROES or not HEROES[hero].selectable:
            raise LudoError("That hero isn't available yet.")

    def set_loadout(self, room: Room, seat: Seat, *, color: Color | None, hero: str | None, skin: str | None) -> None:
        self._require_lobby(room)
        if color is not None and color != seat.color:
            if room.by_color(color):
                raise LudoError("That colour is taken.", 409)
            if color not in load_board(room.map_id).teams:
                raise LudoError("That colour isn't on this map.")
            seat.color = color
        if hero is not None and hero != seat.hero:
            self._check_hero(hero)
            seat.hero = hero
            seat.skin = _default_skin(hero)
        if skin is not None:
            # Skins are cosmetic. Ownership checks plug in here once accounts exist.
            if skin not in {s.id for s in HEROES[seat.hero].skins}:
                raise LudoError("That skin doesn't belong to this hero.")
            seat.skin = skin
        self._changed(room)

    def set_map(self, room: Room, seat: Seat, map_id: str) -> None:
        self._require_host(room, seat)
        self._require_lobby(room)
        try:
            board = load_board(map_id)
        except KeyError:
            raise LudoError("Unknown map.") from None
        if len(room.seats) > len(board.teams):
            raise LudoError("Too many players for that map.")
        room.map_id = map_id
        # Keep colours that exist on the new map; reseat everyone else.
        keep = [x for x in room.seats if x.color in board.teams]
        taken = {x.color for x in keep}
        for x in room.seats:
            if x not in keep:
                x.color = next(c for c in SEAT_PREFERENCE if c not in taken and c in board.teams)
                taken.add(x.color)
        self._changed(room)

    def set_practice(self, room: Room, seat: Seat, enabled: bool) -> None:
        self._require_host(room, seat)
        self._require_lobby(room)
        room.practice = enabled
        self._changed(room)

    def start(self, room: Room, seat: Seat, *, seed: int | None = None) -> None:
        self._require_host(room, seat)
        self._require_lobby(room)
        if len(room.seats) < MIN_PLAYERS:
            raise LudoError("You need at least 2 players. Invite a friend or add a bot.")
        room.seed = seed if seed is not None else secrets.randbits(48)
        room.rng = random.Random(room.seed)
        room.match = Match(load_board(room.map_id), {s.color: s.hero for s in room.seats}, rng=room.rng)
        room.state = "playing"
        room.started_at = self.clock()
        self._changed(room, room.match.take_events(), new_turn=True)

    def rematch(self, room: Room, seat: Seat) -> None:
        self._require_host(room, seat)
        if room.state != "finished":
            raise LudoError("The game isn't over yet.", 409)
        room.state = "lobby"
        room.match = None
        self._changed(room)

    def leave(self, room: Room, seat: Seat) -> None:
        if room.state == "playing":
            seat.is_bot = True  # a bot takes over so the match can go on
            seat.name = f"{seat.name} (bot)"
            seat.id = f"bot-{secrets.token_hex(3)}"
        else:
            room.seats.remove(seat)
        if not room.humans:
            self.store.remove(room.code)
            return
        host = room.seat(room.host_id)
        if host is None or host.is_bot:
            room.host_id = room.humans[0].id
        self._changed(room)

    def set_connected(self, room: Room, seat: Seat, delta: int) -> None:
        was = seat.connected
        seat.connections = max(0, seat.connections + delta)
        if was != seat.connected:
            self._changed(room)

    # ------------------------------------------------------------- gameplay
    def _require_turn(self, room: Room, seat: Seat) -> Match:
        if room.state != "playing" or room.match is None:
            raise LudoError("The game isn't running.", 409)
        if room.match.current != seat.color:
            raise LudoError("It's not your turn.", 409)
        return room.match

    def _run(self, room: Room, fn: Callable[[], list[_Event]]) -> None:
        try:
            events = fn()
        except RuleError as e:
            raise LudoError(str(e), 409) from e
        match = room.match
        assert match is not None
        if match.is_over and room.state == "playing":
            room.state = "finished"
            self._record(room)
        self._changed(room, events, new_turn=True)

    def roll(self, room: Room, seat: Seat) -> None:
        match = self._require_turn(room, seat)
        value = room.forced_dice or room.rng.randint(1, 6)
        room.forced_dice = None
        self._run(room, lambda: match.roll(value))

    def move(self, room: Room, seat: Seat, piece: int, lane: int | None = None) -> None:
        match = self._require_turn(room, seat)
        self._run(room, lambda: match.move(piece, lane))

    def practice(self, room: Room, seat: Seat, *, dice: int | None, mana: int | None) -> None:
        if not room.practice:
            raise LudoError("Practice tools only work in practice rooms.", 403)
        if room.state != "playing" or room.match is None:
            raise LudoError("The game isn't running.", 409)
        if dice is not None:
            room.forced_dice = dice
        events = room.match.practice_set_mana(seat.color, mana) if mana is not None else []
        self._changed(room, events)

    def cast(self, room: Room, seat: Seat, ability: str, target: dict) -> None:
        match = self._require_turn(room, seat)
        target = {k: v for k, v in target.items() if k != "preview"}
        self._run(room, lambda: match.cast(ability, target))

    def end_turn(self, room: Room, seat: Seat) -> None:
        match = self._require_turn(room, seat)
        self._run(room, match.end_turn)

    def _timeout(self, room: Room) -> float:
        match = room.match
        if match is not None and match.phase == Phase.ACT:
            return self.timings.act_timeout
        return self.timings.turn_timeout

    def _record(self, room: Room) -> None:
        match = room.match
        assert match is not None
        if room.practice:
            return  # sandbox games don't count
        place = {c: i + 1 for i, c in enumerate(match.ranking)}
        record = MatchRecord(
            room_code=room.code,
            map_id=room.map_id,
            seed=room.seed,
            duration_s=round(self.clock() - room.started_at, 1),
            turns=match.turn,
            participants=[
                {
                    "guest_id": None if s.is_bot else s.id,
                    "name": s.name,
                    "color": s.color.value,
                    "hero": s.hero,
                    "skin": s.skin,
                    "is_bot": s.is_bot,
                    "place": place.get(s.color),
                }
                for s in room.seats
            ],
        )
        self.on_match_finished(record)

    # ------------------------------------------------------------- ticking
    def tick(self) -> None:
        """Let bots act, auto-play idle humans and drop idle rooms."""
        now = self.clock()
        for room in self.store.all():
            if now - room.last_activity > self.timings.room_idle_ttl:
                self.store.remove(room.code)
                continue
            if room.state != "playing" or room.match is None:
                continue
            seat = room.by_color(room.match.current)
            if seat is None:
                continue
            waited = now - room.turn_started
            if (seat.is_bot and waited >= self.timings.bot_delay) or (
                not seat.is_bot and waited >= self._timeout(room)
            ):
                self.auto_play(room, seat)

    def auto_play(self, room: Room, seat: Seat) -> None:
        match = room.match
        assert match is not None
        action = bots.choose_action(match, room.rng)
        if action.kind == "cast" and not seat.is_bot:
            # Don't spend an idle player's mana.
            action = bots.BotAction("end") if match.phase == Phase.ACT else bots.BotAction("roll")
            if match.phase == Phase.MOVE:
                action = bots.best_move(match, room.rng)
        if action.kind == "cast":
            self.cast(room, seat, action.ability or "", action.target or {})
        elif action.kind == "roll":
            self.roll(room, seat)
        elif action.kind == "end":
            self.end_turn(room, seat)
        else:
            self.move(room, seat, action.piece or 0, action.lane)

    # ------------------------------------------------------------- views
    def view(self, room: Room) -> RoomView:
        match_view = None
        if room.match is not None:
            snap = room.match.snapshot()
            seat = room.by_color(room.match.current)
            if room.state == "playing" and seat and not seat.is_bot:
                left = max(0.0, self._timeout(room) - (self.clock() - room.turn_started))
                snap["turnTimeLeftMs"] = int(left * 1000)
            match_view = MatchView.model_validate(snap)
        return RoomView(
            code=room.code,
            state=room.state,  # type: ignore[arg-type]
            hostId=room.host_id,
            mapId=room.map_id,
            practice=room.practice,
            version=room.version,
            seq=room.seq,
            players=[
                PlayerView(
                    id=s.id,
                    name=s.name,
                    color=s.color,
                    hero=s.hero,
                    skin=s.skin,
                    isBot=s.is_bot,
                    connected=s.connected,
                )
                for s in sorted(room.seats, key=lambda s: CLOCKWISE.index(s.color))
            ],
            match=match_view,
        )
