"""Ability effects. Each effect validates a target and returns a function that
applies it, so the same code serves casting, bots and the client's target list.

Effects are generic and parameterised by the ability's data (heroes.py):
several abilities share one effect with different numbers.
"""

from __future__ import annotations

from collections.abc import Callable

from . import events as ev
from .board import CAMP, Color, Node
from .heroes import Ability
from .rules import Match, RuleError, TileEffect

Apply = Callable[[], None]


# ==================================================================== helpers
def _own_piece(match: Match, color: Color, target: dict, *, trail: bool) -> int:
    piece = target.get("piece")
    team = match.teams[color]
    if not isinstance(piece, int) or not 0 <= piece < len(team.pieces):
        raise RuleError("Pick one of your pieces.")
    if trail and not match.on_trail(color, piece):
        raise RuleError("That piece must be out on the trail.")
    if not trail and (team.pieces[piece] == CAMP or match.is_finished(color, piece)):
        raise RuleError("That piece must be out on the board.")
    return piece


def _trail_nodes(match: Match, color: Color) -> list[tuple[int, Node]]:
    return [(i, match.node_of(color, i)) for i in range(len(match.teams[color].pieces)) if match.on_trail(color, i)]  # type: ignore[misc]


def _within(match: Match, color: Color, node: Node, reach: int, *, ahead_only: bool = False) -> bool:
    """Is `node` within `reach` tiles of any of `color`'s pieces on the trail?"""
    for _, mine in _trail_nodes(match, color):
        if ahead_only:
            d = (node.loop_index - mine.loop_index) % match.board.loop_length  # type: ignore[operator]
            if 1 <= d <= reach:
                return True
        else:
            d = match.board.loop_distance(mine, node)
            if d is not None and d <= reach:
                return True
    return False


def _enemies_in_reach(match: Match, color: Color, reach: int, ahead_only: bool) -> list[tuple[Color, int, Node]]:
    found = []
    for c, team in match.teams.items():
        if c == color:
            continue
        for i in range(len(team.pieces)):
            node = match.node_of(c, i)
            if node is None or node.loop_index is None or match.is_finished(c, i) or match.board.is_immune(node):
                continue
            if _within(match, color, node, reach, ahead_only=ahead_only):
                found.append((c, i, node))
    return found


def _enemy(match: Match, color: Color, target: dict, reach: int) -> tuple[Color, int, Node]:
    try:
        tc = Color(target.get("color"))
    except ValueError:
        raise RuleError("Pick an enemy piece.") from None
    tp = target.get("piece")
    if tc == color or tc not in match.teams or not isinstance(tp, int) or not 0 <= tp < len(match.teams[tc].pieces):
        raise RuleError("Pick an enemy piece.")
    node = match.node_of(tc, tp)
    if node is None or node.loop_index is None or match.is_finished(tc, tp):
        raise RuleError("That piece isn't on the trail.")
    if match.board.is_immune(node):
        raise RuleError("That piece is standing on a safe tile.")
    if not _within(match, color, node, reach):
        raise RuleError(f"Out of range: you need a piece within {reach} tiles.")
    return tc, tp, node


def _tiles_ahead(match: Match, color: Color, piece: int, reach: int) -> list[Node]:
    team = match.teams[color]
    p, lane = team.pieces[piece], team.lanes[piece]
    tiles = []
    for k in range(1, reach + 1):
        if p + k > match.board.finish(color):
            break
        node = match.board.node(color, p + k, match.board.lane_after(color, p, lane, p + k, None))
        if node is None or node.loop_index is None:
            break  # effects stop at the home path
        tiles.append(node)
    return tiles


def _cast(match: Match, ability: Ability, color: Color, **kw) -> None:
    match._emit(ev.AbilityCast(color=color, hero=match.teams[color].hero, ability=ability.id, **kw))


def _root(match: Match, c: Color, i: int, turns: int) -> None:
    st = match.teams[c].statuses[i]
    if "shield" in st:
        match._emit(ev.Blocked(color=c, piece=i, reason="shield"))
        return
    st["rooted"] = turns
    match._emit(ev.StatusChanged(color=c, piece=i, status="rooted", active=True))


def _advance(match: Match, color: Color, piece: int, steps: int, via: str) -> None:
    """Move a piece forward outside a roll (dash, rally). Captures only for dashes."""
    team = match.teams[color]
    p, lane = team.pieces[piece], team.lanes[piece]
    end = min(p + steps, match.board.finish(color))
    new_lane = match.board.lane_after(color, p, lane, end, None)
    match._place(color, piece, end, new_lane)
    match._emit(
        ev.Moved(color=color, piece=piece, start=p, end=end, lane=new_lane, path=list(range(p + 1, end + 1)), via=via)
    )
    match._land(color, piece, "dash" if via == "dash" else "rally")
    if not match.is_over:
        match._check_finish(color, piece)


