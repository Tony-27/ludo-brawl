"""Generate the map JSON files in app/game/maps/.

Maps are data: node positions (world units, y-up), node kinds, each team's
route, camp slots and decoration hints for the client. Run:

    python scripts/build_maps.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "app" / "game" / "maps"
COLORS = ["red", "green", "yellow", "blue"]


def r3(v: float) -> float:
    return round(v, 3)


# --------------------------------------------------------------------- classic
def classic_arena() -> dict:
    # 52 shared squares on a 15x15 grid, clockwise from red's start.
    track = [
        (1, 6),
        (2, 6),
        (3, 6),
        (4, 6),
        (5, 6),
        (6, 5),
        (6, 4),
        (6, 3),
        (6, 2),
        (6, 1),
        (6, 0),
        (7, 0),
        (8, 0),
        (8, 1),
        (8, 2),
        (8, 3),
        (8, 4),
        (8, 5),
        (9, 6),
        (10, 6),
        (11, 6),
        (12, 6),
        (13, 6),
        (14, 6),
        (14, 7),
        (14, 8),
        (13, 8),
        (12, 8),
        (11, 8),
        (10, 8),
        (9, 8),
        (8, 9),
        (8, 10),
        (8, 11),
        (8, 12),
        (8, 13),
        (8, 14),
        (7, 14),
        (6, 14),
        (6, 13),
        (6, 12),
        (6, 11),
        (6, 10),
        (6, 9),
        (5, 8),
        (4, 8),
        (3, 8),
        (2, 8),
        (1, 8),
        (0, 8),
        (0, 7),
        (0, 6),
    ]
    start = {"red": 0, "green": 13, "yellow": 26, "blue": 39}
    home_cols = {
        "red": [(1, 7), (2, 7), (3, 7), (4, 7), (5, 7)],
        "green": [(7, 1), (7, 2), (7, 3), (7, 4), (7, 5)],
        "yellow": [(13, 7), (12, 7), (11, 7), (10, 7), (9, 7)],
        "blue": [(7, 13), (7, 12), (7, 11), (7, 10), (7, 9)],
    }
    goal_spot = {"red": (6.55, 7.5), "green": (7.5, 6.55), "yellow": (8.45, 7.5), "blue": (7.5, 8.45)}
    yard = {"red": (0, 0), "green": (9, 0), "yellow": (9, 9), "blue": (0, 9)}
    w = lambda gx, gy, y=0.0: [r3(gx - 7.5), r3(y), r3(gy - 7.5)]  # noqa: E731

    safe = {s for s in start.values()} | {(s + 8) % 52 for s in start.values()}
    nodes = []
    loop = []
    for i, (c, r) in enumerate(track):
        kind = "start" if i in start.values() else "safe" if i in safe else "normal"
        nid = f"t{i}"
        nodes.append({"id": nid, "pos": w(c + 0.5, r + 0.5), "kind": kind})
        loop.append(nid)

    routes, camps = {}, {}
    for color in COLORS:
        s = start[color]
        path = [f"t{(s + k) % 52}" for k in range(51)]
        for k, (c, r) in enumerate(home_cols[color]):
            nid = f"h_{color}_{k}"
            nodes.append({"id": nid, "pos": w(c + 0.5, r + 0.5, 0.08 + k * 0.1), "kind": "home"})
            path.append(nid)
        gid = f"goal_{color}"
        nodes.append({"id": gid, "pos": w(*goal_spot[color], 0.62), "kind": "goal"})
        path.append(gid)
        routes[color] = path
        ox, oy = yard[color]
        camps[color] = {
            "center": w(ox + 3, oy + 3),
            "slots": [w(ox + sx, oy + sy, 0.46) for sx, sy in [(2, 2), (4, 2), (2, 4), (4, 4)]],
        }

    return {
        "id": "classic_arena",
        "name": "Classic Arena",
        "description": "The original cross-shaped board, rebuilt as a stone arena.",
        "theme": "arena",
        "piecesPerTeam": 4,
        "nodes": nodes,
        "loop": loop,
        "routes": routes,
        "camps": camps,
        "goal": w(7.5, 7.5),
        "zones": [],
        "rivers": [],
        "bounds": 11,
    }


# --------------------------------------------------------------------- emerald
def emerald_wilds() -> dict:
    """A winding loop through four biomes around a temple, crossed by rivers."""
    n = 64
    quarter = n // 4
    start = {c: i * quarter for i, c in enumerate(COLORS)}
    biomes = {"red": "jungle", "green": "forest", "yellow": "ruins", "blue": "jungle"}

    def angle(i: float) -> float:
        # Clockwise when looking down (+y): increasing angle in x/z with x=cos, z=-sin.
        return math.pi * 0.75 - (i / n) * 2 * math.pi

    def radius(a: float) -> float:
        return 15.5 + 1.8 * math.sin(3 * a + 0.4) + 0.9 * math.cos(5 * a + 1.2)

    def point(i: float, r: float | None = None, y: float = 0.0) -> list[float]:
        a = angle(i)
        rr = radius(a) if r is None else r
        return [r3(math.cos(a) * rr), r3(y), r3(-math.sin(a) * rr)]

    bridges = set()
    for c in ("green", "blue"):
        s = start[c]
        bridges |= {s + 6, s + 7}

    nodes, loop = [], []
    for i in range(n):
        q = i % quarter
        kind = "start" if q == 0 else "safe" if q == 8 else "shrine" if q == 12 else "normal"
        lift = 0.35 if i in bridges else 0.12 * math.sin(i * 0.9) + 0.06
        node = {"id": f"t{i}", "pos": point(i, y=lift), "kind": kind}
        if i in bridges:
            node["bridge"] = True
        nodes.append(node)
        loop.append(f"t{i}")

    routes, camps = {}, {}
    for color in COLORS:
        s = start[color]
        path = [f"t{(s + k) % n}" for k in range(n - 1)]
        # Home path: spoke from just before the start tile into the temple.
        spoke = s - 1
        r_out = radius(angle(spoke)) - 2.2
        for k in range(5):
            rr = r_out - k * ((r_out - 4.2) / 4)
            nid = f"h_{color}_{k}"
            nodes.append({"id": nid, "pos": point(spoke, rr, 0.2 + k * 0.18), "kind": "home"})
            path.append(nid)
        gid = f"goal_{color}"
        nodes.append({"id": gid, "pos": point(spoke, 2.4, 1.3), "kind": "goal"})
        path.append(gid)
        routes[color] = path

        # Camp outside the loop, a little before the start tile.
        ca = angle(s - 1.5)
        cr = radius(ca) + 6.5
        cx, cz = math.cos(ca) * cr, -math.sin(ca) * cr
        # Four slots in a 2x2 square facing the track.
        fx, fz = math.cos(ca), -math.sin(ca)  # outward
        sx, sz = -fz, fx  # sideways
        slots = [
            [r3(cx + sx * dx * 1.4 + fx * dy * 1.4), 0.5, r3(cz + sz * dx * 1.4 + fz * dy * 1.4)]
            for dx, dy in [(-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)]
        ]
        camps[color] = {"center": [r3(cx), 0.0, r3(cz)], "slots": slots}

    # Rivers flow outwards from the temple lake, under each pair of bridges.
    rivers = []
    for c in ("green", "blue"):
        mid = start[c] + 6.5
        a = angle(mid)
        pts = []
        for k in range(9):
            rr = 5.5 + k * 4.2
            wobble = math.sin(k * 1.3) * 0.08
            pts.append([r3(math.cos(a + wobble) * rr), r3(-math.sin(a + wobble) * rr)])
        rivers.append({"points": pts, "width": 2.6})

    zones = [{"from": start[c], "to": start[c] + quarter - 1, "biome": biomes[c]} for c in COLORS]

    return {
        "id": "emerald_wilds",
        "name": "Emerald Wilds",
        "description": "A winding trail through jungle, forest and ancient ruins, crossed by rivers.",
        "theme": "wilds",
        "piecesPerTeam": 4,
        "nodes": nodes,
        "loop": loop,
        "routes": routes,
        "camps": camps,
        "goal": [0.0, 1.2, 0.0],
        "zones": zones,
        "rivers": rivers,
        "bounds": 28,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for m in (classic_arena(), emerald_wilds()):
        (OUT / f"{m['id']}.json").write_text(json.dumps(m, indent=1) + "\n", encoding="utf-8")
        print("wrote", m["id"], len(m["nodes"]), "nodes")


if __name__ == "__main__":
    main()
