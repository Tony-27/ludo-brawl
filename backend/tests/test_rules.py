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
    return board.locate(color, nid)[0]


def mini_board(hazards=None, region=None, n=12, pieces=3, events=()):
    """A tiny 2-team board: loop of n tiles, red starts at 0, yellow at n/2, 2 home tiles each.

    `region=(at, span, lengths)` turns spine tiles at..at+span-1 into a region whose
    branch 0 is those tiles and branch k is `lengths[k-1]` new tiles named bK_0, bK_1...
    """
    hazards = hazards or {}
    nodes, loop, regions = [], [], {}

    def add(nid, kind="normal"):
        node = {"id": nid, "kind": kind, "pos": [0, 0, 0]}
        if nid in hazards:
            node["hazard"] = hazards[nid]
        nodes.append(node)

    i = 0
    while i < n:
        if region and i == region[0]:
            at, span, lengths = region
            branches = [{"name": "Main", "nodes": [f"t{k}" for k in range(at, at + span)]}]
            for k in branches[0]["nodes"]:
                add(k)
            for b, length in enumerate(lengths, start=1):
                ids = [f"b{b}_{k}" for k in range(length)]
                for nid in ids:
                    add(nid)
                branches.append({"name": f"Alt {b}", "tag": "", "nodes": ids})
            regions["r"] = {"name": "Pass", "branches": branches}
            loop.append({"region": "r"})
            i += span
            continue
        add(f"t{i}", "start" if i in (0, n // 2) else "normal")
        loop.append(f"t{i}")
        i += 1
    routes = {}
    for color, s in (("red", 0), ("yellow", n // 2)):
        first = loop.index(f"t{s}")
        path = [loop[(first + k) % len(loop)] for k in range(len(loop) - 1)]
        for k in range(2):
            nodes.append({"id": f"h_{color}_{k}", "kind": "home", "pos": [0, 0, 0]})
            path.append(f"h_{color}_{k}")
        nodes.append({"id": f"goal_{color}", "kind": "goal", "pos": [0, 0, 0]})
        path.append(f"goal_{color}")
        routes[color] = path
    return Board(
        {
            "id": "mini",
            "name": "Mini",
            "piecesPerTeam": pieces,
            "nodes": nodes,
            "loop": loop,
            "regions": regions,
            "routes": routes,
            "events": list(events),
        }
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
    assert [{k: v for k, v in t.items() if k != "preview"} for t in targets["zap"]] == [{"color": "yellow", "piece": 1}]
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
    m._place(R, 1, 15, {})
    m._arrive(R, 1, "move", 0)
    assert m.teams[R].pieces[1] == CAMP


def test_snare_trap_roots_and_knocks_back_the_next_enemy():
    m = match({R: "ranger", Y: "samurai"})
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, CAMP, CAMP]
    m.cast("snare_trap", {"node": "t14"})
    yp = loop_progress(Y, 14)
    m._place(Y, 0, yp, {})
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
    m.teams[Y].pieces[1] = loop_progress(Y, 12)
    m.cast("fire_breath", {"piece": 0})
    assert {k for k, v in m.tile_fx.items() if v.kind == "fire"} == {"t11", "t12"}  # t13 is a safe start tile
    m.teams[Y].mana = 3
    m._place(Y, 0, loop_progress(Y, 11), {})
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
    m.roll(1, auto_move=False)
    evs = m.move(0)
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
    m._place(R, 0, 3, {})
    m._arrive(R, 0, "move", 0)
    assert m.teams[R].pieces[0] == 3
    m._place(R, 1, 3, {})
    m._arrive(R, 1, "move", 0)
    assert m.teams[R].pieces[1] == CAMP and "t3" in m.broken
    for _ in range(m.config.bridge_rebuild_turns):
        m._end_turn()
    assert "t3" not in m.broken


def test_currents_drift_pieces_at_turn_start():
    board = mini_board({"t2": {"type": "current", "steps": 2}})
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m._place(R, 0, 2, {})
    m.current = Y
    m._end_turn()  # back to red: the current carries the piece
    assert m.teams[R].pieces[0] == 4


def test_branches_of_different_lengths():
    # Region at t3..t5 (3 tiles); a 1-tile shortcut and a 5-tile detour with a pit.
    board = mini_board({"b2_2": {"type": "pit"}}, region=(3, 3, [1, 5]))
    assert [board.finish(R, {"r": b}) for b in range(3)] == [13, 11, 15]
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.take_events()
    m.teams[R].pieces = [1, 8, CAMP]
    m.roll(2, auto_move=False)
    opts = {(o.piece, o.lane) for o in m.move_options()}
    assert {(0, 0), (0, 1), (0, 2)} <= opts
    snap = m.snapshot()
    routes = {o["lane"]: o["route"] for o in snap["moveOptions"] if o["piece"] == 0}
    assert routes[1]["length"] == 1 and routes[2]["length"] == 5 and routes[0]["name"] == "Main"
    m.move(0, lane=2)
    assert m.teams[R].choices[0] == {"r": 2} and m.node_of(R, 0).id == "b2_0"
    assert m.finish_of(R, 0) == 15
    # Moving on stays on the chosen branch: no new choice, and the detour has a pit.
    m.current, m.phase = R, Phase.ROLL
    m.roll(2, auto_move=False)
    assert not any(o.lane is not None for o in m.move_options() if o.piece == 0)
    m.move(0)
    assert m.teams[R].pieces[0] == CAMP and m.teams[R].choices[0] == {}


def test_shortcut_skips_ahead_and_knockback_keeps_the_branch():
    board = mini_board(region=(3, 3, [1]), n=14)
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.take_events()
    m.teams[R].pieces = [2, CAMP, CAMP]
    m.roll(2, auto_move=False)
    m.move(0, lane=1)  # b1_0 then t6
    assert m.node_of(R, 0).id == "t6"
    m.knock_back(R, 0, 1, Y, "test")
    assert m.node_of(R, 0).id == "b1_0"
    m.knock_back(R, 0, 1, Y, "test")
    assert m.node_of(R, 0).id == "t2" and m.teams[R].choices[0] == {}


def test_move_events_list_the_tiles_walked():
    board = mini_board(region=(3, 3, [1]))
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.take_events()
    m.teams[R].pieces = [1, CAMP, CAMP]
    m.roll(3, auto_move=False)
    evs = m.move(0, lane=1)
    moved = next(e for e in evs if e.type == "moved")
    assert moved.path == ["t2", "b1_0", "t6"]


# ---------------------------------------------------------------- turn flow
def test_after_moving_you_may_still_cast_or_end_the_turn():
    m = match()
    m.teams[R].mana = 6
    m.teams[R].pieces = [10, 20, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 15)
    m.roll(1, auto_move=False)
    m.move(1)
    assert m.phase == Phase.ACT and m.current == R
    with pytest.raises(RuleError, match="No enemy"):
        m.cast("katana_slash", {"piece": 0})  # nobody on 11/12
    m.cast("quick_draw", {"piece": 0})
    assert m.current == Y


def test_act_phase_cast_ends_the_turn():
    m = match()
    m.teams[R].mana = 6
    m.teams[R].pieces = [9, 20, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 11)
    m.roll(1, auto_move=False)
    m.move(1)
    assert m.phase == Phase.ACT
    m.cast("katana_slash", {"piece": 0})
    assert m.current == Y and m.phase == Phase.ROLL


def test_end_turn_only_in_act_phase():
    m = match()
    with pytest.raises(RuleError):
        m.end_turn()
    m.teams[R].mana = 6
    m.teams[R].pieces = [9, 20, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 11)
    m.roll(1, auto_move=False)
    m.move(1)
    m.end_turn()
    assert m.current == Y


def test_no_act_phase_without_castable_spells():
    m = match()
    m.teams[R].pieces = [9, 20, CAMP]
    m.roll(2, auto_move=False)
    m.move(1)
    assert m.current == Y


def test_no_auto_move_while_a_spell_could_be_cast():
    m = match()
    m.teams[R].mana = 6
    m.teams[R].pieces = [9, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 12)
    m.roll(2)
    assert m.phase == Phase.MOVE and m.teams[R].pieces[0] == 9
    m.teams[R].mana = 0
    m.phase, m.cast_this_turn = Phase.ROLL, False
    m.roll(2)
    assert m.teams[R].pieces[0] == 11


def test_line_spells_need_an_enemy_in_reach():
    m = match()
    m.teams[R].mana = 6
    m.teams[R].pieces = [9, CAMP, CAMP]
    with pytest.raises(RuleError, match="No enemy"):
        m.cast("katana_slash", {"piece": 0})
    assert "katana_slash" not in m.cast_targets()
    m.teams[Y].pieces[0] = loop_progress(Y, 11)
    target = m.cast_targets()["katana_slash"][0]
    assert target["piece"] == 0 and target["preview"] == ["t10", "t11"]


# ---------------------------------------------------------------- map events and tiles
def test_eruption_is_announced_then_sends_pieces_home():
    board = mini_board(events=[{"type": "eruption", "every": 3, "offset": 0, "tiles": ["t3"]}])
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.take_events()
    m.teams[R].pieces = [1, CAMP, CAMP]
    m.teams[Y].pieces = [board.locate(Y, "t4")[0], CAMP, CAMP]
    for _ in range(2):  # finish round 1 (red, yellow)
        m._end_turn()
    assert m.round == 2 and m.warnings == {"t3": "eruption"}
    m._place(Y, 0, board.locate(Y, "t3")[0], {})
    m._end_turn()
    m._end_turn()  # round 3 starts: eruption
    assert m.round == 3 and m.teams[Y].pieces[0] == CAMP and not m.warnings


def test_frozen_lake_closes_when_it_thaws():
    board = mini_board(
        {"b1_0": {"type": "thin_ice", "uses": 2}},
        region=(3, 3, [1]),
        events=[{"type": "freeze", "region": "r", "branch": 1, "cycle": [1, 1], "tiles": ["b1_0"]}],
    )
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.take_events()
    m.teams[R].pieces = [2, CAMP, CAMP]
    m._place(R, 1, 3, {"r": 1})
    assert m.node_of(R, 1).id == "b1_0"
    m._end_turn()
    m._end_turn()  # round 2: thawed
    assert ("r", 1) in m.closed and m.teams[R].pieces[1] == CAMP
    m.current, m.phase = R, Phase.ROLL
    m.roll(2, auto_move=False)
    assert {o.lane for o in m.move_options() if o.piece == 0} == {0}


def test_conveyor_flips_direction_each_round():
    board = mini_board(
        {"t4": {"type": "conveyor", "steps": 2}}, events=[{"type": "conveyor", "every": 1, "tiles": ["t4"]}]
    )
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.teams[R].pieces = [3, CAMP, CAMP]
    m.roll(1, auto_move=False)
    m.move(0)
    assert m.teams[R].pieces[0] == 6
    m.current = Y
    m._end_turn()  # round 2: backwards
    assert m.conveyor == -1
    m._place(R, 1, 3, {})
    m._place(R, 1, 4, {})
    m._arrive(R, 1, "move", 0)
    assert m.teams[R].pieces[1] == 2


def test_ice_slides_you_to_solid_ground_and_thin_ice_breaks():
    board = mini_board({"t3": {"type": "ice"}, "t4": {"type": "ice"}, "t8": {"type": "thin_ice", "uses": 2}})
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.teams[R].pieces = [2, CAMP, CAMP]
    m.roll(1, auto_move=False)
    m.move(0)
    assert m.teams[R].pieces[0] == 5
    m._place(R, 1, 8, {})
    m._arrive(R, 1, "move", 0)
    assert m.crumble["t8"] == 1 and m.snapshot()["tiles"]["t8"]["effect"] == "cracked"
    m._place(R, 2, 8, {})
    m._arrive(R, 2, "move", 0)
    assert m.teams[R].pieces[2] == CAMP and "t8" in m.broken


def test_hot_spring_heals_roots_and_anvil_empowers_the_next_spell():
    board = mini_board({"t3": {"type": "spring"}, "t5": {"type": "anvil"}})
    m = Match(board, {R: "samurai", Y: "samurai"}, rng=random.Random(1))
    m.teams[R].statuses[0]["rooted"] = 2
    mana = m.teams[R].mana
    m._place(R, 0, 3, {})
    m._arrive(R, 0, "move", 0)
    assert "rooted" not in m.teams[R].statuses[0] and m.teams[R].mana == mana + 1
    m._place(R, 0, 5, {})
    m._arrive(R, 0, "move", 0)
    assert m.teams[R].empowered
    m.teams[R].mana = 6
    m._place(Y, 0, board.locate(Y, "t7")[0], {})
    start = m.teams[Y].pieces[0]
    kb = next(e for e in m.cast("katana_slash", {"piece": 0}) if e.type == "knockedBack")
    assert kb.start - kb.end == min(start, 4 + m.config.empower_bonus) and not m.teams[R].empowered


def test_events_serialise_with_aliases():
    data = dump(match().roll(6))
    moved = next(e for e in data if e["type"] == "moved")
    assert moved["from"] == CAMP and moved["to"] == 0 and moved["path"] == ["t0"]


@pytest.mark.parametrize("map_id", ["classic_arena", "emerald_wilds", "molten_forge", "frost_glacier"])
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
            elif a.kind == "end":
                m.end_turn()
            else:
                m.move(a.piece, a.lane)
            m.snapshot()
        assert m.is_over and sorted(m.ranking) == sorted([R, G, Y, B])
