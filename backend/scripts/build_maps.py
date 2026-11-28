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
            "slots": [w(ox + sx, oy + sy, 0.46) for sx, sy in [(2, 2), (4, 2), (3, 4)]],
        }

    return {
        "id": "classic_arena",
        "name": "Classic Arena",
        "description": "The original cross-shaped board, rebuilt as a stone arena.",
        "theme": "arena",
        "piecesPerTeam": 3,
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
            for dx, dy in [(-0.6, -0.4), (0.6, -0.4), (0.0, 0.55)]
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
        "piecesPerTeam": 3,
        "nodes": nodes,
        "loop": loop,
        "routes": routes,
        "camps": camps,
        "goal": [0.0, 1.2, 0.0],
        "zones": zones,
        "rivers": rivers,
        "bounds": 28,
    }


# --------------------------------------------------------------------- ring maps with route choices
def ring_map(
    *,
    n: int,
    radius,
    region_at: int,
    span: int,
    branches: list[dict],
    main_tile,
    region_name: str,
) -> dict:
    """A loop of `n` spine tiles split in four quarters. In every quarter the
    spine tiles `region_at .. region_at+span-1` form a region whose branch 0
    lies on the spine; the other branches curve inwards / outwards with their
    own length. `main_tile(q, owner)` decorates spine tiles outside regions,
    each branch's `tile(k, m, owner)` decorates branch tiles."""
    quarter = n // 4
    start = {c: i * quarter for i, c in enumerate(COLORS)}

    def angle(i: float) -> float:
        return math.pi * 0.75 - (i / n) * 2 * math.pi

    def point(i: float, r: float | None = None, y: float = 0.0) -> list[float]:
        a = angle(i)
        rr = radius(a) if r is None else r
        return [r3(math.cos(a) * rr), r3(y), r3(-math.sin(a) * rr)]

    nodes: list[dict] = []
    loop: list = []
    regions: dict[str, dict] = {}
    for _qi, owner in enumerate(COLORS):
        base = start[owner]
        q = 0
        while q < quarter:
            i = base + q
            if q == region_at:
                rid = f"{owner}_pass"
                lo, hi = i - 1, i + span  # spine anchors around the region
                region = {"name": region_name, "branches": []}
                for bi, b in enumerate(branches):
                    m = span if bi == 0 else b["length"]
                    ids = []
                    for k in range(m):
                        t = (k + 1) / (m + 1)
                        idx = lo + t * (hi - lo)
                        nid = f"{b['id']}_{owner}_{k}"
                        if bi == 0:
                            nid = f"t{i + k}"
                            r = None
                        else:
                            r = radius(angle(idx)) + b["bulge"] * math.sin(math.pi * t)
                        node = {
                            "id": nid,
                            "pos": point(i + k if bi == 0 else idx, r, b.get("y", 0.12)),
                            "kind": "normal",
                        }
                        node.update(b["tile"](k, m, owner))
                        nodes.append(node)
                        ids.append(nid)
                    region["branches"].append({"name": b["name"], "tag": b["tag"], "nodes": ids})
                regions[rid] = region
                loop.append({"region": rid})
                q += span
                continue
            node = {"id": f"t{i}", "pos": point(i, y=0.1), "kind": "start" if q == 0 else "normal"}
            node.update(main_tile(q, owner))
            nodes.append(node)
            loop.append(node["id"])
            q += 1

    routes, camps = {}, {}
    for color in COLORS:
        s = loop.index(f"t{start[color]}")
        path = [loop[(s + k) % len(loop)] for k in range(len(loop) - 1)]
        spoke = start[color] - 1
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
        ca = angle(start[color] - 1.5)
        cr = radius(ca) + 6.5
        cx, cz = math.cos(ca) * cr, -math.sin(ca) * cr
        fx, fz = math.cos(ca), -math.sin(ca)
        sx, sz = -fz, fx
        camps[color] = {
            "center": [r3(cx), 0.0, r3(cz)],
            "slots": [
                [r3(cx + sx * dx * 1.4 + fx * dy * 1.4), 0.5, r3(cz + sz * dx * 1.4 + fz * dy * 1.4)]
                for dx, dy in [(-0.6, -0.4), (0.6, -0.4), (0.0, 0.55)]
            ],
        }
    return {
        "nodes": nodes,
        "loop": loop,
        "regions": regions,
        "routes": routes,
        "camps": camps,
        "start": start,
        "angle": angle,
        "point": point,
        "quarter": quarter,
    }


