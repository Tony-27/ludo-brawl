import pytest

from app.game.board import Color, available_maps, load_board


def test_maps_are_listed():
    ids = {b.id for b in available_maps()}
    assert {"classic_arena", "emerald_wilds"} <= ids


@pytest.mark.parametrize("map_id", ["classic_arena", "emerald_wilds", "molten_forge", "frost_glacier"])
def test_routes_are_consistent(map_id):
    board = load_board(map_id)
    assert len(board.teams) == 4
    starts = set()
    for color in board.teams:
        for branch in range(3 if board.regions else 1):
            choices = {rid: branch for rid in board.regions}
            path = board.path(color, choices)
            start = board.nodes[path[0]]
            assert start.kind == "start"
            starts.add(start.id)
            assert board.nodes[path[-1]].kind == "goal"
            assert len(set(path)) == len(path)
            # Home path is private to the team.
            for nid in path:
                if board.nodes[nid].kind in ("home", "goal"):
                    assert all(board.locate(c, nid) is None for c in board.teams if c != color)
    assert len(starts) == 4


def test_emerald_wilds_is_bigger_and_has_features():
    wilds, classic = load_board("emerald_wilds"), load_board("classic_arena")
    assert wilds.finish(Color.RED) > classic.finish(Color.RED)
    kinds = {n.kind for n in wilds.nodes.values()}
    assert {"shrine", "safe", "start", "home", "goal"} <= kinds
    assert wilds.data["rivers"] and wilds.data["zones"]


def test_forge_and_glacier_offer_three_routes_of_different_lengths():
    for map_id, features in (
        ("molten_forge", {"crumble", "conveyor", "anvil", "portal", "eruption", "branches"}),
        ("frost_glacier", {"ice", "thin_ice", "spring", "freeze", "avalanche", "branches"}),
    ):
        board = load_board(map_id)
        assert features <= set(board.summary()["features"])
        assert board.pieces_per_team == 3 and len(board.nodes) >= 120
        for region in board.regions.values():
            lengths = [len(b.nodes) for b in region.branches]
            assert len(lengths) == 3 and len(set(lengths)) == 3


def test_hazards_are_never_on_protected_tiles():
    for board in (load_board("molten_forge"), load_board("frost_glacier")):
        for node in board.nodes.values():
            if node.hazard:
                assert node.kind not in ("start", "safe", "home", "goal")


def test_unknown_or_unsafe_map_ids_are_rejected():
    for bad in ("nope", "../settings"):
        with pytest.raises(KeyError):
            load_board(bad)
