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


def play(map_id: str, heroes: dict, seed: int, max_turns: int = 4000):
    rng = random.Random(seed)
    m = Match(load_board(map_id), heroes, rng=rng)
    casts: Counter = Counter()
    while not m.is_over and m.turn < max_turns:
        a = bots.choose_action(m, rng)
        if a.kind == "cast":
            casts[a.ability] += 1
            m.cast(a.ability, a.target)
        elif a.kind == "roll":
            m.roll(rng.randint(1, 6))
        else:
            m.move(a.piece, a.lane)
    return m, casts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=120, help="matches per map")
    ap.add_argument("--map", default=None, help="only this map id")
    ap.add_argument("--players", type=int, default=4)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    pool = [h for h in HEROES.values() if h.selectable]
    maps = [load_board(args.map)] if args.map else available_maps()
    rng = random.Random(args.seed)
    wins: Counter = Counter()
    games: Counter = Counter()
    places: dict[str, list[int]] = defaultdict(list)
    casts: Counter = Counter()
    lengths: dict[str, list[int]] = defaultdict(list)
    t0 = time.time()

    for board in maps:
        colors = board.teams[: args.players]
        for _ in range(args.games):
            picks = rng.sample(pool, k=len(colors)) if len(pool) >= len(colors) else rng.choices(pool, k=len(colors))
            heroes = {c: h.id for c, h in zip(colors, picks, strict=True)}
            m, c = play(board.id, heroes, rng.randrange(1 << 30))
            casts.update(c)
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


if __name__ == "__main__":
    main()
