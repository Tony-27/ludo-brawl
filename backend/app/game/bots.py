"""Bot AI used for bot players and idle humans.

Bots are hero-agnostic: they try each legal move / spell on a copy of the
match and keep the one that improves their position the most. New heroes,
spells and map hazards therefore work for bots without extra code.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from .board import CAMP, Color
from .heroes import ABILITIES, HEROES
from .rules import Match, Phase, RuleError

BOT_NAMES = ["Robo Rex", "Dicey Diana", "Bolt", "Captain Six", "Pixel Pete", "Lady Luck"]


@dataclass
class BotAction:
    kind: str  # "cast" | "roll" | "move" | "end"
    ability: str | None = None
    target: dict | None = None
    piece: int | None = None
    lane: int | None = None


def _team_value(match: Match, color: Color) -> float:
    team = match.teams[color]
    full = match.board.finish(color)
    value = 0.0
    for i, p in enumerate(team.pieces):
        if p == CAMP:
            value -= 12
            continue
        if match.is_finished(color, i):
            value += 130
            continue
        value += 10 + 100 * (1 - match.remaining(color, i) / full)
        node = match.node_of(color, i)
        if node is not None and match.board.is_immune(node):
            value += 4
        elif node is not None and node.id in match.warnings:
            value -= 25  # an eruption / avalanche is about to hit this tile
        st = team.statuses[i]
        if "shield" in st:
            value += 3
        if "rooted" in st:
            value -= 4
    value += team.mana * 1.2 + (3 if team.empowered else 0)
    if color in match.ranking:
        value += 400 * (len(match.order) - match.ranking.index(color))
    return value


def evaluate(match: Match, color: Color) -> float:
    """How good the position is for `color`: own progress minus the strongest rival's."""
    mine = _team_value(match, color)
    rivals = [_team_value(match, c) for c in match.order if c != color]
    return mine - (max(rivals) * 0.6 + sum(rivals) / max(1, len(rivals)) * 0.4)


def _try(match: Match, fn) -> float | None:
    sim = match.clone()
    color = match.current
    try:
        fn(sim)
    except RuleError:
        return None
    return evaluate(sim, color)


def best_cast(match: Match) -> BotAction | None:
    color = match.current
    team = match.teams[color]
    base = evaluate(match, color)
    best: tuple[float, BotAction] | None = None
    for aid, targets in match.cast_targets().items():
        ability = ABILITIES[aid]
        # Mana has value; ultimates should be saved for a big swing.
        threshold = ability.cost * 0.9 + (2 if ability.once_per_match else 0)
        if team.mana >= match.config.max_mana:
            threshold -= 3  # don't waste mana at the cap
        for target in targets:
            score = _try(match, lambda m, a=aid, t=target: m.cast(a, t))
            if score is None:
                continue
            gain = score - base
            if gain > threshold and (best is None or gain > best[0]):
                best = (gain, BotAction("cast", aid, target))
    return best[1] if best else None


def best_move(match: Match, rng: random.Random | None = None) -> BotAction:
    options = match.move_options()
    if not options:
        raise RuleError("No legal moves")
    scored = []
    for o in options:
        score = _try(match, lambda m, o=o: m.move(o.piece, o.lane))
        scored.append(((score if score is not None else float("-inf")) + (rng.random() * 0.5 if rng else 0), o))
    _, o = max(scored, key=lambda s: s[0])
    return BotAction("move", piece=o.piece, lane=o.lane)


def choose_action(match: Match, rng: random.Random | None = None) -> BotAction:
    if match.phase == Phase.ROLL:
        return best_cast(match) or BotAction("roll")
    if match.phase == Phase.MOVE:
        return best_move(match, rng)
    if match.phase == Phase.ACT:
        return best_cast(match) or BotAction("end")
    raise RuleError("Game over")


__all__ = ["BOT_NAMES", "BotAction", "HEROES", "choose_action", "evaluate"]
