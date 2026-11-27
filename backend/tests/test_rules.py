import random

import pytest

from app.game import bots
from app.game.board import CAMP, Color, load_board
from app.game.events import dump
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
    route = board.routes[color]
    nid = board.data["loop"][loop_index]
    return route.index(nid)


# ---------------------------------------------------------------- classic parity
def test_turn_order_is_clockwise():
    assert match({B: "samurai", R: "samurai", Y: "samurai"}).order == [R, Y, B]


def test_needs_two_to_four_teams_and_known_heroes():
    with pytest.raises(RuleError):
        Match(CLASSIC, {R: "samurai"})
    with pytest.raises(RuleError):
        Match(CLASSIC, {R: "samurai", Y: "nobody"})


def test_non_six_with_everyone_in_camp_passes():
    m = match()
    evs = m.roll(4)
    assert "turnPassed" in types(evs) and m.current == Y and m.phase == Phase.ROLL


def test_six_auto_moves_out_and_grants_extra_roll():
    m = match()
    evs = m.roll(6)
    moved = next(e for e in evs if e.type == "moved")
    assert moved.start == CAMP and moved.end == 0 and moved.path == [0]
    assert m.current == R and m.phase == Phase.ROLL


def test_capture_on_landing_sends_victim_to_camp():
    m = match()
    m.teams[R].pieces = [3, CAMP, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 5)
    evs = m.roll(2)
    assert "captured" in types(evs)
    assert m.teams[Y].pieces[0] == CAMP and m.current == R  # extra roll


def test_no_capture_on_safe_tile():
    m = match()
    m.teams[R].pieces = [5, CAMP, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 8)  # star tile
    evs = m.roll(3)
    assert "captured" not in types(evs) and m.teams[Y].pieces[0] != CAMP


def test_exact_roll_needed_to_finish():
    m = match()
    finish = CLASSIC.finish(R)
    m.teams[R].pieces = [finish - 2, finish, finish, finish]
    assert "turnPassed" in types(m.roll(5))
    m.current = R
    m.phase = Phase.ROLL
    evs = m.roll(2)
    assert "gameOver" in types(evs) and m.ranking == [R, Y]


def test_three_sixes_forfeit():
    m = match()
    m.teams[R].pieces = [10, 20, 30, 40]
    for _ in range(2):
        m.roll(6)
        m.move(0)
    evs = m.roll(6)
    assert any(e.type == "turnPassed" and e.reason == "threeSixes" for e in evs) and m.current == Y


# ---------------------------------------------------------------- mana
def test_mana_per_turn_and_rolled_one_and_cap():
    m = match()
    assert m.teams[R].mana == 1  # first turn grant
    evs = m.roll(1)
    assert any(e.type == "manaChanged" and e.reason == "rolledOne" for e in evs)
    m.teams[Y].mana = 5
    m.current = Y
    m._begin_turn()
    assert m.teams[Y].mana == 5


def test_shrine_gives_mana():
    board = load_board("emerald_wilds")
    m = match({R: "samurai", Y: "samurai"}, board)
    shrine = next(i for i, nid in enumerate(board.routes[R]) if board.nodes[nid].kind == "shrine")
    m.teams[R].pieces = [shrine - 3, CAMP, CAMP, CAMP]
    before = m.teams[R].mana
    m.roll(3)
    assert m.teams[R].mana == before + 2


def test_knocked_out_victim_gets_mana_and_bushido_rewards_attacker():
    m = match()
    m.teams[R].pieces = [3, CAMP, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 5)
    r_before, y_before = m.teams[R].mana, m.teams[Y].mana
    m.roll(2)
    assert m.teams[Y].mana == y_before + 2
    assert m.teams[R].mana == r_before + 1  # samurai passive


# ---------------------------------------------------------------- abilities
def test_katana_slash_knocks_back_enemies_two_ahead():
    m = match()
    m.teams[R].mana = 5
    m.teams[R].pieces = [10, CAMP, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 12)
    before = m.teams[Y].pieces[0]
    evs = m.cast("katana_slash", {"piece": 0})
    assert types(evs)[:2] == ["abilityCast", "manaChanged"]
    kb = next(e for e in evs if e.type == "knockedBack")
    assert kb.start == before and kb.end == before - 4
    assert m.teams[R].mana == 2 and m.cast_this_turn


def test_one_cast_per_turn_and_mana_required():
    m = match()
    m.teams[R].pieces = [10, CAMP, CAMP, CAMP]
    with pytest.raises(RuleError, match="mana"):
        m.cast("katana_slash", {"piece": 0})
    m.teams[R].mana = 5
    m.cast("katana_slash", {"piece": 0})
    with pytest.raises(RuleError, match="already"):
        m.cast("katana_slash", {"piece": 0})