def _flow(angle, at: float, *, inner: float = 5.5, step: float = 4.2, kind: str = "water", width: float = 2.2) -> dict:
    a = angle(at)
    pts = []
    for k in range(9):
        rr = inner + k * step
        wobble = math.sin(k * 1.7) * 0.07
        pts.append([r3(math.cos(a + wobble) * rr), r3(-math.sin(a + wobble) * rr)])
    return {"points": pts, "width": width, "kind": kind}


# --------------------------------------------------------------------- forge
def molten_forge() -> dict:
    """Volcanic fortress. Every quarter offers three routes that merge again at
    a chokepoint: the short Lava Bridge (crumbles, erupts), the Forge Tunnel
    (conveyors that flip every round, an anvil) and the long, safe Outer Ridge."""
    n, region_at, span = 64, 3, 7

    def main_tile(q: int, owner: str) -> dict:
        if q == 10:
            return {"kind": "safe"}  # the chokepoint where the three routes merge
        if q == 12:
            return {"kind": "shrine"}
        if q == 14 and owner in ("green", "blue"):
            return {"hazard": {"type": "portal", "to": f"t{(COLORS.index(owner) * 16 + 16 + 1) % n}"}}
        return {}

    def tunnel(k: int, m: int, owner: str) -> dict:
        if k in (1, 4):
            return {"hazard": {"type": "conveyor", "steps": 2}}
        if k == 3:
            return {"hazard": {"type": "anvil"}}
        return {}

    def bridge(k: int, m: int, owner: str) -> dict:
        return {"hazard": {"type": "crumble", "uses": 4}, "bridge": True}

    def ridge(k: int, m: int, owner: str) -> dict:
        if k == 3:
            return {"kind": "shrine"}
        if k == 6:
            return {"kind": "safe"}
        if k == 7:
            return {"kind": "shrine"}
        return {}

    def radius(a: float) -> float:
        return 17.0 + 1.0 * math.sin(4 * a + 0.3)

    ring = ring_map(
        n=n,
        radius=radius,
        region_at=region_at,
        span=span,
        region_name="Forge Crossing",
        main_tile=main_tile,
        branches=[
            {"id": "tun", "name": "Forge Tunnel", "tag": "medium · conveyors · anvil", "tile": tunnel},
            {
                "id": "lav",
                "name": "Lava Bridge",
                "tag": "shortest · crumbles · erupts",
                "length": 4,
                "bulge": -4.2,
                "y": 0.5,
                "tile": bridge,
            },
            {
                "id": "rdg",
                "name": "Outer Ridge",
                "tag": "longest · safe · 2 shrines",
                "length": 9,
                "bulge": 4.4,
                "y": 0.35,
                "tile": ridge,
            },
        ],
    )
    angle = ring["angle"]
    bridges = [nid for r in ring["regions"].values() for nid in r["branches"][1]["nodes"]]
    conveyors = [x["id"] for x in ring["nodes"] if x.get("hazard", {}).get("type") == "conveyor"]
    events = [
        {"type": "eruption", "every": 3, "offset": 0, "knockback": 5, "tiles": bridges},
        {"type": "conveyor", "every": 1, "tiles": conveyors},
    ]
    rivers = [
        _flow(angle, ring["start"][c] + region_at + span / 2 - 0.5, inner=5.0, step=1.6, kind="lava", width=2.6)
        for c in COLORS
    ]
    return {
        "id": "molten_forge",
        "name": "Molten Forge",
        "description": "Three routes in every quarter: a crumbling Lava Bridge that erupts every 3 rounds, "
        "the Forge Tunnel with flipping conveyors, or the long, safe Outer Ridge.",
        "theme": "forge",
        "piecesPerTeam": 3,
        "nodes": ring["nodes"],
        "loop": ring["loop"],
        "regions": ring["regions"],
        "routes": ring["routes"],
        "events": events,
        "camps": ring["camps"],
        "goal": [0.0, 1.2, 0.0],
        "zones": [{"from": ring["start"][c], "to": ring["start"][c] + 15, "biome": "volcanic"} for c in COLORS],
        "rivers": rivers,
        "bounds": 31,
    }