# ==================================================================== effects
def dash(match: Match, ability: Ability, color: Color, target: dict) -> Apply:
    piece = _own_piece(match, color, target, trail=False)
    steps = int(ability.params["steps"])
    if "rooted" in match.teams[color].statuses[piece]:
        raise RuleError("That piece is rooted.")
    if match.teams[color].pieces[piece] + steps > match.board.finish(color):
        raise RuleError("That would overshoot the goal.")

    def apply() -> None:
        _cast(match, ability, color, piece=piece)
        _advance(match, color, piece, steps, "dash")

    return apply


def line(match: Match, ability: Ability, color: Color, target: dict) -> Apply:
    piece = _own_piece(match, color, target, trail=True)
    tiles = _tiles_ahead(match, color, piece, int(ability.params["reach"]))
    if not tiles:
        raise RuleError("Nothing ahead to hit.")

    def apply() -> None:
        _cast(match, ability, color, piece=piece, tiles=[n.id for n in tiles])
        for node in tiles:
            victims = [] if match.board.is_immune(node) else match.pieces_on(node.id, exclude=color)
            for vc, vi in victims:
                if "knockback" in ability.params:
                    match.knock_back(vc, vi, int(ability.params["knockback"]), color, ability.id)
            if victims and ability.params.get("firstOnly"):
                break
        burn = int(ability.params.get("burn", 0))
        if burn:
            for node in tiles:
                if not match.board.is_immune(node) and node.id not in match.tile_fx:
                    match.tile_fx[node.id] = TileEffect("fire", burn, color)
                    match._emit(ev.TileChanged(tile=node.id, effect="fire", turns=burn, owner=color))

    return apply


def radius(match: Match, ability: Ability, color: Color, target: dict) -> Apply:
    reach = int(ability.params["radius"])
    victims = _enemies_in_reach(match, color, reach, bool(ability.params.get("aheadOnly")))
    if not victims:
        raise RuleError("No enemies in reach.")

    def apply() -> None:
        _cast(match, ability, color, tiles=[n.id for _, _, n in victims])
        for vc, vi, _ in victims:
            if match.is_over:
                return
            if "root" in ability.params:
                _root(match, vc, vi, int(ability.params["root"]))
            if "knockback" in ability.params:
                match.knock_back(vc, vi, int(ability.params["knockback"]), color, ability.id)

    return apply


def strike(match: Match, ability: Ability, color: Color, target: dict) -> Apply:
    tc, tp, node = _enemy(match, color, target, int(ability.params["range"]))

    def apply() -> None:
        _cast(match, ability, color, targetColor=tc, targetPiece=tp, tiles=[node.id])
        if "root" in ability.params:
            _root(match, tc, tp, int(ability.params["root"]))
        if "knockback" in ability.params:
            match.knock_back(tc, tp, int(ability.params["knockback"]), color, ability.id)

    return apply


def blink(match: Match, ability: Ability, color: Color, target: dict) -> Apply:
    piece = _own_piece(match, color, target, trail=False)
    steps = target.get("steps", ability.params["maxSteps"])
    if not isinstance(steps, int) or not 1 <= steps <= ability.params["maxSteps"]:
        raise RuleError(f"Blink 1 to {ability.params['maxSteps']} tiles.")
    team = match.teams[color]
    p, lane = team.pieces[piece], team.lanes[piece]
    if p + steps > match.board.finish(color):
        raise RuleError("That would overshoot the goal.")

    def apply() -> None:
        end = p + steps
        new_lane = match.board.lane_after(color, p, lane, end, None)
        _cast(match, ability, color, piece=piece, tiles=[match.board.node(color, end, new_lane).id])  # type: ignore[union-attr]
        match._place(color, piece, end, new_lane)
        match._emit(ev.Teleported(color=color, piece=piece, start=p, end=end, lane=new_lane))
        match._land(color, piece, "teleport")
        if not match.is_over:
            match._check_finish(color, piece)

    return apply


def _tile(match: Match, color: Color, target: dict, reach: int) -> Node:
    node = match.board.nodes.get(str(target.get("node")))
    if node is None or node.loop_index is None:
        raise RuleError("Pick a tile on the trail.")
    if match.board.is_immune(node) or node.hazard:
        raise RuleError("That tile can't be targeted.")
    if not _within(match, color, node, reach):
        raise RuleError(f"Out of range: you need a piece within {reach} tiles.")
    return node


def meteor(match: Match, ability: Ability, color: Color, target: dict) -> Apply:
    node = _tile(match, color, target, int(ability.params["range"]))
    splash = int(ability.params.get("splash", 0))

    def apply() -> None:
        hit = [
            n
            for n in match.board.nodes.values()
            if n.loop_index is not None
            and match.board.loop_distance(n, node) is not None
            and match.board.loop_distance(n, node) <= splash  # type: ignore[operator]
        ]
        _cast(match, ability, color, tiles=[node.id] + [n.id for n in hit if n.id != node.id])
        for n in hit:
            if match.board.is_immune(n):
                continue
            for vc, vi in match.pieces_on(n.id, exclude=color):
                if match.is_over:
                    return
                match.knock_back(vc, vi, int(ability.params["knockback"]), color, ability.id)
        turns = int(ability.params["turns"])
        match.tile_fx[node.id] = TileEffect("crater", turns, color)
        match._emit(ev.TileChanged(tile=node.id, effect="crater", turns=turns, owner=color))

    return apply