def test_cannot_use_another_heroes_ability():
    m = match()
    m.teams[R].mana = 5
    with pytest.raises(RuleError):
        m.cast("zap", {"color": "yellow", "piece": 0})


def test_zap_range_and_safe_tile_immunity():
    m = match({R: "grand_wizard", Y: "samurai"})
    m.teams[R].mana = 5
    m.teams[R].pieces = [10, CAMP, CAMP, CAMP]
    m.teams[Y].pieces = [loop_progress(Y, 30), loop_progress(Y, 13), loop_progress(Y, 15), CAMP]
    with pytest.raises(RuleError, match="range"):
        m.cast("zap", {"color": "yellow", "piece": 0})
    with pytest.raises(RuleError, match="safe"):
        m.cast("zap", {"color": "yellow", "piece": 1})  # green start tile
    evs = m.cast("zap", {"color": "yellow", "piece": 2})
    kb = next(e for e in evs if e.type == "knockedBack")
    assert kb.end == kb.start - 3


def test_knockback_never_goes_past_the_start_tile():
    m = match()
    m.teams[Y].pieces[0] = 2
    m.knock_back(Y, 0, 10, R, "test")
    assert m.teams[Y].pieces[0] == 0


def test_blink_moves_without_capturing_and_can_finish():
    m = match({R: "grand_wizard", Y: "samurai"})
    m.teams[R].mana = 5
    m.teams[R].pieces = [10, CAMP, CAMP, CAMP]
    m.teams[Y].pieces[0] = loop_progress(Y, 13 % 52)
    evs = m.cast("blink", {"piece": 0, "steps": 3})
    assert "teleported" in types(evs) and m.teams[R].pieces[0] == 13
    assert m.teams[Y].pieces[0] != CAMP
    finish = CLASSIC.finish(R)
    m2 = match({R: "grand_wizard", Y: "samurai"})
    m2.teams[R].mana = 5
    m2.teams[R].pieces = [finish - 2, finish, finish, finish]
    assert "gameOver" in types(m2.cast("blink", {"piece": 0, "steps": 2}))


def test_shield_blocks_attacks_until_owners_next_turn():
    m = match({R: "samurai", Y: "samurai"})
    m.teams[Y].pieces[0] = 20
    m.teams[Y].statuses[0]["shield"] = 1
    m.knock_back(Y, 0, 4, R, "test")
    assert m.teams[Y].pieces[0] == 20
    m.current = Y
    m._begin_turn()
    assert "shield" not in m.teams[Y].statuses[0]


def test_rooted_piece_cannot_move_for_one_turn():
    m = match()
    m.teams[R].pieces = [10, 20, CAMP, CAMP]
    m.teams[R].statuses[0]["rooted"] = 1
    m.roll(3, auto_move=False)
    assert m.legal_pieces() == [1]
    m.move(1)
    assert "rooted" not in m.teams[R].statuses[0]


def test_casting_in_move_phase_can_leave_no_moves_and_pass():
    m = match({R: "grand_wizard", Y: "samurai"})
    finish = CLASSIC.finish(R)
    m.teams[R].mana = 5
    m.teams[R].pieces = [finish - 3, finish, finish, finish]
    m.roll(3, auto_move=False)
    assert m.phase == Phase.MOVE
    evs = m.cast("blink", {"piece": 0, "steps": 2})
    assert "turnPassed" in types(evs) and m.current == Y


def test_events_serialise_with_aliases():
    m = match()
    data = dump(m.roll(6))
    moved = next(e for e in data if e["type"] == "moved")
    assert moved["from"] == CAMP and moved["to"] == 0


@pytest.mark.parametrize("map_id", ["classic_arena", "emerald_wilds"])
def test_bot_games_always_finish(map_id):
    board = load_board(map_id)
    for seed in range(8):
        rng = random.Random(seed)
        m = Match(board, {R: "samurai", G: "grand_wizard", Y: "samurai", B: "grand_wizard"}, rng=rng)
        for _ in range(60000):
            if m.is_over:
                break
            a = bots.choose_action(m)
            if a.kind == "cast":
                m.cast(a.ability, a.target)
            elif a.kind == "roll":
                m.roll(rng.randint(1, 6))
            else:
                m.move(a.piece)
        assert m.is_over and sorted(m.ranking) == sorted([R, G, Y, B])
