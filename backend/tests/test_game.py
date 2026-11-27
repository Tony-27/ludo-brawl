import random

import pytest

from ludobrawl import bots
from ludobrawl.game import FINISH, YARD, Color, LudoGame, Phase, RuleError, absolute_square

R, G, Y, B = Color.RED, Color.GREEN, Color.YELLOW, Color.BLUE


def game(*colors):
    return LudoGame(list(colors or (R, Y)))


def test_turn_order_is_clockwise_regardless_of_join_order():
    assert game(B, R, Y).turn_order == [R, Y, B]


def test_needs_two_to_four_distinct_colours():
    with pytest.raises(RuleError):
        LudoGame([R])
    with pytest.raises(RuleError):
        LudoGame([R, R])


def test_non_six_with_all_pieces_in_yard_passes_turn():
    g = game()
    r = g.roll(4)
    assert r.passed and g.current == Y and g.phase == Phase.ROLL


def test_six_brings_piece_out_automatically_and_grants_extra_roll():
    g = game()
    r = g.roll(6)
    assert r.auto_move is not None
    assert g.pieces[R] == [0, YARD, YARD, YARD]
    assert g.current == R and g.phase == Phase.ROLL


def test_choice_is_left_to_player_when_moves_differ():
    g = game()
    g.pieces[R] = [5, YARD, YARD, YARD]
    r = g.roll(6)
    assert r.auto_move is None and r.legal_pieces == [0, 1, 2, 3]
    g.move(1)
    assert g.pieces[R][1] == 0


def test_capture_sends_victim_home_and_grants_extra_turn():
    g = game()
    g.pieces[R] = [3, YARD, YARD, YARD]
    # Yellow piece standing on absolute square 5 (yellow starts at 26).
    g.pieces[Y][0] = (5 - 26) % 52
    assert absolute_square(Y, g.pieces[Y][0]) == 5
    g.roll(2)
    assert g.pieces[R][0] == 5 and g.pieces[Y][0] == YARD
    assert g.last_move.captures and g.current == R


def test_no_capture_on_safe_square():
    g = game()
    g.pieces[R] = [5, YARD, YARD, YARD]
    g.pieces[Y][0] = (8 - 26) % 52  # square 8 is a star
    g.roll(3)
    assert g.pieces[R][0] == 8 and g.pieces[Y][0] != YARD
    assert g.current == Y


def test_exact_roll_needed_to_finish():
    g = game()
    g.pieces[R] = [54, FINISH, FINISH, FINISH]
    r = g.roll(5)
    assert r.passed and g.pieces[R][0] == 54
    g.current = R
    g.roll(2)
    assert g.pieces[R][0] == FINISH


def test_finishing_last_piece_ranks_player_and_two_player_game_ends():
    g = game()
    g.pieces[R] = [55, FINISH, FINISH, FINISH]
    g.roll(1)
    assert g.ranking == [R, Y] and g.phase == Phase.OVER


def test_three_player_game_continues_after_first_finisher():
    g = game(R, G, Y)
    g.pieces[R] = [55, FINISH, FINISH, FINISH]
    g.roll(1)
    assert g.ranking == [R] and g.phase == Phase.ROLL and g.current == G
    g.roll(2)  # green passes
    assert g.current == Y
    g.roll(2)  # yellow passes, red is skipped
    assert g.current == G


def test_three_sixes_in_a_row_forfeit_turn():
    g = game()
    g.pieces[R] = [10, 20, 30, 40]
    for _ in range(2):
        g.roll(6)
        g.move(0)
    r = g.roll(6)
    assert r.forfeited and g.current == Y


def test_cannot_move_before_rolling_or_roll_twice():
    g = game()
    with pytest.raises(RuleError):
        g.move(0)
    g.pieces[R] = [5, 9, YARD, YARD]
    g.roll(3)
    with pytest.raises(RuleError):
        g.roll(3)
    with pytest.raises(RuleError):
        g.move(2)  # in yard, needs a six


def test_bot_prefers_capture():
    g = game()
    g.pieces[R] = [3, 20, YARD, YARD]
    g.pieces[Y][0] = (6 - 26) % 52
    g.roll(3)
    assert bots.choose_piece(g) == 0


def test_random_games_always_terminate():
    rng = random.Random(1234)
    for players in ([R, Y], [R, G, Y], [R, G, Y, B]):
        for _ in range(20):
            g = LudoGame(players)
            for _ in range(20_000):
                if g.is_over:
                    break
                if g.phase == Phase.ROLL:
                    g.roll(rng.randint(1, 6))
                else:
                    g.move(bots.choose_piece(g))
            assert g.is_over and sorted(g.ranking) == sorted(players)