# --------------------------------------------------------------------- frost
def frost_glacier() -> dict:
    """Frozen highlands. Every quarter: the icy Snowfield Trail, a Frozen Lake
    shortcut that is only open while frozen, or the long Hot Springs path.
    Avalanches sweep the cliff path every 4 rounds."""
    n, region_at, span = 64, 3, 7

    def main_tile(q: int, owner: str) -> dict:
        if q == 10:
            return {"kind": "safe"}
        if q in (12, 13, 14):
            return {"cliff": True}  # avalanche lane
        if q == 11:
            return {"kind": "shrine"}
        return {}

    def trail(k: int, m: int, owner: str) -> dict:
        if k in (1, 2, 4):
            return {"hazard": {"type": "ice"}}
        return {}

    def lake(k: int, m: int, owner: str) -> dict:
        return {"hazard": {"type": "thin_ice", "uses": 3}, "lake": True}

    def springs(k: int, m: int, owner: str) -> dict:
        if k in (2, 6):
            return {"hazard": {"type": "spring"}}
        if k == 4:
            return {"kind": "safe"}
        return {}

    def radius(a: float) -> float:
        return 17.0 + 1.6 * math.sin(3 * a + 0.9)

    ring = ring_map(
        n=n,
        radius=radius,
        region_at=region_at,
        span=span,
        region_name="Glacier Pass",
        main_tile=main_tile,
        branches=[
            {"id": "snw", "name": "Snowfield Trail", "tag": "medium · ice sheets", "tile": trail},
            {
                "id": "lak",
                "name": "Frozen Lake",
                "tag": "shortest · open while frozen · thin ice",
                "length": 3,
                "bulge": -4.6,
                "y": 0.02,
                "tile": lake,
            },
            {
                "id": "spr",
                "name": "Hot Springs",
                "tag": "longest · safe · mana springs",
                "length": 9,
                "bulge": 4.2,
                "y": 0.25,
                "tile": springs,
            },
        ],
    )
    angle = ring["angle"]
    events = []
    for k, (rid, region) in enumerate(ring["regions"].items()):
        events.append(
            {
                "type": "freeze",
                "region": rid,
                "branch": 1,
                "cycle": [3, 2],
                "offset": k % 2 * 2,
                "tiles": region["branches"][1]["nodes"],
            }
        )
    cliffs = [x["id"] for x in ring["nodes"] if x.get("cliff")]
    events.append({"type": "avalanche", "every": 4, "offset": 2, "knockback": 4, "tiles": cliffs})
    lakes = [
        {
            "center": ring["point"](
                ring["start"][c] + region_at + span / 2 - 0.5,
                radius(angle(ring["start"][c] + region_at + span / 2 - 0.5)) - 4.6,
            )[::2],
            "radius": 3.4,
        }
        for c in COLORS
    ]
    return {
        "id": "frost_glacier",
        "name": "Frost Glacier",
        "description": "Frozen highlands under the aurora: slide across ice, dash over a frozen lake while it holds, "
        "or warm up at the hot springs. Watch for avalanches.",
        "theme": "frost",
        "piecesPerTeam": 3,
        "nodes": ring["nodes"],
        "loop": ring["loop"],
        "regions": ring["regions"],
        "routes": ring["routes"],
        "events": events,
        "camps": ring["camps"],
        "goal": [0.0, 1.2, 0.0],
        "zones": [{"from": ring["start"][c], "to": ring["start"][c] + 15, "biome": "glacier"} for c in COLORS],
        "rivers": [],
        "lakes": lakes,
        "bounds": 31,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for m in (classic_arena(), emerald_wilds(), molten_forge(), frost_glacier()):
        (OUT / f"{m['id']}.json").write_text(json.dumps(m, indent=1) + "\n", encoding="utf-8")
        print("wrote", m["id"], len(m["nodes"]), "nodes")


if __name__ == "__main__":
    main()
