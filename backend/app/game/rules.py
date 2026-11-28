"""The match rules engine: a pure state machine that emits domain events.

No I/O and no hidden randomness: dice values come from the caller (who uses
the match's seeded RNG), so matches are reproducible and easy to test.

Turn flow:
    ROLL  - the player may cast one ability, then rolls
    MOVE  - the player may still cast (if they haven't), then moves a piece
A roll of 6, a capture or getting a piece home grants another roll in the
same turn. Only one ability may be cast per turn; ultimates once per match.

The *arrival rule*: whenever a piece lands on a tile, by any means (move,
dash, knockback, swap, slide, portal...), the tile applies to it. That is
what lets spells push enemies into pits.
"""

from __future__ import annotations

import copy
import random
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal

from . import events as ev
from .board import CAMP, Board, Color, Node
from .heroes import ABILITIES, HEROES


class RuleError(Exception):
    """An action that breaks the rules (wrong phase, illegal target...)."""


class Phase(StrEnum):
    ROLL = "roll"
    MOVE = "move"
    OVER = "over"


Cause = Literal["move", "dash", "knockback", "teleport", "swap", "slide", "portal", "drift", "rally"]


@dataclass(frozen=True)
class RuleConfig:
    max_mana: int = 6
    starting_mana: int = 0
    mana_per_turn: int = 1
    mana_rolled_one: int = 1
    mana_knocked_out: int = 2
    mana_knocked_back: int = 1
    mana_shrine: int = 2
    mana_bushido: int = 1
    mana_burn: int = 1
    max_sixes: int = 3
    max_chain: int = 3  # slide/portal chain depth
    bridge_rebuild_turns: int = 8  # turns (all players) until a collapsed bridge is back


@dataclass
class Team:
    color: Color
    hero: str
    pieces: list[int]
    lanes: list[int]
    mana: int = 0
    statuses: list[dict[str, int]] = field(default_factory=list)  # per piece: {"shield": 1, "rooted": n}
    ult_used: bool = False


@dataclass
class TileEffect:
    kind: Literal["crater", "fire", "trap"]
    turns: int  # counted in the owner's turns
    owner: Color


@dataclass(frozen=True)
class MoveOption:
    piece: int
    lane: int | None  # None when no lane choice is involved
    to: int


