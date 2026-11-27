"""The match rules engine: a pure state machine that emits domain events.

No I/O and no hidden randomness: dice values come from the caller (who uses
the match's seeded RNG), so matches are reproducible and easy to test.

Turn flow:
    ROLL  - the player may cast one ability, then rolls
    MOVE  - the player may still cast (if they haven't), then moves a piece
A roll of 6, a capture or getting a piece home grants another roll in the
same turn. Only one ability may be cast per turn.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import StrEnum

from . import events as ev
from .board import CAMP, Board, Color, Node
from .heroes import ABILITIES, HEROES


class RuleError(Exception):
    """An action that breaks the rules (wrong phase, illegal target...)."""


class Phase(StrEnum):
    ROLL = "roll"
    MOVE = "move"
    OVER = "over"


@dataclass(frozen=True)
class RuleConfig:
    max_mana: int = 5
    starting_mana: int = 0
    mana_per_turn: int = 1
    mana_rolled_one: int = 1
    mana_knocked_out: int = 2
    mana_knocked_back: int = 1
    mana_shrine: int = 2
    mana_bushido: int = 1
    max_sixes: int = 3


@dataclass
class Team:
    color: Color
    hero: str
    pieces: list[int]
    mana: int = 0
    statuses: list[dict[str, int]] = field(default_factory=list)  # per piece: {"shield": 1, "rooted": n}


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
            c: Team(c, heroes[c], [CAMP] * n, self.config.starting_mana, [{} for _ in range(n)]) for c in order
        }
        self.order = order
        self.current: Color = order[0]
        self.phase = Phase.ROLL
        self.turn = 0
        self.last_roll: int | None = None
        self.sixes = 0
        self.cast_this_turn = False
        self.ranking: list[Color] = []
        self._events: list[ev._Event] = []
        self._begin_turn()

    # ================================================================ queries
    @property
    def is_over(self) -> bool:
        return self.phase == Phase.OVER

    def take_events(self) -> list[ev._Event]:
        out, self._events = self._events, []
        return out

    def team(self, color: Color) -> Team:
        return self.teams[color]

    def node_of(self, color: Color, piece: int) -> Node | None:
        return self.board.node(color, self.teams[color].pieces[piece])

    def target(self, color: Color, piece: int, roll: int) -> int | None:
        p = self.teams[color].pieces[piece]
        finish = self.board.finish(color)
        if p >= finish:
            return None
        if p == CAMP:
            return 0 if roll == 6 else None
        t = p + roll
        return t if t <= finish else None

    def legal_pieces(self) -> list[int]:
        if self.phase != Phase.MOVE or self.last_roll is None:
            return []
        team = self.teams[self.current]
        return [
            i
            for i in range(len(team.pieces))
            if "rooted" not in team.statuses[i] and self.target(self.current, i, self.last_roll) is not None
        ]

    def can_cast(self, ability_id: str) -> bool:
        team = self.teams[self.current]
        ability = ABILITIES.get(ability_id)
        return (
            self.phase in (Phase.ROLL, Phase.MOVE)
            and not self.cast_this_turn
            and ability is not None
            and ability_id in HEROES[team.hero].abilities
            and team.mana >= ability.cost
        )

    def has_finished(self, color: Color) -> bool:
        finish = self.board.finish(color)
        return all(p >= finish for p in self.teams[color].pieces)

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
        legal = self.legal_pieces()
        if not legal:
            self._emit(ev.TurnPassed(color=color, reason="noMoves"))
            self._end_turn()
            return self.take_events()

        pieces = self.teams[color].pieces
        if auto_move and len({pieces[i] for i in legal}) == 1:
            self._move(legal[0])
        return self.take_events()

    def move(self, piece: int) -> list[ev._Event]:
        if self.phase != Phase.MOVE or self.last_roll is None:
            raise RuleError("Roll the dice first.")
        if piece not in self.legal_pieces():
            raise RuleError("That piece can't move with this roll.")
        self._move(piece)
        return self.take_events()

    def cast(self, ability_id: str, target: dict) -> list[ev._Event]:
        color = self.current
        team = self.teams[color]
        ability = ABILITIES.get(ability_id)
        if ability is None or ability_id not in HEROES[team.hero].abilities:
            raise RuleError("Your hero doesn't have that ability.")
        if self.phase not in (Phase.ROLL, Phase.MOVE):
            raise RuleError("You can't cast right now.")
        if self.cast_this_turn:
            raise RuleError("You already cast an ability this turn.")
        if team.mana < ability.cost:
            raise RuleError("Not enough mana.")

        handler = _HANDLERS[ability_id]
        apply = handler(self, ability, color, target)  # validates; raises RuleError
        self.cast_this_turn = True
        team.mana -= ability.cost
        spent = ev.ManaChanged(color=color, mana=team.mana, delta=-ability.cost, reason="cast")
        mark = len(self._events)
        apply()
        # Report the mana spend right after the AbilityCast event, before its effects.
        self._events.insert(mark + 1, spent)

        if self.phase == Phase.MOVE and not self.is_over and not self.legal_pieces():
            self._emit(ev.TurnPassed(color=color, reason="noMoves"))
            self._end_turn()
        return self.take_events()

    # ================================================================ internals
    def _emit(self, e: ev._Event) -> None:
        self._events.append(e)

    def _gain_mana(self, color: Color, amount: int, reason: str) -> None:
        team = self.teams[color]
        new = min(self.config.max_mana, team.mana + amount)
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
        self._emit(ev.TurnStarted(color=color, turn=self.turn))
        self._gain_mana(color, self.config.mana_per_turn, "turn")

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

    def _send_to_camp(self, color: Color, piece: int) -> None:
        self.teams[color].pieces[piece] = CAMP
        for status in list(self.teams[color].statuses[piece]):
            del self.teams[color].statuses[piece][status]
            self._emit(ev.StatusChanged(color=color, piece=piece, status=status, active=False))

    def _pieces_on(self, node_id: str, *, exclude: Color | None = None) -> list[tuple[Color, int]]:
        found = []
        for c, team in self.teams.items():
            if c == exclude:
                continue
            for i, p in enumerate(team.pieces):
                n = self.board.node(c, p)
                if n is not None and n.id == node_id and p < self.board.finish(c):
                    found.append((c, i))
        return found

    def _move(self, piece: int) -> None:
        color, roll = self.current, self.last_roll or 0
        team = self.teams[color]
        start = team.pieces[piece]
        end = self.target(color, piece, roll)
        assert end is not None
        team.pieces[piece] = end
        path = [0] if start == CAMP else list(range(start + 1, end + 1))
        self._emit(ev.Moved(color=color, piece=piece, start=start, end=end, path=path))

        node = self.board.node(color, end)
        captured = False
        if node is not None and not self.board.is_immune(node):
            for vc, vi in self._pieces_on(node.id, exclude=color):
                if "shield" in self.teams[vc].statuses[vi]:
                    self._emit(ev.Blocked(color=vc, piece=vi, reason="shield"))
                    continue
                at = self.teams[vc].pieces[vi]
                self._send_to_camp(vc, vi)
                self._emit(ev.Captured(color=vc, piece=vi, byColor=color, byPiece=piece, at=at))
                self._gain_mana(vc, self.config.mana_knocked_out, "knockedOut")
                captured = True
                if HEROES[team.hero].passive == "bushido":
                    self._gain_mana(color, self.config.mana_bushido, "passive")
        if node is not None and node.kind == "shrine":
            self._gain_mana(color, self.config.mana_shrine, "shrine")

        finished_piece, finished_player = self._check_finish(color, piece)
        if self.is_over:
            return
        if not finished_player and (roll == 6 or captured or finished_piece):
            self.phase = Phase.ROLL
        else:
            self._end_turn()

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

    def knock_back(self, color: Color, piece: int, amount: int, by: Color, ability: str) -> None:
        p = self.teams[color].pieces[piece]
        node = self.board.node(color, p)
        if node is None or self.board.is_immune(node):
            self._emit(ev.Blocked(color=color, piece=piece, reason="safeTile"))
            return
        if "shield" in self.teams[color].statuses[piece]:
            self._emit(ev.Blocked(color=color, piece=piece, reason="shield"))
            return
        new = max(0, p - amount)  # never past the start tile
        self.teams[color].pieces[piece] = new
        self._emit(ev.KnockedBack(color=color, piece=piece, start=p, end=new, byColor=by, ability=ability))
        self._gain_mana(color, self.config.mana_knocked_back, "knockedBack")

    # ================================================================ views
    def snapshot(self) -> dict:
        return {
            "mapId": self.board.id,
            "turnOrder": [c.value for c in self.order],
            "current": self.current.value,
            "phase": self.phase.value,
            "turn": self.turn,
            "lastRoll": self.last_roll,
            "legalPieces": self.legal_pieces(),
            "castUsed": self.cast_this_turn,
            "ranking": [c.value for c in self.ranking],
            "teams": {
                c.value: {
                    "hero": t.hero,
                    "pieces": list(t.pieces),
                    "mana": t.mana,
                    "maxMana": self.config.max_mana,
                    "finish": self.board.finish(c),
                    "statuses": [sorted(st) for st in t.statuses],
                }
                for c, t in self.teams.items()
            },
        }


# ==================================================================== abilities
# Each handler validates the target and returns a function that applies it.


def _own_piece_on_track(match: Match, color: Color, target: dict) -> tuple[int, int, Node]:
    piece = target.get("piece")
    team = match.teams[color]
    if not isinstance(piece, int) or not 0 <= piece < len(team.pieces):
        raise RuleError("Pick one of your pieces.")
    p = team.pieces[piece]
    node = match.board.node(color, p)
    if node is None or node.loop_index is None:
        raise RuleError("That piece must be out on the trail.")
    return piece, p, node


def _line(match: Match, ability, color: Color, target: dict):
    piece, p, _ = _own_piece_on_track(match, color, target)
    route = match.board.routes[color]
    reach = ability.params["reach"]
    tiles: list[str] = []
    for k in range(1, reach + 1):
        if p + k >= len(route):
            break
        node = match.board.nodes[route[p + k]]
        if node.loop_index is None:
            break  # the line stops at the home path
        tiles.append(node.id)

    def apply() -> None:
        match._emit(
            ev.AbilityCast(color=color, hero=match.teams[color].hero, ability=ability.id, piece=piece, tiles=tiles)
        )
        for nid in tiles:
            victims = match._pieces_on(nid, exclude=color)
            for vc, vi in victims:
                match.knock_back(vc, vi, ability.params["knockback"], color, ability.id)
            if victims and ability.params.get("firstOnly"):
                break

    return apply


def _enemy_in_range(match: Match, ability, color: Color, target: dict) -> tuple[Color, int, Node]:
    try:
        tc = Color(target.get("color"))
    except ValueError:
        raise RuleError("Pick an enemy piece.") from None
    tp = target.get("piece")
    if tc == color or tc not in match.teams or not isinstance(tp, int) or not 0 <= tp < len(match.teams[tc].pieces):
        raise RuleError("Pick an enemy piece.")
    node = match.node_of(tc, tp)
    if node is None or node.loop_index is None or match.teams[tc].pieces[tp] >= match.board.finish(tc):
        raise RuleError("That piece isn't on the trail.")
    if match.board.is_immune(node):
        raise RuleError("That piece is standing on a safe tile.")
    reach = ability.params["range"]
    mine = [match.node_of(color, i) for i in range(len(match.teams[color].pieces))]
    if not any(n is not None and (d := match.board.loop_distance(n, node)) is not None and d <= reach for n in mine):
        raise RuleError(f"Out of range: you need a piece within {reach} tiles.")
    return tc, tp, node


def _zap(match: Match, ability, color: Color, target: dict):
    tc, tp, node = _enemy_in_range(match, ability, color, target)

    def apply() -> None:
        match._emit(
            ev.AbilityCast(
                color=color,
                hero=match.teams[color].hero,
                ability=ability.id,
                targetColor=tc,
                targetPiece=tp,
                tiles=[node.id],
            )
        )
        match.knock_back(tc, tp, ability.params["knockback"], color, ability.id)

    return apply


def _roots(match: Match, ability, color: Color, target: dict):
    tc, tp, node = _enemy_in_range(match, ability, color, target)

    def apply() -> None:
        match._emit(
            ev.AbilityCast(
                color=color,
                hero=match.teams[color].hero,
                ability=ability.id,
                targetColor=tc,
                targetPiece=tp,
                tiles=[node.id],
            )
        )
        st = match.teams[tc].statuses[tp]
        if "shield" in st:
            match._emit(ev.Blocked(color=tc, piece=tp, reason="shield"))
            return
        st["rooted"] = ability.params["turns"]
        match._emit(ev.StatusChanged(color=tc, piece=tp, status="rooted", active=True))

    return apply


def _blink(match: Match, ability, color: Color, target: dict):
    piece = target.get("piece")
    steps = target.get("steps", ability.params["maxSteps"])
    team = match.teams[color]
    if not isinstance(piece, int) or not 0 <= piece < len(team.pieces):
        raise RuleError("Pick one of your pieces.")
    if not isinstance(steps, int) or not 1 <= steps <= ability.params["maxSteps"]:
        raise RuleError(f"Blink 1 to {ability.params['maxSteps']} tiles.")
    p = team.pieces[piece]
    finish = match.board.finish(color)
    if p == CAMP or p >= finish:
        raise RuleError("That piece must be out on the board.")
    if p + steps > finish:
        raise RuleError("That would overshoot the goal.")

    def apply() -> None:
        node_from = match.board.node(color, p)
        node_to = match.board.node(color, p + steps)
        match._emit(
            ev.AbilityCast(
                color=color,
                hero=team.hero,
                ability=ability.id,
                piece=piece,
                tiles=[n.id for n in (node_from, node_to) if n],
            )
        )
        team.pieces[piece] = p + steps
        match._emit(ev.Teleported(color=color, piece=piece, start=p, end=p + steps))
        if node_to is not None and node_to.kind == "shrine":
            match._gain_mana(color, match.config.mana_shrine, "shrine")
        match._check_finish(color, piece)

    return apply


def _shield(match: Match, ability, color: Color, target: dict):
    piece = target.get("piece")
    team = match.teams[color]
    if not isinstance(piece, int) or not 0 <= piece < len(team.pieces):
        raise RuleError("Pick one of your pieces.")
    if team.pieces[piece] == CAMP or team.pieces[piece] >= match.board.finish(color):
        raise RuleError("That piece must be out on the board.")

    def apply() -> None:
        match._emit(ev.AbilityCast(color=color, hero=team.hero, ability=ability.id, piece=piece))
        team.statuses[piece]["shield"] = 1
        match._emit(ev.StatusChanged(color=color, piece=piece, status="shield", active=True))

    return apply


_HANDLERS = {
    "katana_slash": _line,
    "fire_breath": _line,
    "piercing_arrow": _line,
    "zap": _zap,
    "entangling_roots": _roots,
    "blink": _blink,
    "shield_wall": _shield,
}
assert set(_HANDLERS) == set(ABILITIES), "every ability needs a handler"
