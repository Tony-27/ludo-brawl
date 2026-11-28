"""Balance report: bots play many matches and we tally how each hero does.

    python scripts/balance.py --games 200 --map molten_forge

Prints win rate, average placement and ability usage per hero, plus match
length per map. Bots are not perfect players, so read results as trends.
"""

from __future__ import annotations

import argparse
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.game import bots  # noqa: E402
from app.game.board import available_maps, load_board  # noqa: E402
from app.game.heroes import ABILITIES, HEROES  # noqa: E402
from app.game.rules import Match  # noqa: E402


def forced_move(m: Match, branch: int) -> bots.BotAction:
    """Best move for a player that strongly prefers one branch at forks (but isn't suicidal)."""
    options = m.move_options()
    scored = [
        ((bots._try(m, lambda s, o=o: s.move(o.piece, o.lane)) or float("-inf")) + (25 if o.lane == branch else 0), o)
        for o in options
    ]
    o = max(scored, key=lambda x: x[0])[1]
    return bots.BotAction("move", piece=o.piece, lane=o.lane)


def play(map_id: str, heroes: dict, seed: int, max_turns: int = 4000, force: dict | None = None):
    rng = random.Random(seed)
    board = load_board(map_id)
    m = Match(board, heroes, rng=rng)
    casts: Counter = Counter()
    routes: Counter = Counter()
    while not m.is_over and m.turn < max_turns:
        a = bots.choose_action(m, rng)
        if a.kind == "move" and force and m.current in force:
            a = forced_move(m, force[m.current])
        if a.kind == "cast":
            casts[a.ability] += 1
            m.cast(a.ability, a.target)
        elif a.kind == "roll":
            m.roll(rng.randint(1, 6))
        elif a.kind == "end":
            m.end_turn()
        else:
            if a.lane is not None:
                region = next(r for r in board.regions.values() if len(r.branches) > a.lane)
                routes[region.branches[a.lane].name] += 1
            m.move(a.piece, a.lane)
    return m, casts, routes


def route_test(board, games: int, rng: random.Random) -> None:
    """One player always takes branch k, the others play normally: how often does it win?"""
    pool = [h.id for h in HEROES.values() if h.selectable]
    names = [b.name for b in next(iter(board.regions.values())).branches]
    colors = board.teams
    print(f"\nRoute test on {board.name} ({games} games per route, fair win rate {100 / len(colors):.0f}%):")
    for k, name in enumerate(names):
        wins = 0
        for g in range(games):
            heroes = {c: pool[(g + i) % len(pool)] for i, c in enumerate(colors)}
            forced = colors[g % len(colors)]
            m, _, _ = play(board.id, heroes, rng.randrange(1 << 30), force={forced: k})
            wins += m.ranking[0] == forced
        print(f"  prefers {name:<16} wins {100 * wins / games:5.1f}%")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=120, help="matches per map")
    ap.add_argument("--map", default=None, help="only this map id")
    ap.add_argument("--players", type=int, default=4)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--routes", action="store_true", help="also test each route against normal bots")
    args = ap.parse_args()

    pool = [h for h in HEROES.values() if h.selectable]
    maps = [load_board(args.map)] if args.map else available_maps()
    rng = random.Random(args.seed)
    wins: Counter = Counter()
    games: Counter = Counter()
    places: dict[str, list[int]] = defaultdict(list)
    casts: Counter = Counter()
    lengths: dict[str, list[int]] = defaultdict(list)
    route_picks: dict[str, Counter] = defaultdict(Counter)
    t0 = time.time()

    for board in maps:
        colors = board.teams[: args.players]
        for _ in range(args.games):
            picks = rng.sample(pool, k=len(colors)) if len(pool) >= len(colors) else rng.choices(pool, k=len(colors))
            heroes = {c: h.id for c, h in zip(colors, picks, strict=True)}
            m, c, r = play(board.id, heroes, rng.randrange(1 << 30))
            casts.update(c)
            route_picks[board.id].update(r)
            lengths[board.id].append(m.turn)
            for place, color in enumerate(m.ranking, start=1):
                hero = heroes[color]
                games[hero] += 1
                places[hero].append(place)
                if place == 1:
                    wins[hero] += 1

    n = len(colors)
    print(f"\n{sum(len(v) for v in lengths.values())} matches, {n} players each, {time.time() - t0:.0f}s\n")
    print(f"{'Hero':<14}{'Games':>7}{'Win %':>8}{'Avg place':>11}   (fair win rate is {100 / n:.0f}%)")
    for hero in sorted(games, key=lambda h: -wins[h] / max(1, games[h])):
        avg = sum(places[hero]) / len(places[hero])
        print(f"{HEROES[hero].name:<14}{games[hero]:>7}{100 * wins[hero] / games[hero]:>7.1f}%{avg:>11.2f}")
    print("\nAbility casts per match:")
    total = sum(len(v) for v in lengths.values())
    for h in pool:
        row = "  ".join(f"{ABILITIES[a].name} {casts[a] / max(1, total):.2f}" for a in h.abilities)
        print(f"  {h.name:<13} {row}")
    print("\nMatch length (turns):")
    for mid, ls in lengths.items():
        ls.sort()
        print(f"  {mid:<14} median {ls[len(ls) // 2]:>4}   p90 {ls[int(len(ls) * 0.9)]:>4}")
    for mid, picks in route_picks.items():
        if picks:
            total_picks = sum(picks.values())
            row = "  ".join(f"{k} {100 * v / total_picks:.0f}%" for k, v in picks.most_common())
            print(f"\nRoute picks on {mid}: {row}")
    if args.routes:
        for board in maps:
            if board.regions:
                route_test(board, max(20, args.games // 2), rng)


if __name__ == "__main__":
    main()
