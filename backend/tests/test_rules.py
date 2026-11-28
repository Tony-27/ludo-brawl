import random

import pytest

from app.game import bots
from app.game.board import CAMP, Board, Color, load_board
from app.game.events import dump
from app.game.heroes import ABILITIES, HEROES
from app.game.rules import Match, Phase, RuleError

R, G, Y, B = Color.RED, Color.GREEN, Color.YELLOW, Color.BLUE
CLASSIC = load_board("classic_arena")


def match(heroes=None, board=CLASSIC):
    m = Match(board, heroes or {R: "samurai", Y: "grand_wizard"}, rng=random.Random(1))
    m.take_events()
    return m


def types(events):
    return [e.type for e in events]


def loop_progress(color, loop_index, board=CLASSIC):
    """Progress value for `color` that stands on shared loop tile `loop_index`."""
    nid = board.data["loop"][loop_index]
    return board.locate(color, nid if isinstance(nid, str) else nid[0])[0]


def mini_board(hazards=None, forks=(), n=12, pieces=3):
    """A tiny 2-team board: loop of n tiles, red starts at 0, yellow at n/2, 2 home tiles each."""
    hazards = hazards or {}
    nodes, loop = [], []
    for i in range(n):
        kind = "start" if i in (0, n // 2) else "normal"
        node = {"id": f"t{i}", "kind": kind, "pos": [i, 0, 0]}
        if f"t{i}" in hazards:
            node["hazard"] = hazards[f"t{i}"]
        nodes.append(node)
        if i in forks:
            alt = {"id": f"a{i}", "kind": "normal", "pos": [i, 0, 1], "lane": 1}
            if f"a{i}" in hazards:
                alt["hazard"] = hazards[f"a{i}"]
            nodes.append(alt)
            loop.append([f"t{i}", f"a{i}"])
        else:
            loop.append(f"t{i}")
    routes = {}
    for color, s in (("red", 0), ("yellow", n // 2)):
        path = [loop[(s + k) % n] for k in range(n - 1)]
        for k in range(2):
            nodes.append({"id": f"h_{color}_{k}", "kind": "home", "pos": [0, 0, 0]})
            path.append(f"h_{color}_{k}")
        nodes.append({"id": f"goal_{color}", "kind": "goal", "pos": [0, 0, 0]})
        path.append(f"goal_{color}")
        routes[color] = path
    return Board(
        {"id": "mini", "name": "Mini", "piecesPerTeam": pieces, "nodes": nodes, "loop": loop, "routes": routes}
    )


# ---------------------------------------------------------------- classic parity
def test_three_pieces_per_team_and_clockwise_order():
    m = match({B: "samurai", R: "samurai", Y: "samurai"})
    assert m.order == [R, Y, B] and len(m.teams[R].pieces) == 3


def test_needs_two_to_four_teams_and_known_heroes():
    with pytest.raises(RuleError):
        Match(CLASSIC, {R: "samurai"})
    with pytest.raises(RuleError):
        Match(CLASSIC, {R: "samurai", Y: "nobody"})


def test_six_auto_moves_out_and_grants_extra_roll():
    m = match()
    evs = m.roll(6)
    moved = next(e for e in evs if e.type == "moved")
    assert moved.start == CAMP and moved.end == 0 and m.current == R and m.phase == Phase.ROLL


def test_capture_on_landing_sends_victim_to_camp():
    m = match()
    m.teams[R].pieces = [3, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 5)
    assert "captured" in types(m.roll(2))
    assert m.teams[Y].pieces[0] == CAMP and m.current == R


def test_no_capture_on_safe_tile():
    m = match()
    m.teams[R].pieces = [5, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 8)
    assert "captured" not in types(m.roll(3))


def test_exact_roll_needed_to_finish_and_game_over():
    m = match()
    finish = CLASSIC.finish(R)
    m.teams[R].pieces = [finish - 2, finish, finish]
    assert "turnPassed" in types(m.roll(5))
    m.current, m.phase = R, Phase.ROLL
    assert "gameOver" in types(m.roll(2)) and m.ranking == [R, Y]


def test_three_sixes_forfeit():
    m = match()
    m.teams[R].pieces = [10, 20, 30]
    for _ in range(2):
        m.roll(6)
        m.move(0)
    assert any(e.type == "turnPassed" and e.reason == "threeSixes" for e in m.roll(6))


# ---------------------------------------------------------------- mana & casting rules
def test_mana_cap_and_cast_rules():
    m = match()
    assert m.teams[R].mana == 1
    m.teams[R].pieces = [10, CAMP, CAMP]
    with pytest.raises(RuleError, match="mana"):
        m.cast("katana_slash", {"piece": 0})
    m.teams[R].mana = 6
    m.cast("quick_draw", {"piece": 0})
    with pytest.raises(RuleError, match="already"):
        m.cast("katana_slash", {"piece": 0})
    with pytest.raises(RuleError):
        m.cast("zap", {"color": "yellow", "piece": 0})


def test_ultimate_only_once_per_match():
    m = match()
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 12)
    m.cast("thousand_cuts", {})
    assert m.teams[R].ult_used
    m.cast_this_turn = False
    m.teams[R].mana = 6
    with pytest.raises(RuleError, match="once"):
        m.cast("thousand_cuts", {})


def test_every_hero_has_three_abilities_with_known_effects():
    for hero in HEROES.values():
        slots = [ABILITIES[a].slot for a in hero.abilities]
        assert slots == ["basic", "utility", "ultimate"]
        assert hero.selectable


def test_cast_targets_lists_only_valid_options():
    m = match({R: "grand_wizard", Y: "samurai"})
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, CAMP, CAMP]
    m.teams[Y].pieces = [loop_progress(Y, 30), loop_progress(Y, 15), CAMP]
    targets = m.cast_targets()
    assert targets["zap"] == [{"color": "yellow", "piece": 1}]
    assert {t["piece"] for t in targets["blink"]} == {0}


# ---------------------------------------------------------------- effects
def test_quick_draw_dashes_and_captures():
    m = match()
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 12)
    evs = m.cast("quick_draw", {"piece": 0})
    assert types(evs)[:2] == ["abilityCast", "manaChanged"]
    assert m.teams[R].pieces[0] == 12 and m.teams[Y].pieces[0] == CAMP and "captured" in types(evs)


