"""Greedy AI used for bot players and for idle humans."""

from __future__ import annotations

from dataclasses import dataclass

from .board import CAMP, Color, Node
from .heroes import ABILITIES, HEROES
from .rules import _HANDLERS, Match, Phase, RuleError

BOT_NAMES = ["Robo Rex", "Dicey Diana", "Bolt", "Captain Six", "Pixel Pete", "Lady Luck"]


@dataclass
class BotAction:
    kind: str  # "cast" | "roll" | "move"
    ability: str | None = None
    target: dict | None = None
    piece: int | None = None


def _threatened(match: Match, color: Color, node: Node | None) -> bool:
    """An enemy sits 1-6 steps behind this tile on the shared loop."""
    if node is None or match.board.is_immune(node) or node.loop_index is None:
        return False
    for c, team in match.teams.items():
        if c == color:
            continue
        for p in team.pieces:
            n = match.board.node(c, p)
            if n is None or n.loop_index is None:
                continue
            d = (node.loop_index - n.loop_index) % match.board.loop_length
            if 1 <= d <= 6:
                return True
    return False


def score_move(match: Match, piece: int) -> float:
    color = match.current
    roll = match.last_roll or 0
    start = match.teams[color].pieces[piece]
    end = match.target(color, piece, roll)
    if end is None:
        return float("-inf")
    finish = match.board.finish(color)
    score = end / 10
    node = match.board.node(color, end)
    if end == finish:
        score += 80
    elif node is not None and node.loop_index is None:
        score += 40  # safe in the home path
    if start == CAMP:
        score += 60
    if node is not None:
        if not match.board.is_immune(node) and match._pieces_on(node.id, exclude=color):
            score += 100
        if match.board.is_immune(node):
            score += 15
        if node.kind == "shrine":
            score += 12
        if _threatened(match, color, node):
            score -= 30
    if _threatened(match, color, match.board.node(color, start)):
        score += 25
    return score


def _best_cast(match: Match) -> BotAction | None:
    color = match.current
    team = match.teams[color]
    best: tuple[float, BotAction] | None = None

    def consider(score: float, action: BotAction) -> None:
        nonlocal best
        if score > 0 and (best is None or score > best[0]):
            best = (score, action)

    for aid in HEROES[team.hero].abilities:
        if not match.can_cast(aid):
            continue
        ability = ABILITIES[aid]
        if ability.targeting == "ownPiece" and "knockback" in ability.params:
            for i, p in enumerate(team.pieces):
                node = match.board.node(color, p)
                if node is None or node.loop_index is None:
                    continue
                route = match.board.routes[color]
                value = 0.0
                for k in range(1, ability.params["reach"] + 1):
                    if p + k >= len(route):
                        break
                    tile = match.board.nodes[route[p + k]]
                    if tile.loop_index is None:
                        break
                    if not match.board.is_immune(tile):
                        for vc, vi in match._pieces_on(tile.id, exclude=color):
                            value += 20 + match.teams[vc].pieces[vi]
                consider(value, BotAction("cast", aid, {"piece": i}))
        elif ability.targeting == "enemyPiece":
            for c, other in match.teams.items():
                if c == color:
                    continue
                for i, p in enumerate(other.pieces):
                    node = match.board.node(c, p)
                    if node is None or node.loop_index is None or match.board.is_immune(node):
                        continue
                    try:
                        # Handlers validate without applying anything.
                        _HANDLERS[aid](match, ability, color, {"color": c.value, "piece": i})
                    except RuleError:
                        continue
                    consider(15 + p, BotAction("cast", aid, {"color": c.value, "piece": i}))
        elif ability.targeting == "ownPieceSteps":
            finish = match.board.finish(color)
            for i, p in enumerate(team.pieces):
                if p == CAMP or p >= finish:
                    continue
                for steps in range(ability.params["maxSteps"], 0, -1):
                    if p + steps > finish:
                        continue
                    node = match.board.node(color, p + steps)
                    value = 0.0
                    if p + steps == finish:
                        value = 60
                    elif _threatened(match, color, match.board.node(color, p)) and not _threatened(match, color, node):
                        value = 25
                    if team.mana >= match.config.max_mana:
                        value += 5  # don't waste mana at the cap
                    consider(value, BotAction("cast", aid, {"piece": i, "steps": steps}))
                    break
    return best[1] if best else None


def choose_action(match: Match) -> BotAction:
    if match.phase == Phase.ROLL:
        cast = _best_cast(match)
        return cast or BotAction("roll")
    if match.phase == Phase.MOVE:
        legal = match.legal_pieces()
        if not legal:
            raise RuleError("No legal moves")
        return BotAction("move", piece=max(legal, key=lambda i: score_move(match, i)))
    raise RuleError("Game over")