def trap(match: Match, ability: Ability, color: Color, target: dict) -> Apply:
    node = _tile(match, color, target, int(ability.params["range"]))
    if node.id in match.tile_fx:
        raise RuleError("Something is already on that tile.")

    def apply() -> None:
        _cast(match, ability, color, tiles=[node.id])
        turns = int(ability.params["turns"])
        match.tile_fx[node.id] = TileEffect("trap", turns, color)
        match._emit(ev.TileChanged(tile=node.id, effect="trap", turns=turns, owner=color))

    return apply


def shield(match: Match, ability: Ability, color: Color, target: dict) -> Apply:
    piece = _own_piece(match, color, target, trail=False)

    def apply() -> None:
        _cast(match, ability, color, piece=piece)
        match.teams[color].statuses[piece]["shield"] = int(ability.params.get("turns", 1))
        match._emit(ev.StatusChanged(color=color, piece=piece, status="shield", active=True))

    return apply


def rally(match: Match, ability: Ability, color: Color, target: dict) -> Apply:
    team = match.teams[color]
    pieces = [i for i in range(len(team.pieces)) if team.pieces[i] != CAMP and not match.is_finished(color, i)]
    if not pieces:
        raise RuleError("You need a piece out on the board.")
    steps = int(ability.params["steps"])

    def apply() -> None:
        _cast(match, ability, color)
        for i in pieces:
            team.statuses[i]["shield"] = 1
            match._emit(ev.StatusChanged(color=color, piece=i, status="shield", active=True))
        for i in pieces:
            if match.is_over:
                return
            if team.pieces[i] != CAMP and not match.is_finished(color, i):
                _advance(match, color, i, steps, "rally")

    return apply


def swap(match: Match, ability: Ability, color: Color, target: dict) -> Apply:
    tc, tp, their = _enemy(match, color, target, int(ability.params["range"]))
    candidates = [
        (match.board.loop_distance(mine, their) or 0, i, mine)
        for i, mine in _trail_nodes(match, color)
        if not match.board.is_immune(mine)
    ]
    if isinstance(target.get("piece_own"), int):
        candidates = [c for c in candidates if c[1] == target["piece_own"]]
    if not candidates:
        raise RuleError("You need a piece on an open trail tile to swap with.")
    _, mine_i, mine = min(candidates, key=lambda c: c[0])
    my_new = match.board.locate(color, their.id)
    their_new = match.board.locate(tc, mine.id)
    if my_new is None or their_new is None:
        raise RuleError("Those two can't swap places.")

    def apply() -> None:
        _cast(match, ability, color, piece=mine_i, targetColor=tc, targetPiece=tp, tiles=[mine.id, their.id])
        match._place(color, mine_i, *my_new)
        match._place(tc, tp, *their_new)
        match._emit(
            ev.Swapped(
                color=color,
                piece=mine_i,
                to=my_new[0],
                lane=my_new[1],
                otherColor=tc,
                otherPiece=tp,
                otherTo=their_new[0],
                otherLane=their_new[1],
            )
        )
        match._land(tc, tp, "swap")
        if not match.is_over:
            match._land(color, mine_i, "swap")

    return apply


EFFECTS: dict[str, Callable[[Match, Ability, Color, dict], Apply]] = {
    "dash": dash,
    "line": line,
    "radius": radius,
    "strike": strike,
    "blink": blink,
    "meteor": meteor,
    "trap": trap,
    "shield": shield,
    "rally": rally,
    "swap": swap,
}


def candidates(match: Match, ability: Ability, color: Color) -> list[dict]:
    """Every target worth trying for an ability (validation filters them)."""
    team = match.teams[color]
    n = len(team.pieces)
    t = ability.targeting
    if t == "ownPiece":
        return [{"piece": i} for i in range(n)]
    if t == "ownPieceSteps":
        return [{"piece": i, "steps": s} for i in range(n) for s in range(1, int(ability.params["maxSteps"]) + 1)]
    if t == "enemyPiece":
        return [
            {"color": c.value, "piece": i}
            for c, other in match.teams.items()
            if c != color
            for i in range(len(other.pieces))
        ]
    if t == "tile":
        return [{"node": nid} for nid, node in match.board.nodes.items() if node.loop_index is not None]
    return [{}]


def _check() -> None:
    from .heroes import ABILITIES

    missing = {a.effect for a in ABILITIES.values()} - set(EFFECTS)
    assert not missing, f"abilities reference unknown effects: {missing}"


_check()