def test_katana_slash_knocks_back():
    m = match()
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, CAMP, CAMP]
    m.teams[Y].pieces[0] = before = loop_progress(Y, 12)
    kb = next(e for e in m.cast("katana_slash", {"piece": 0}) if e.type == "knockedBack")
    assert kb.start == before and kb.end == before - 4


def test_zap_range_and_safe_tile_immunity():
    m = match({R: "grand_wizard", Y: "samurai"})
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, CAMP, CAMP]
    m.teams[Y].pieces = [loop_progress(Y, 30), loop_progress(Y, 13), loop_progress(Y, 15)]
    with pytest.raises(RuleError, match="range"):
        m.cast("zap", {"color": "yellow", "piece": 0})
    with pytest.raises(RuleError, match="safe"):
        m.cast("zap", {"color": "yellow", "piece": 1})
    kb = next(e for e in m.cast("zap", {"color": "yellow", "piece": 2}) if e.type == "knockedBack")
    assert kb.end == kb.start - 3


def test_knockback_never_goes_past_the_start_tile():
    m = match()
    m.teams[Y].pieces[0] = 2
    m.knock_back(Y, 0, 10, R, "test")
    assert m.teams[Y].pieces[0] == 0


def test_shield_blocks_attacks_and_falls_until_next_turn():
    m = match({R: "samurai", Y: "knight"})
    m.teams[Y].pieces[0] = 20
    m.teams[Y].statuses[0]["shield"] = 1
    m.knock_back(Y, 0, 4, R, "test")
    assert m.teams[Y].pieces[0] == 20
    m.current = Y
    m._begin_turn()
    assert "shield" not in m.teams[Y].statuses[0]


def test_rooted_piece_cannot_move():
    m = match()
    m.teams[R].pieces = [10, 20, CAMP]
    m.teams[R].statuses[0]["rooted"] = 1
    m.roll(3, auto_move=False)
    assert m.legal_pieces() == [1]
    m.move(1)
    assert "rooted" not in m.teams[R].statuses[0]


def test_meteor_knocks_back_splash_and_leaves_a_crater():
    m = match({R: "grand_wizard", Y: "samurai"})
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, CAMP, CAMP]
    m.teams[Y].pieces = [loop_progress(Y, 15), loop_progress(Y, 16), CAMP]
    evs = m.cast("meteor", {"node": "t15"})
    assert sum(e.type == "knockedBack" for e in evs) == 2
    assert m.tile_fx["t15"].kind == "crater"
    # Landing in the crater is a fall.
    m.teams[R].pieces[1] = 12
    m._place(R, 1, 15, 0)
    m._arrive(R, 1, "move", 0)
    assert m.teams[R].pieces[1] == CAMP


def test_snare_trap_roots_and_knocks_back_the_next_enemy():
    m = match({R: "ranger", Y: "samurai"})
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, CAMP, CAMP]
    m.cast("snare_trap", {"node": "t14"})
    yp = loop_progress(Y, 14)
    m._place(Y, 0, yp, 0)
    m._arrive(Y, 0, "move", 0)
    assert "rooted" in m.teams[Y].statuses[0] and m.teams[Y].pieces[0] == yp - 2 and "t14" not in m.tile_fx


def test_wild_growth_swaps_places():
    m = match({R: "druid", Y: "samurai"})
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 14)
    m.cast("wild_growth", {"color": "yellow", "piece": 0})
    assert m.teams[R].pieces[0] == 14 and m.teams[Y].pieces[0] == loop_progress(Y, 10)