class Match:
    def __init__(
        self,
        board: Board,
        heroes: dict[Color, str],
        *,
        rng: random.Random | None = None,
        config: RuleConfig | None = None,
    ):
        order = [c for c in board.teams if c in heroes]
        if not 2 <= len(order) <= 4 or len(order) != len(heroes):
            raise RuleError("A match needs 2-4 teams that exist on this map.")
        for hero in heroes.values():
            if hero not in HEROES:
                raise RuleError(f"Unknown hero {hero}.")
        self.board = board
        self.config = config or RuleConfig()
        self.rng = rng or random.Random()
        n = board.pieces_per_team
        self.teams: dict[Color, Team] = {
            c: Team(c, heroes[c], [CAMP] * n, [0] * n, self.config.starting_mana, [{} for _ in range(n)]) for c in order
        }
        self.order = order
        self.current: Color = order[0]
        self.phase = Phase.ROLL
        self.turn = 0
        self.last_roll: int | None = None
        self.sixes = 0
        self.cast_this_turn = False
        self.ranking: list[Color] = []
        self.tile_fx: dict[str, TileEffect] = {}
        self.crumble: dict[str, int] = {
            nid: int(n.hazard.get("uses", 3)) for nid, n in board.nodes.items() if n.hazard.get("type") == "crumble"
        }
        self.broken: dict[str, int] = {}  # collapsed bridge -> turns until rebuilt
        self._events: list[ev._Event] = []
        self._begin_turn()

    # ================================================================ queries
    @property
    def is_over(self) -> bool:
        return self.phase == Phase.OVER

    def take_events(self) -> list[ev._Event]:
        out, self._events = self._events, []
        return out

    def clone(self) -> Match:
        """Deep copy for look-ahead (bots), sharing the immutable board and config."""
        memo = {id(self.board): self.board, id(self.config): self.config, id(self.rng): random.Random(0)}
        return copy.deepcopy(self, memo)

    def node_of(self, color: Color, piece: int) -> Node | None:
        team = self.teams[color]
        return self.board.node(color, team.pieces[piece], team.lanes[piece])

    def is_finished(self, color: Color, piece: int) -> bool:
        return self.teams[color].pieces[piece] >= self.board.finish(color)

    def on_trail(self, color: Color, piece: int) -> bool:
        """Out of camp, not finished and on the shared loop (not the home path)."""
        node = self.node_of(color, piece)
        return node is not None and node.loop_index is not None and not self.is_finished(color, piece)

    def hazard_of(self, node: Node) -> str | None:
        """The effect a tile has on a piece that lands there right now."""
        fx = self.tile_fx.get(node.id)
        if node.id in self.broken or (fx and fx.kind == "crater"):
            return "pit"
        if node.hazard:
            return node.hazard["type"] if node.hazard["type"] != "crumble" else None
        return fx.kind if fx else None

    def target(self, color: Color, piece: int, roll: int) -> int | None:
        p = self.teams[color].pieces[piece]
        finish = self.board.finish(color)
        if p >= finish:
            return None
        if p == CAMP:
            return 0 if roll == 6 else None
        t = p + roll
        return t if t <= finish else None

    def move_options(self) -> list[MoveOption]:
        if self.phase != Phase.MOVE or self.last_roll is None:
            return []
        color = self.current
        team = self.teams[color]
        options: list[MoveOption] = []
        for i, p in enumerate(team.pieces):
            if "rooted" in team.statuses[i]:
                continue
            t = self.target(color, i, self.last_roll)
            if t is None:
                continue
            if self.board.needs_lane_choice(color, p, t):
                options += [MoveOption(i, 0, t), MoveOption(i, 1, t)]
            else:
                options.append(MoveOption(i, None, t))
        return options

    def legal_pieces(self) -> list[int]:
        return sorted({o.piece for o in self.move_options()})

    def can_cast(self, ability_id: str) -> bool:
        team = self.teams[self.current]
        ability = ABILITIES.get(ability_id)
        return (
            self.phase in (Phase.ROLL, Phase.MOVE)
            and not self.cast_this_turn
            and ability is not None
            and ability_id in HEROES[team.hero].abilities
            and team.mana >= ability.cost
            and not (ability.once_per_match and team.ult_used)
        )

    def cast_targets(self) -> dict[str, list[dict]]:
        """Every valid target for each ability the current player can afford right now."""
        from . import spells

        out: dict[str, list[dict]] = {}
        for aid in HEROES[self.teams[self.current].hero].abilities:
            if not self.can_cast(aid):
                continue
            ability = ABILITIES[aid]
            valid = []
            for target in spells.candidates(self, ability, self.current):
                try:
                    spells.EFFECTS[ability.effect](self, ability, self.current, target)
                except RuleError:
                    continue
                valid.append(target)
            if valid:
                out[aid] = valid
        return out

    def has_finished(self, color: Color) -> bool:
        finish = self.board.finish(color)
        return all(p >= finish for p in self.teams[color].pieces)

    def pieces_on(self, node_id: str, *, exclude: Color | None = None) -> list[tuple[Color, int]]:
        found = []
        for c, team in self.teams.items():
            if c == exclude:
                continue
            for i in range(len(team.pieces)):
                n = self.node_of(c, i)
                if n is not None and n.id == node_id and not self.is_finished(c, i):
                    found.append((c, i))
        return found

    # ================================================================ actions
    def roll(self, value: int, *, auto_move: bool = True) -> list[ev._Event]:
        if self.phase != Phase.ROLL:
            raise RuleError("You can't roll right now.")
        if not 1 <= value <= 6:
            raise RuleError("Dice value must be 1-6.")
        color = self.current
        self.last_roll = value
        self.sixes = self.sixes + 1 if value == 6 else 0
        self._emit(ev.Rolled(color=color, value=value))
        if value == 1:
            self._gain_mana(color, self.config.mana_rolled_one, "rolledOne")

        if self.sixes >= self.config.max_sixes:
            self._emit(ev.TurnPassed(color=color, reason="threeSixes"))
            self._end_turn()
            return self.take_events()

        self.phase = Phase.MOVE
        options = self.move_options()
        if not options:
            self._emit(ev.TurnPassed(color=color, reason="noMoves"))
            self._end_turn()
            return self.take_events()

        team = self.teams[color]
        if auto_move and len({(team.pieces[o.piece], o.lane) for o in options}) == 1:
            self._move(options[0].piece, options[0].lane)
        return self.take_events()

    def move(self, piece: int, lane: int | None = None) -> list[ev._Event]:
        if self.phase != Phase.MOVE or self.last_roll is None:
            raise RuleError("Roll the dice first.")
        options = [o for o in self.move_options() if o.piece == piece]
        if not options:
            raise RuleError("That piece can't move with this roll.")
        if options[0].lane is not None:
            lane = lane if lane in (0, 1) else 0
        self._move(piece, lane)
        return self.take_events()

    def cast(self, ability_id: str, target: dict) -> list[ev._Event]:
        from . import spells

        color = self.current
        team = self.teams[color]
        ability = ABILITIES.get(ability_id)
        if ability is None or ability_id not in HEROES[team.hero].abilities:
            raise RuleError("Your hero doesn't have that ability.")
        if self.phase not in (Phase.ROLL, Phase.MOVE):
            raise RuleError("You can't cast right now.")
        if self.cast_this_turn:
            raise RuleError("You already cast an ability this turn.")
        if ability.once_per_match and team.ult_used:
            raise RuleError("Ultimates can be used once per match.")
        if team.mana < ability.cost:
            raise RuleError("Not enough mana.")

        apply = spells.EFFECTS[ability.effect](self, ability, color, target)  # validates; raises RuleError
        self.cast_this_turn = True
        if ability.once_per_match:
            team.ult_used = True
        team.mana -= ability.cost
        spent = ev.ManaChanged(color=color, mana=team.mana, delta=-ability.cost, reason="cast")
        mark = len(self._events)
        apply()
        # Report the mana spend right after the AbilityCast event, before its effects.
        self._events.insert(mark + 1, spent)

        if not self.is_over and self.current == color and self.phase == Phase.MOVE and not self.move_options():
            self._emit(ev.TurnPassed(color=color, reason="noMoves"))
            self._end_turn()
        return self.take_events()

    # ---------------------------------------------------------------- practice
    def practice_set_mana(self, color: Color, mana: int) -> list[ev._Event]:
        team = self.teams[color]
        new = max(0, min(self.config.max_mana, mana))
        self._emit(ev.ManaChanged(color=color, mana=new, delta=new - team.mana, reason="practice"))
        team.mana = new
        team.ult_used = False
        return self.take_events()

    # ================================================================ internals
    def _emit(self, e: ev._Event) -> None:
        self._events.append(e)

    def _gain_mana(self, color: Color, amount: int, reason: str) -> None:
        team = self.teams[color]
        new = max(0, min(self.config.max_mana, team.mana + amount))
        if new != team.mana:
            delta = new - team.mana
            team.mana = new
            self._emit(ev.ManaChanged(color=color, mana=new, delta=delta, reason=reason))

    def _begin_turn(self) -> None:
        self.turn += 1
        self.phase = Phase.ROLL
        self.cast_this_turn = False
        self.sixes = 0
        color = self.current
        team = self.teams[color]
        # Shields last until the owner's next turn.
        for i, st in enumerate(team.statuses):
            if st.pop("shield", None) is not None:
                self._emit(ev.StatusChanged(color=color, piece=i, status="shield", active=False))
        # Collapsed bridges get rebuilt after a while.
        for nid in list(self.broken):
            self.broken[nid] -= 1
            if self.broken[nid] <= 0:
                del self.broken[nid]
                self.crumble[nid] = int(self.board.nodes[nid].hazard.get("uses", 3))
                self._emit(ev.TileChanged(tile=nid, effect="none"))
        # The owner's temporary tile effects wear off.
        for nid, fx in list(self.tile_fx.items()):
            if fx.owner == color:
                fx.turns -= 1
                if fx.turns <= 0:
                    del self.tile_fx[nid]
                    self._emit(ev.TileChanged(tile=nid, effect="none"))
        self._emit(ev.TurnStarted(color=color, turn=self.turn))
        self._gain_mana(color, self.config.mana_per_turn, "turn")
        # Currents carry pieces along before the player acts.
        for i in range(len(team.pieces)):
            node = self.node_of(color, i)
            if node is not None and node.hazard.get("type") == "current" and not self.is_finished(color, i):
                p = team.pieces[i]
                new = min(p + int(node.hazard.get("steps", 1)), self.board.finish(color) - 1)
                if new != p:
                    lane = self.board.lane_after(color, p, team.lanes[i], new, None)
                    self._place(color, i, new, lane)
                    self._emit(ev.Drifted(color=color, piece=i, start=p, end=new, lane=lane))
                    self._land(color, i, "drift", 1)
        if self.is_over:
            return

    def _end_turn(self) -> None:
        color = self.current
        # Roots wear off after the rooted team has sat out a turn.
        for i, st in enumerate(self.teams[color].statuses):
            if "rooted" in st:
                st["rooted"] -= 1
                if st["rooted"] <= 0:
                    del st["rooted"]
                    self._emit(ev.StatusChanged(color=color, piece=i, status="rooted", active=False))
        idx = self.order.index(color)
        for step in range(1, len(self.order) + 1):
            nxt = self.order[(idx + step) % len(self.order)]
            if nxt not in self.ranking:
                self.current = nxt
                break
        self._begin_turn()

    def _place(self, color: Color, piece: int, progress: int, lane: int) -> None:
        self.teams[color].pieces[piece] = progress
        self.teams[color].lanes[piece] = lane if self.board.is_fork(color, progress) else 0

    def _send_to_camp(self, color: Color, piece: int) -> None:
        self._place(color, piece, CAMP, 0)
        for status in list(self.teams[color].statuses[piece]):
            del self.teams[color].statuses[piece][status]
            self._emit(ev.StatusChanged(color=color, piece=piece, status=status, active=False))

    def _move(self, piece: int, lane: int | None) -> None:
        color, roll = self.current, self.last_roll or 0
        team = self.teams[color]
        start, start_lane = team.pieces[piece], team.lanes[piece]
        end = self.target(color, piece, roll)
        assert end is not None
        final_lane = self.board.lane_after(color, start, start_lane, end, lane)
        self._place(color, piece, end, final_lane)
        path = [0] if start == CAMP else list(range(start + 1, end + 1))
        self._emit(ev.Moved(color=color, piece=piece, start=start, end=end, lane=final_lane, path=path))
        fell_before = team.pieces[piece]
        captured = self._land(color, piece, "move")
        if self.is_over:
            return
        finished_piece, finished_player = self._check_finish(color, piece)
        if self.is_over:
            return
        fell = team.pieces[piece] == CAMP and fell_before != CAMP
        if not finished_player and (roll == 6 or (captured and not fell) or finished_piece):
            self.phase = Phase.ROLL
        else:
            self._end_turn()

    def capture_at(self, color: Color, piece: int) -> bool:
        """The mover knocks out every unprotected enemy on its tile."""
        node = self.node_of(color, piece)
        if node is None or self.board.is_immune(node) or self.hazard_of(node) == "pit":
            return False
        captured = False
        for vc, vi in self.pieces_on(node.id, exclude=color):
            if "shield" in self.teams[vc].statuses[vi]:
                self._emit(ev.Blocked(color=vc, piece=vi, reason="shield"))
                continue
            at = self.teams[vc].pieces[vi]
            self._send_to_camp(vc, vi)
            self._emit(ev.Captured(color=vc, piece=vi, byColor=color, byPiece=piece, at=at))
            self._gain_mana(vc, self.config.mana_knocked_out, "knockedOut")
            captured = True
            if HEROES[self.teams[color].hero].passive == "bushido":
                self._gain_mana(color, self.config.mana_bushido, "passive")
        return captured

    def _land(self, color: Color, piece: int, cause: Cause, depth: int = 0) -> bool:
        """A piece arrived on a tile: captures (for moves/dashes), then the tile's effect."""
        captured = self.capture_at(color, piece) if cause in ("move", "dash") else False
        self._arrive(color, piece, cause, depth)
        return captured

    def _arrive(self, color: Color, piece: int, cause: Cause, depth: int) -> None:
        node = self.node_of(color, piece)
        if node is None or self.is_finished(color, piece):
            return
        team = self.teams[color]
        p, lane = team.pieces[piece], team.lanes[piece]

        if node.hazard.get("type") == "crumble" and node.id not in self.broken:
            self.crumble[node.id] -= 1
            if self.crumble[node.id] <= 0:
                self.broken[node.id] = self.config.bridge_rebuild_turns
                self._emit(ev.TileChanged(tile=node.id, effect="broken", turns=self.config.bridge_rebuild_turns))

        effect = self.hazard_of(node)
        if effect == "pit":
            if "shield" in team.statuses[piece]:
                self._emit(ev.Blocked(color=color, piece=piece, reason="shield"))
                return
            self._emit(ev.Fell(color=color, piece=piece, at=p, tile=node.id))
            self._send_to_camp(color, piece)
            self._gain_mana(color, self.config.mana_knocked_out, "knockedOut")
            return
        if effect == "slide" and cause != "slide" and depth < self.config.max_chain:
            new = max(0, min(p + int(node.hazard.get("steps", 2)), self.board.finish(color) - 1))
            if new != p:
                new_lane = self.board.lane_after(color, p, lane, new, None)
                self._place(color, piece, new, new_lane)
                self._emit(ev.Slid(color=color, piece=piece, start=p, end=new, lane=new_lane))
                self._land(color, piece, "slide", depth + 1)
                return
        if effect == "portal" and cause != "portal" and depth < self.config.max_chain:
            loc = self.board.locate(color, node.hazard["to"])
            # Portals only ever carry you forward along your own route.
            if loc is not None and p < loc[0] < self.board.finish(color):
                self._place(color, piece, loc[0], loc[1])
                self._emit(ev.Portaled(color=color, piece=piece, start=p, end=loc[0], lane=loc[1]))
                self._land(color, piece, "portal", depth + 1)
                return
        fx = self.tile_fx.get(node.id)
        if fx and fx.kind == "trap" and fx.owner != color:
            del self.tile_fx[node.id]
            self._emit(ev.TileChanged(tile=node.id, effect="none"))
            if "shield" in team.statuses[piece]:
                self._emit(ev.Blocked(color=color, piece=piece, reason="shield"))
            else:
                team.statuses[piece]["rooted"] = 1
                self._emit(ev.StatusChanged(color=color, piece=piece, status="rooted", active=True))
                self.knock_back(color, piece, 2, fx.owner, "snare_trap", depth=depth + 1)
            return
        if fx and fx.kind == "fire" and fx.owner != color:
            self._gain_mana(color, -self.config.mana_burn, "burned")
        if node.kind == "shrine":
            self._gain_mana(color, self.config.mana_shrine, "shrine")

    def _check_finish(self, color: Color, piece: int) -> tuple[bool, bool]:
        """Handle a piece reaching the goal. Returns (piece_finished, player_finished)."""
        if self.teams[color].pieces[piece] < self.board.finish(color):
            return False, False
        self._emit(ev.PieceFinished(color=color, piece=piece))
        finished_player = False
        if self.has_finished(color) and color not in self.ranking:
            self.ranking.append(color)
            self._emit(ev.PlayerFinished(color=color, place=len(self.ranking)))
            finished_player = True
        remaining = [c for c in self.order if c not in self.ranking]
        if len(remaining) <= 1:
            self.ranking.extend(remaining)
            self.phase = Phase.OVER
            self._emit(ev.GameOver(ranking=list(self.ranking)))
        return True, finished_player

    def knock_back(self, color: Color, piece: int, amount: int, by: Color, ability: str, *, depth: int = 0) -> None:
        team = self.teams[color]
        p, lane = team.pieces[piece], team.lanes[piece]
        node = self.board.node(color, p, lane)
        if node is None or self.board.is_immune(node):
            self._emit(ev.Blocked(color=color, piece=piece, reason="safeTile"))
            return
        if "shield" in team.statuses[piece]:
            self._emit(ev.Blocked(color=color, piece=piece, reason="shield"))
            return
        new = max(0, p - amount)  # never past the start tile
        new_lane = self.board.lane_after(color, p, lane, new, None)
        self._place(color, piece, new, new_lane)
        self._emit(
            ev.KnockedBack(color=color, piece=piece, start=p, end=new, lane=new_lane, byColor=by, ability=ability)
        )
        self._gain_mana(color, self.config.mana_knocked_back, "knockedBack")
        self._land(color, piece, "knockback", depth + 1)

    # ================================================================ views
    def snapshot(self, *, with_targets: bool = True) -> dict:
        return {
            "mapId": self.board.id,
            "turnOrder": [c.value for c in self.order],
            "current": self.current.value,
            "phase": self.phase.value,
            "turn": self.turn,
            "lastRoll": self.last_roll,
            "legalPieces": self.legal_pieces(),
            "moveOptions": [{"piece": o.piece, "lane": o.lane, "to": o.to} for o in self.move_options()],
            "castUsed": self.cast_this_turn,
            "castTargets": self.cast_targets() if with_targets and not self.is_over else {},
            "ranking": [c.value for c in self.ranking],
            "tiles": {
                **{nid: {"effect": "broken", "turns": t, "owner": None} for nid, t in sorted(self.broken.items())},
                **{
                    nid: {"effect": fx.kind, "turns": fx.turns, "owner": fx.owner.value}
                    for nid, fx in sorted(self.tile_fx.items())
                },
            },
            "teams": {
                c.value: {
                    "hero": t.hero,
                    "pieces": list(t.pieces),
                    "lanes": list(t.lanes),
                    "mana": t.mana,
                    "maxMana": self.config.max_mana,
                    "finish": self.board.finish(c),
                    "ultUsed": t.ult_used,
                    "statuses": [sorted(st) for st in t.statuses],
                }
                for c, t in self.teams.items()
            },
        }
