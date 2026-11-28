"""The match rules engine: a pure state machine that emits domain events.

No I/O and no hidden randomness: dice values come from the caller (who uses
the match's seeded RNG), so matches are reproducible and easy to test.

Turn flow:
    ROLL  - the player may cast one ability, then rolls
    MOVE  - the player may still cast (if they haven't), then moves a piece
    ACT   - after the move: a last chance to cast, or end the turn
A roll of 6, a capture or getting a piece home grants another roll in the
same turn. Only one ability may be cast per turn; ultimates once per match.

The *arrival rule*: whenever a piece lands on a tile, by any means (move,
dash, knockback, swap, slide, portal...), the tile applies to it. That is
what lets spells push enemies into pits.

Maps can also have *timed events* that fire at the start of a round (a round
ends when every player has had a turn): eruptions and avalanches are
announced one round ahead, frozen lakes thaw and freeze, conveyors flip.
"""

from __future__ import annotations

import copy
import random
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal

from . import events as ev
from .board import CAMP, Board, Choices, Color, Node
from .heroes import ABILITIES, HEROES


class RuleError(Exception):
    """An action that breaks the rules (wrong phase, illegal target...)."""


class Phase(StrEnum):
    ROLL = "roll"
    MOVE = "move"
    ACT = "act"
    OVER = "over"


Cause = Literal["move", "dash", "knockback", "teleport", "swap", "slide", "portal", "drift", "rally", "event"]
BREAKABLE = ("crumble", "thin_ice")


@dataclass(frozen=True)
class RuleConfig:
    max_mana: int = 6
    starting_mana: int = 0
    mana_per_turn: int = 1
    mana_rolled_one: int = 1
    mana_knocked_out: int = 2
    mana_knocked_back: int = 1
    mana_shrine: int = 2
    mana_spring: int = 1
    mana_bushido: int = 1
    mana_burn: int = 1
    max_sixes: int = 3
    max_chain: int = 3  # slide/portal chain depth
    bridge_rebuild_turns: int = 8  # turns (all players) until a collapsed bridge is back
    empower_bonus: int = 2  # extra knockback for a spell cast after visiting an anvil


@dataclass
class Team:
    color: Color
    hero: str
    pieces: list[int]
    choices: list[Choices]
    mana: int = 0
    statuses: list[dict[str, int]] = field(default_factory=list)  # per piece: {"shield": 1, "rooted": n}
    ult_used: bool = False
    empowered: bool = False


@dataclass
class TileEffect:
    kind: Literal["crater", "fire", "trap"]
    turns: int  # counted in the owner's turns
    owner: Color


