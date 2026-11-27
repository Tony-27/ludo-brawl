"""A simple, greedy bot used for computer players and for AFK humans."""

from __future__ import annotations

from .game import (
    FINISH,
    LAST_TRACK_PROGRESS,
    SAFE_SQUARES,
    YARD,
    LudoGame,
    absolute_square,
    target_progress,
)

BOT_NAMES = ["Robo Rex", "Dicey Diana", "Bolt", "Captain Six", "Pixel Pete", "Lady Luck"]


def _threatened(game: LudoGame, square: int) -> bool:
    """True if an opponent piece sits 1-6 squares behind ``square`` on the track."""
    if square in SAFE_SQUARES:
        return False
    for color, positions in game.pieces.items():
        if color == game.current:
            continue
        for p in positions:
            sq = absolute_square(color, p)
            if sq is None:
                continue
            distance = (square - sq) % 52
            # Opponents can't follow past their own home-column entrance.
            if 1 <= distance <= 6 and p + distance <= LAST_TRACK_PROGRESS:
                return True
    return False


def score_move(game: LudoGame, piece: int) -> float:
    color = game.current
    roll = game.last_roll or 0
    start = game.pieces[color][piece]
    end = target_progress(start, roll)
    if end is None:
        return float("-inf")

    score = end / 10  # mild preference for advancing pieces further along
    if end == FINISH:
        score += 80
    elif end > LAST_TRACK_PROGRESS:
        score += 40  # safe in the home column
    if start == YARD:
        score += 60

    end_sq = absolute_square(color, end)
    if end_sq is not None:
        if end_sq not in SAFE_SQUARES:
            for other, positions in game.pieces.items():
                if other != color and any(absolute_square(other, p) == end_sq for p in positions):
                    score += 100
        if end_sq in SAFE_SQUARES:
            score += 15
        if _threatened(game, end_sq):
            score -= 30

    start_sq = absolute_square(color, start)
    if start_sq is not None and _threatened(game, start_sq):
        score += 25  # escaping danger
    return score


def choose_piece(game: LudoGame) -> int:
    legal = game.legal_pieces()
    if not legal:
        raise ValueError("No legal moves")
    return max(legal, key=lambda i: score_move(game, i))