def test_rally_advances_and_shields_all_pieces():
    m = match({R: "knight", Y: "samurai"})
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, 20, CAMP]
    m.cast("rally", {})
    assert m.teams[R].pieces[:2] == [12, 22] and all("shield" in m.teams[R].statuses[i] for i in (0, 1))


def test_fire_breath_burns_tiles_and_drains_mana():
    m = match({R: "dragon_rider", Y: "samurai"})
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, CAMP, CAMP]
    m.cast("fire_breath", {"piece": 0})
    assert {k for k, v in m.tile_fx.items() if v.kind == "fire"} == {"t11", "t12"}  # t13 is a safe start tile
    m.teams[Y].mana = 3
    m._place(Y, 0, loop_progress(Y, 11), 0)
    m._arrive(Y, 0, "move", 0)
    assert m.teams[Y].mana == 2


# ---------------------------------------------------------------- hazards and forks
def test_pit_sends_you_home_and_knockback_can_push_into_it():
    board = mini_board({"t3": {"type": "pit"}})
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.teams[R].pieces = [1, CAMP, CAMP]
    evs = m.roll(2)
    assert "fell" in types(evs) and m.teams[R].pieces[0] == CAMP
    # Yellow at t4 (progress 10 for yellow) knocked back 1 lands on t3 and falls.
    m.teams[Y].pieces[0] = board.locate(Y, "t4")[0]
    m.knock_back(Y, 0, 1, R, "test")
    assert m.teams[Y].pieces[0] == CAMP


def test_slides_and_portals_chain_forward():
    board = mini_board({"t2": {"type": "slide", "steps": 3}, "t5": {"type": "portal", "to": "t8"}})
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.teams[R].pieces = [1, CAMP, CAMP]
    evs = m.roll(1)
    assert types(evs)[-3:-1] == ["slid", "portaled"] or ("slid" in types(evs) and "portaled" in types(evs))
    assert m.teams[R].pieces[0] == 8


def test_portal_never_sends_you_backwards():
    board = mini_board({"t9": {"type": "portal", "to": "t1"}})
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.teams[R].pieces = [7, CAMP, CAMP]
    m.roll(2)
    assert m.teams[R].pieces[0] == 9


def test_crumbling_bridge_collapses_then_rebuilds():
    board = mini_board({"t3": {"type": "crumble", "uses": 2}})
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m._place(R, 0, 3, 0)
    m._arrive(R, 0, "move", 0)
    assert m.teams[R].pieces[0] == 3
    m._place(R, 1, 3, 0)
    m._arrive(R, 1, "move", 0)
    assert m.teams[R].pieces[1] == CAMP and "t3" in m.broken
    for _ in range(m.config.bridge_rebuild_turns):
        m._end_turn()
    assert "t3" not in m.broken


def test_currents_drift_pieces_at_turn_start():
    board = mini_board({"t2": {"type": "current", "steps": 2}})
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m._place(R, 0, 2, 0)
    m.current = Y
    m._end_turn()  # back to red: the current carries the piece
    assert m.teams[R].pieces[0] == 4


def test_fork_requires_a_lane_choice_and_keeps_it():
    board = mini_board({"a4": {"type": "pit"}}, forks=(3, 4, 5))
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.teams[R].pieces = [1, 8, CAMP]
    m.roll(2, auto_move=False)
    opts = {(o.piece, o.lane) for o in m.move_options()}
    assert (0, 0) in opts and (0, 1) in opts
    m.move(0, lane=1)
    assert m.teams[R].lanes[0] == 1 and m.node_of(R, 0).id == "a3"
    # Moving on inside the fork stays in the chosen lane (and the risky lane has a pit).
    m.current, m.phase = R, Phase.ROLL
    m.roll(1, auto_move=False)
    assert not any(o.lane is not None for o in m.move_options() if o.piece == 0)
    m.move(0)
    assert m.teams[R].pieces[0] == CAMP


def test_events_serialise_with_aliases():
    data = dump(match().roll(6))
    moved = next(e for e in data if e["type"] == "moved")
    assert moved["from"] == CAMP and moved["to"] == 0 and moved["lane"] == 0


@pytest.mark.parametrize("map_id", ["classic_arena", "emerald_wilds", "molten_forge"])
def test_bot_games_always_finish_with_every_hero(map_id):
    board = load_board(map_id)
    heroes = list(HEROES)
    for seed in range(3):
        rng = random.Random(seed)
        picks = {c: heroes[(seed * 4 + k) % len(heroes)] for k, c in enumerate([R, G, Y, B])}
        m = Match(board, picks, rng=rng)
        while not m.is_over and m.turn < 4000:
            a = bots.choose_action(m, rng)
            if a.kind == "cast":
                m.cast(a.ability, a.target)
            elif a.kind == "roll":
                m.roll(rng.randint(1, 6))
            else:
                m.move(a.piece, a.lane)
            m.snapshot()
        assert m.is_over and sorted(m.ranking) == sorted([R, G, Y, B])