@dataclass(frozen=True)
class MoveOption:
    piece: int
    lane: int | None  # branch picked when the move enters a region, else None
    to: int
    choices: tuple = ()  # resulting branch choices (internal)


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
            c: Team(c, heroes[c], [CAMP] * n, [{} for _ in range(n)], self.config.starting_mana, [{} for _ in range(n)])
            for c in order
        }
        self.order = order
        self.current: Color = order[0]
        self.phase = Phase.ROLL
        self.turn = 0
        self.round = 1
        self.last_roll: int | None = None
        self.sixes = 0
        self.cast_this_turn = False
        self.ranking: list[Color] = []
        self.tile_fx: dict[str, TileEffect] = {}
        self.crumble: dict[str, int] = {
            nid: self._uses(n) for nid, n in board.nodes.items() if n.hazard.get("type") in BREAKABLE
        }
        self.broken: dict[str, int] = {}  # collapsed bridge / broken ice -> turns until restored
        self.warnings: dict[str, str] = {}  # tile -> map event about to strike it
        self.water: set[str] = set()  # thawed lake tiles
        self.closed: set[tuple[str, int]] = set()  # (region, branch) currently impassable
        self.conveyor = 1  # +1 forward, -1 backward
        self._events: list[ev._Event] = []
        self._round_start(initial=True)
        self._begin_turn()

    @staticmethod
    def _uses(node: Node) -> int:
        return int(node.hazard.get("uses", 2 if node.hazard.get("type") == "thin_ice" else 3))

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

    def path_of(self, color: Color, piece: int) -> list[str]:
        return self.board.path(color, self.teams[color].choices[piece])

    def finish_of(self, color: Color, piece: int) -> int:
        return self.board.finish(color, self.teams[color].choices[piece])

    def node_of(self, color: Color, piece: int) -> Node | None:
        team = self.teams[color]
        return self.board.node(color, team.pieces[piece], team.choices[piece])

    def is_finished(self, color: Color, piece: int) -> bool:
        return self.teams[color].pieces[piece] >= self.finish_of(color, piece)

    def remaining(self, color: Color, piece: int) -> int:
        """Steps still to walk (camp counts as the whole main route plus one)."""
        p = self.teams[color].pieces[piece]
        if p == CAMP:
            return self.board.finish(color) + 1
        return max(0, self.finish_of(color, piece) - p)

    def on_trail(self, color: Color, piece: int) -> bool:
        """Out of camp, not finished and on the shared loop (not the home path)."""
        node = self.node_of(color, piece)
        return node is not None and node.loop_index is not None and not self.is_finished(color, piece)

    def hazard_of(self, node: Node) -> str | None:
        """The effect a tile has on a piece that lands there right now."""
        fx = self.tile_fx.get(node.id)
        if node.id in self.broken or node.id in self.water or (fx and fx.kind == "crater"):
            return "pit"
        if node.hazard:
            kind = node.hazard["type"]
            return None if kind in BREAKABLE else kind
        return fx.kind if fx else None

    def branch_open(self, region: str, branch: int) -> bool:
        return (region, branch) not in self.closed

    def _options(self, color: Color, piece: int, steps: int) -> list[tuple[int, Choices, int | None]]:
        team = self.teams[color]
        p = team.pieces[piece]
        if p == CAMP:
            return [(0, {}, None)] if steps == 6 else []
        if p >= self.finish_of(color, piece):
            return []
        opts = self.board.forward_options(color, p, team.choices[piece], steps)
        out = []
        for to, ch, branch in opts:
            if branch is not None:
                region = next(r for r in ch if r not in team.choices[piece])
                if not self.branch_open(region, branch):
                    continue
            out.append((to, ch, branch))
        return out

    def _ahead(self, color: Color, piece: int, steps: int) -> tuple[int, Choices]:
        """Where a forced forward move (slide, drift, dash...) of up to `steps` ends: default branches."""
        team = self.teams[color]
        p, ch = team.pieces[piece], dict(team.choices[piece])
        for k in range(steps, 0, -1):
            opts = self.board.forward_options(color, p, ch, k)
            opts = [o for o in opts if o[2] is None or self.branch_open(self._new_region(ch, o[1]), o[2])]
            if opts:
                to, new, _ = opts[0]
                return to, new
        return p, ch

    @staticmethod
    def _new_region(old: Choices, new: Choices) -> str:
        return next((r for r in new if r not in old), "")

    def move_options(self) -> list[MoveOption]:
        if self.phase != Phase.MOVE or self.last_roll is None:
            return []
        color = self.current
        team = self.teams[color]
        options: list[MoveOption] = []
        for i in range(len(team.pieces)):
            if "rooted" in team.statuses[i]:
                continue
            for to, ch, branch in self._options(color, i, self.last_roll):
                options.append(MoveOption(i, branch, to, tuple(sorted(ch.items()))))
        return options

    def legal_pieces(self) -> list[int]:
        return sorted({o.piece for o in self.move_options()})

    def can_cast(self, ability_id: str) -> bool:
        team = self.teams[self.current]
        ability = ABILITIES.get(ability_id)
        return (
            self.phase in (Phase.ROLL, Phase.MOVE, Phase.ACT)
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
                preview = spells.preview(self, ability, self.current, target)
                valid.append({**target, "preview": preview} if preview else target)
            if valid:
                out[aid] = valid
        return out

    def has_finished(self, color: Color) -> bool:
        return all(self.is_finished(color, i) for i in range(len(self.teams[color].pieces)))

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

    def bonus(self, color: Color) -> int:
        return self.config.empower_bonus if self.teams[color].empowered else 0

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
            self._after_action()
            return self.take_events()

        team = self.teams[color]
        only_one = len({(team.pieces[o.piece], o.choices) for o in options}) == 1
        # Never move for the player while they could still cast a spell first.
        if auto_move and only_one and (self.cast_this_turn or not self.cast_targets()):
            self._move(options[0])
        return self.take_events()

    def move(self, piece: int, lane: int | None = None) -> list[ev._Event]:
        if self.phase != Phase.MOVE or self.last_roll is None:
            raise RuleError("Roll the dice first.")
        options = [o for o in self.move_options() if o.piece == piece]
        if not options:
            raise RuleError("That piece can't move with this roll.")
        chosen = next((o for o in options if o.lane == lane), options[0])
        self._move(chosen)
        return self.take_events()

    def end_turn(self) -> list[ev._Event]:
        if self.phase != Phase.ACT:
            raise RuleError("You can only end your turn after moving.")
        self._end_turn()
        return self.take_events()

    def cast(self, ability_id: str, target: dict) -> list[ev._Event]:
        from . import spells

        color = self.current
        team = self.teams[color]
        ability = ABILITIES.get(ability_id)
        if ability is None or ability_id not in HEROES[team.hero].abilities:
            raise RuleError("Your hero doesn't have that ability.")
        if self.phase not in (Phase.ROLL, Phase.MOVE, Phase.ACT):
            raise RuleError("You can't cast right now.")
        if self.cast_this_turn:
            raise RuleError("You already cast an ability this turn.")
        if ability.once_per_match and team.ult_used:
            raise RuleError("Ultimates can be used once per match.")
        if team.mana < ability.cost:
            raise RuleError("Not enough mana.")

        apply = spells.EFFECTS[ability.effect](self, ability, color, target)  # validates; raises RuleError
        phase = self.phase
        self.cast_this_turn = True
        if ability.once_per_match:
            team.ult_used = True
        team.mana -= ability.cost
        spent = ev.ManaChanged(color=color, mana=team.mana, delta=-ability.cost, reason="cast")
        mark = len(self._events)
        apply()
        # Report the mana spend right after the AbilityCast event, before its effects.
        self._events.insert(mark + 1, spent)
        if team.empowered:
            team.empowered = False
            self._emit(ev.Empowered(color=color, active=False))

        if not self.is_over and self.current == color:
            if phase == Phase.ACT and self.phase == Phase.ACT:
                self._end_turn()
            elif self.phase == Phase.MOVE and not self.move_options():
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
        self.last_roll = None
        self.sixes = 0
        color = self.current
        team = self.teams[color]
        # Shields last until the owner's next turn.
        for i, st in enumerate(team.statuses):
            if st.pop("shield", None) is not None:
                self._emit(ev.StatusChanged(color=color, piece=i, status="shield", active=False))
        # Collapsed bridges and broken ice get restored after a while.
        for nid in list(self.broken):
            self.broken[nid] -= 1
            if self.broken[nid] <= 0:
                del self.broken[nid]
                self.crumble[nid] = self._uses(self.board.nodes[nid])
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
                self._push(color, i, int(node.hazard.get("steps", 1)), "drift")
                if self.is_over:
                    return

    def _after_action(self) -> None:
        """The move is done and no extra roll: offer a last cast, or end the turn."""
        if not self.cast_this_turn and self.cast_targets():
            self.phase = Phase.ACT
        else:
            self._end_turn()

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
        nxt_idx = idx
        for step in range(1, len(self.order) + 1):
            k = (idx + step) % len(self.order)
            if self.order[k] not in self.ranking:
                nxt_idx = k
                break
        self.current = self.order[nxt_idx]
        if nxt_idx <= idx:
            self.round += 1
            self._round_start()
            if self.is_over:
                return
        self._begin_turn()

    # ---------------------------------------------------------------- map events
    def _round_start(self, *, initial: bool = False) -> None:
        r = self.round
        for e in self.board.events:
            kind = e["type"]
            tiles: list[str] = list(e.get("tiles", []))
            if kind in ("eruption", "avalanche"):
                every, offset = int(e.get("every", 3)), int(e.get("offset", 0)) % int(e.get("every", 3))
                if not initial and r % every == offset:
                    self._strike(kind, tiles, e)
                if (r + 1) % every == offset:
                    for t in tiles:
                        self.warnings[t] = kind
                    self._emit(ev.MapEvent(event=kind, stage="warning", tiles=tiles))
            elif kind == "freeze":
                frozen, thawed = (int(x) for x in e.get("cycle", (3, 2)))
                pos = (r - 1 + int(e.get("offset", 0))) % (frozen + thawed)
                key = (e["region"], int(e["branch"]))
                if pos < frozen:
                    if key in self.closed:
                        self.closed.discard(key)
                        self.water -= set(tiles)
                        self._emit(ev.MapEvent(event="freeze", stage="strike", tiles=tiles))
                    if pos == frozen - 1:
                        self._emit(ev.MapEvent(event="thaw", stage="warning", tiles=tiles))
                elif key not in self.closed:
                    self.closed.add(key)
                    self.water |= set(tiles)
                    self._emit(ev.MapEvent(event="thaw", stage="strike", tiles=tiles))
                    for t in tiles:
                        for c, i in self.pieces_on(t):
                            self._fall(c, i, t)
                            if self.is_over:
                                return
            elif kind == "conveyor":
                every = int(e.get("every", 1))
                direction = 1 if ((r - 1) // every) % 2 == 0 else -1
                if direction != self.conveyor or initial:
                    self.conveyor = direction
                    self._emit(ev.MapEvent(event="conveyor", stage="flip", tiles=tiles, value=direction))

    def _strike(self, kind: str, tiles: list[str], spec: dict) -> None:
        for t in tiles:
            self.warnings.pop(t, None)
        self._emit(ev.MapEvent(event=kind, stage="strike", tiles=tiles))
        for t in tiles:
            node = self.board.nodes[t]
            for c, i in self.pieces_on(t):
                if self.is_over:
                    return
                if "shield" in self.teams[c].statuses[i]:
                    self._emit(ev.Blocked(color=c, piece=i, reason="shield"))
                elif kind == "eruption" and "knockback" not in spec:
                    self._fall(c, i, t)
                else:
                    self.knock_back(c, i, int(spec.get("knockback", 4)), None, kind, depth=1)
            if kind == "eruption" and node.hazard.get("type") in BREAKABLE and t not in self.broken:
                self.broken[t] = self.config.bridge_rebuild_turns
                self._emit(ev.TileChanged(tile=t, effect="broken", turns=self.config.bridge_rebuild_turns))

    # ---------------------------------------------------------------- movement
    def _place(self, color: Color, piece: int, progress: int, choices: Choices) -> None:
        team = self.teams[color]
        team.pieces[piece] = progress
        team.choices[piece] = {} if progress == CAMP else self.board.trim(color, progress, choices)

    def _send_to_camp(self, color: Color, piece: int) -> None:
        self._place(color, piece, CAMP, {})
        for status in list(self.teams[color].statuses[piece]):
            del self.teams[color].statuses[piece][status]
            self._emit(ev.StatusChanged(color=color, piece=piece, status=status, active=False))

    def _tiles_between(self, color: Color, piece: int, start: int, end: int) -> list[str]:
        """Node ids walked from `start` (excluded) to `end` (included), either direction."""
        path = self.path_of(color, piece)
        if end >= start:
            return path[max(start, -1) + 1 : end + 1] or [path[end]]
        return list(reversed(path[end:start])) or [path[end]]

    def _move(self, option: MoveOption) -> None:
        color, roll, piece = self.current, self.last_roll or 0, option.piece
        team = self.teams[color]
        start = team.pieces[piece]
        self._place(color, piece, option.to, dict(option.choices))
        tiles = (
            self._tiles_between(color, piece, start, option.to) if start != CAMP else [self.path_of(color, piece)[0]]
        )
        self._emit(ev.Moved(color=color, piece=piece, start=start, end=option.to, path=tiles))
        captured = self._land(color, piece, "move")
        if self.is_over:
            return
        fell = team.pieces[piece] == CAMP
        finished_piece, finished_player = self._check_finish(color, piece)
        if self.is_over or self.current != color:
            return
        if not finished_player and (roll == 6 or (captured and not fell) or finished_piece):
            self.phase = Phase.ROLL
        else:
            self._after_action()

    def _push(self, color: Color, piece: int, steps: int, cause: Literal["slide", "drift"], depth: int = 0) -> bool:
        """Carry a piece forward (steps > 0) or back along its route. Returns whether it moved."""
        team = self.teams[color]
        p = team.pieces[piece]
        if steps > 0:
            new, ch = self._ahead(color, piece, min(steps, max(0, self.finish_of(color, piece) - 1 - p)))
        else:
            new, ch = max(0, p + steps), team.choices[piece]
        if new == p:
            return False
        self._place(color, piece, new, ch)
        tiles = self._tiles_between(color, piece, p, new)
        cls = ev.Slid if cause == "slide" else ev.Drifted
        self._emit(cls(color=color, piece=piece, start=p, end=new, path=tiles))
        self._land(color, piece, cause, depth + 1)
        return True

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
            if HEROES[self.teams[color].hero].passive in ("bushido", "bloodlust"):
                self._gain_mana(color, self.config.mana_bushido, "passive")
        return captured

    def _land(self, color: Color, piece: int, cause: Cause, depth: int = 0) -> bool:
        """A piece arrived on a tile: captures (for moves/dashes), then the tile's effect."""
        captured = self.capture_at(color, piece) if cause in ("move", "dash") else False
        self._arrive(color, piece, cause, depth)
        return captured

    def _fall(self, color: Color, piece: int, tile: str) -> None:
        team = self.teams[color]
        if "shield" in team.statuses[piece]:
            self._emit(ev.Blocked(color=color, piece=piece, reason="shield"))
            return
        self._emit(ev.Fell(color=color, piece=piece, at=team.pieces[piece], tile=tile))
        self._send_to_camp(color, piece)
        self._gain_mana(color, self.config.mana_knocked_out, "knockedOut")

    def _arrive(self, color: Color, piece: int, cause: Cause, depth: int) -> None:
        node = self.node_of(color, piece)
        if node is None or self.is_finished(color, piece):
            return
        team = self.teams[color]
        p = team.pieces[piece]
        kind = node.hazard.get("type")

        if kind in BREAKABLE and node.id not in self.broken:
            self.crumble[node.id] -= 1
            if self.crumble[node.id] <= 0:
                self.broken[node.id] = self.config.bridge_rebuild_turns
                self._emit(ev.TileChanged(tile=node.id, effect="broken", turns=self.config.bridge_rebuild_turns))
            elif self.crumble[node.id] == 1:
                self._emit(ev.TileChanged(tile=node.id, effect="cracked"))

        effect = self.hazard_of(node)
        chain_ok = depth < self.config.max_chain
        if effect == "pit":
            self._fall(color, piece, node.id)
            return
        if effect == "slide" and cause != "slide" and chain_ok:
            if self._push(color, piece, int(node.hazard.get("steps", 2)), "slide", depth):
                return
        if effect == "ice" and cause != "slide" and chain_ok:
            # Slide over the ice until reaching solid ground.
            path, k = self.path_of(color, piece), 1
            while p + k < len(path) - 1 and self.board.nodes[path[p + k]].hazard.get("type") == "ice":
                k += 1
            if self._push(color, piece, k, "slide", depth):
                return
        if effect == "conveyor" and cause not in ("slide", "drift") and chain_ok:
            if self._push(color, piece, int(node.hazard.get("steps", 2)) * self.conveyor, "drift", depth):
                return
        if effect == "portal" and cause != "portal" and chain_ok:
            loc = self.board.locate(color, node.hazard["to"], team.choices[piece])
            # Portals only ever carry you forward along your own route.
            if loc is not None and p < loc[0] < self.board.finish(color, loc[1]):
                self._place(color, piece, loc[0], loc[1])
                self._emit(ev.Portaled(color=color, piece=piece, start=p, end=loc[0], path=[node.hazard["to"]]))
                self._land(color, piece, "portal", depth + 1)
                return
        if effect == "spring":
            self._gain_mana(color, self.config.mana_spring, "spring")
            if "rooted" in team.statuses[piece]:
                del team.statuses[piece]["rooted"]
                self._emit(ev.StatusChanged(color=color, piece=piece, status="rooted", active=False))
        if effect == "anvil" and not team.empowered:
            team.empowered = True
            self._emit(ev.Empowered(color=color, active=True))
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
        if not self.is_finished(color, piece):
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

    def knock_back(
        self, color: Color, piece: int, amount: int, by: Color | None, ability: str, *, depth: int = 0
    ) -> None:
        team = self.teams[color]
        p = team.pieces[piece]
        node = self.node_of(color, piece)
        if node is None or self.board.is_immune(node):
            self._emit(ev.Blocked(color=color, piece=piece, reason="safeTile"))
            return
        if "shield" in team.statuses[piece]:
            self._emit(ev.Blocked(color=color, piece=piece, reason="shield"))
            return
        new = max(0, p - amount)  # never past the start tile
        tiles = self._tiles_between(color, piece, p, new)
        self._place(color, piece, new, team.choices[piece])
        self._emit(ev.KnockedBack(color=color, piece=piece, start=p, end=new, path=tiles, byColor=by, ability=ability))
        self._gain_mana(color, self.config.mana_knocked_back, "knockedBack")
        self._land(color, piece, "knockback", depth + 1)

    # ================================================================ views
    def route_info(self, color: Color, piece: int, choices: Choices) -> dict | None:
        """Describe the branch a move would enter (for the route preview)."""
        old = self.teams[color].choices[piece]
        rid = self._new_region(old, choices)
        if not rid:
            return None
        region = self.board.regions[rid]
        branch = region.branches[choices[rid]]
        return {
            "region": region.name,
            "name": branch.name,
            "tag": branch.tag,
            "length": len(branch.nodes),
            "shortest": min(len(b.nodes) for b in region.branches),
        }

    def snapshot(self, *, with_targets: bool = True) -> dict:
        options = []
        for o in self.move_options():
            team = self.teams[self.current]
            ch = dict(o.choices)
            path = self.board.path(self.current, ch)
            start = team.pieces[o.piece]
            tiles = [path[0]] if start == CAMP else path[start + 1 : o.to + 1]
            options.append(
                {
                    "piece": o.piece,
                    "lane": o.lane,
                    "to": o.to,
                    "tile": path[o.to],
                    "path": tiles,
                    "route": self.route_info(self.current, o.piece, ch),
                }
            )
        tiles: dict[str, dict] = {}
        for nid, _kind in sorted(self.warnings.items()):
            tiles[nid] = {"effect": "warning", "turns": None, "owner": None}
        for nid in sorted(self.water):
            tiles[nid] = {"effect": "water", "turns": None, "owner": None}
        for nid, left in sorted(self.crumble.items()):
            if left == 1 and nid not in self.broken:
                tiles[nid] = {"effect": "cracked", "turns": None, "owner": None}
        for nid, t in sorted(self.broken.items()):
            tiles[nid] = {"effect": "broken", "turns": t, "owner": None}
        for nid, fx in sorted(self.tile_fx.items()):
            tiles[nid] = {"effect": fx.kind, "turns": fx.turns, "owner": fx.owner.value}
        return {
            "mapId": self.board.id,
            "turnOrder": [c.value for c in self.order],
            "current": self.current.value,
            "phase": self.phase.value,
            "turn": self.turn,
            "round": self.round,
            "lastRoll": self.last_roll,
            "legalPieces": self.legal_pieces(),
            "moveOptions": options,
            "castUsed": self.cast_this_turn,
            "castTargets": self.cast_targets() if with_targets and not self.is_over else {},
            "ranking": [c.value for c in self.ranking],
            "tiles": tiles,
            "conveyor": self.conveyor,
            "teams": {
                c.value: {
                    "hero": t.hero,
                    "pieces": list(t.pieces),
                    "tiles": [
                        None if p == CAMP else self.board.node(c, p, t.choices[i]).id for i, p in enumerate(t.pieces)
                    ],  # type: ignore[union-attr]
                    "finished": [self.is_finished(c, i) for i in range(len(t.pieces))],
                    "remaining": [self.remaining(c, i) for i in range(len(t.pieces))],
                    "mana": t.mana,
                    "maxMana": self.config.max_mana,
                    "finish": self.board.finish(c),
                    "ultUsed": t.ult_used,
                    "empowered": t.empowered,
                    "statuses": [sorted(st) for st in t.statuses],
                }
                for c, t in self.teams.items()
            },
        }
