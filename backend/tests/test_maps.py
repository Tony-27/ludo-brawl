import pytest

from app.game.board import Color, available_maps, load_board


def test_maps_are_listed():
    ids = {b.id for b in available_maps()}
    assert {"classic_arena", "emerald_wilds"} <= ids


@pytest.mark.parametrize("map_id", ["classic_arena", "emerald_wilds"])
def test_routes_are_consistent(map_id):
    board = load_board(map_id)
    assert len(board.teams) == 4
    starts = set()
    for color in board.teams:
        route = board.routes[color]
        start = board.nodes[route[0]]
        assert start.kind == "start"
        starts.add(start.id)
        assert board.nodes[route[-1]].kind == "goal"
        # Walks the whole loop except the tile before its own start.
        on_loop = [n for n in route if board.nodes[n].loop_index is not None]
        assert len(on_loop) == board.loop_length - 1
        assert len(set(route)) == len(route)
        # Home path is private to the team.
        for nid in route:
            if board.nodes[nid].kind in ("home", "goal"):
                assert all(nid not in board.routes[c] for c in board.teams if c != color)
    assert len(starts) == 4


def test_emerald_wilds_is_bigger_and_has_features():
    wilds, classic = load_board("emerald_wilds"), load_board("classic_arena")
    assert wilds.finish(Color.RED) > classic.finish(Color.RED)
    kinds = {n.kind for n in wilds.nodes.values()}
    assert {"shrine", "safe", "start", "home", "goal"} <= kinds
    assert wilds.data["rivers"] and wilds.data["zones"]


def test_unknown_or_unsafe_map_ids_are_rejected():
    for bad in ("nope", "../settings"):
        with pytest.raises(KeyError):
            load_board(bad)
