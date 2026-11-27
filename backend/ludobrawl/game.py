"""Pure Ludo rules engine. No I/O, no randomness: dice values are passed in.

Board model
-----------
* The shared track has 52 squares, numbered clockwise. Each colour enters the
  track on its own start square (``START_SQUARE``).
* A piece's position is stored as *progress* relative to its own colour:
    -1        in the yard (not yet in play)
    0 .. 50   on the shared track (0 = own start square)
    51 .. 55  in the colour's private home column
    56        finished (reached the centre)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

TRACK_LENGTH = 52
PIECES_PER_PLAYER = 4
YARD = -1
LAST_TRACK_PROGRESS = 50
FINISH = 56
MAX_SIXES = 3


class Color(str, Enum):
    RED = "red"
    GREEN = "green"
    YELLOW = "yellow"
    BLUE = "blue"


# Clockwise seating order around the board.
CLOCKWISE: tuple[Color, ...] = (Color.RED, Color.GREEN, Color.YELLOW, Color.BLUE)

START_SQUARE: dict[Color, int] = {
    Color.RED: 0,
    Color.GREEN: 13,
    Color.YELLOW: 26,
    Color.BLUE: 39,
}

# Start squares plus the "star" square eight steps after each start.
SAFE_SQUARES: frozenset[int] = frozenset(
    {s for s in START_SQUARE.values()} | {(s + 8) % TRACK_LENGTH for s in START_SQUARE.values()}
)


class Phase(str, Enum):
    ROLL = "roll"
    MOVE = "move"
    OVER = "over"


class RuleError(Exception):
    """Raised when an action breaks the rules (wrong phase, illegal move...)."""


def absolute_square(color: Color, progress: int) -> int | None:
    """Shared-track square for a piece, or None if it is in the yard/home column."""
    if 0 <= progress <= LAST_TRACK_PROGRESS:
        return (START_SQUARE[color] + progress) % TRACK_LENGTH
    return None


def target_progress(progress: int, roll: int) -> int | None:
    """Where a piece would land with ``roll``, or None if that move is illegal."""
    if progress == FINISH:
        return None
    if progress == YARD:
        return 0 if roll == 6 else None
    target = progress + roll
    return target if target <= FINISH else None


@dataclass
class Capture:
    color: Color
    piece: int


@dataclass
class MoveResult:
    color: Color
    piece: int
    start: int
    end: int
    captures: list[Capture] = field(default_factory=list)
    finished_piece: bool = False
    finished_player: bool = False
    extra_turn: bool = False


@dataclass
class RollResult:
    color: Color
    value: int
    legal_pieces: list[int]
    forfeited: bool = False  # third six in a row
    passed: bool = False  # no legal move, turn passed on
    auto_move: MoveResult | None = None


class LudoGame:
    def __init__(self, colors: list[Color]):
        if not 2 <= len(colors) <= 4 or len(set(colors)) != len(colors):
            raise RuleError("A game needs 2-4 distinct colours.")
        self.turn_order: list[Color] = [c for c in CLOCKWISE if c in colors]
        self.pieces: dict[Color, list[int]] = {c: [YARD] * PIECES_PER_PLAYER for c in self.turn_order}
        self.current: Color = self.turn_order[0]
        self.phase: Phase = Phase.ROLL
        self.last_roll: int | None = None
        self.sixes_in_row = 0
        self.ranking: list[Color] = []
        self.last_move: MoveResult | None = None

    # ------------------------------------------------------------------ queries
    @property
    def is_over(self) -> bool:
        return self.phase == Phase.OVER

    def legal_pieces(self) -> list[int]:
        if self.phase != Phase.MOVE or self.last_roll is None:
            return []
        return [
            i
            for i, p in enumerate(self.pieces[self.current])
            if target_progress(p, self.last_roll) is not None
        ]

    def has_finished(self, color: Color) -> bool:
        return all(p == FINISH for p in self.pieces[color])

    # ------------------------------------------------------------------ actions
    def roll(self, value: int, *, auto_move: bool = True) -> RollResult:
        if self.phase != Phase.ROLL:
            raise RuleError("You can't roll right now.")
        if not 1 <= value <= 6:
            raise RuleError("Dice value must be 1-6.")

        color = self.current
        self.last_roll = value
        self.last_move = None
        self.sixes_in_row = self.sixes_in_row + 1 if value == 6 else 0

        if self.sixes_in_row >= MAX_SIXES:
            self._advance_turn()
            return RollResult(color, value, [], forfeited=True)

        self.phase = Phase.MOVE
        legal = self.legal_pieces()
        if not legal:
            self._advance_turn()
            return RollResult(color, value, [], passed=True)

        result = RollResult(color, value, legal)
        # If every legal move is equivalent (e.g. one piece, or all pieces in
        # the yard), there is no real choice: play it for the player.
        if auto_move and len({self.pieces[color][i] for i in legal}) == 1:
            result.auto_move = self.move(legal[0])
        return result

    def move(self, piece: int) -> MoveResult:
        if self.phase != Phase.MOVE or self.last_roll is None:
            raise RuleError("Roll the dice first.")
        if piece not in self.legal_pieces():
            raise RuleError("That piece can't move with this roll.")

        color, roll = self.current, self.last_roll
        start = self.pieces[color][piece]
        end = target_progress(start, roll)
        assert end is not None
        self.pieces[color][piece] = end
        result = MoveResult(color, piece, start, end)

        square = absolute_square(color, end)
        if square is not None and square not in SAFE_SQUARES:
            for other, positions in self.pieces.items():
                if other == color:
                    continue
                for i, p in enumerate(positions):
                    if absolute_square(other, p) == square:
                        positions[i] = YARD
                        result.captures.append(Capture(other, i))

        if end == FINISH:
            result.finished_piece = True
            if self.has_finished(color):
                result.finished_player = True
                self.ranking.append(color)

        remaining = [c for c in self.turn_order if c not in self.ranking]
        if len(remaining) <= 1:
            self.ranking.extend(remaining)
            self.phase = Phase.OVER
            self.last_move = result
            return result

        result.extra_turn = not result.finished_player and (
            roll == 6 or bool(result.captures) or result.finished_piece
        )
        if result.extra_turn:
            self.phase = Phase.ROLL
        else:
            self._advance_turn()
        self.last_move = result
        return result

    def _advance_turn(self) -> None:
        self.sixes_in_row = 0
        idx = self.turn_order.index(self.current)
        for step in range(1, len(self.turn_order) + 1):
            candidate = self.turn_order[(idx + step) % len(self.turn_order)]
            if candidate not in self.ranking:
                self.current = candidate
                break
        self.phase = Phase.ROLL
