"""Boards are graphs loaded from map JSON (see scripts/build_maps.py).

Each team walks its own *route*: a list of segments that starts on its start
tile, goes around the shared loop, then up a private home path to its goal.
A segment is either one tile, or a *region* offering several branches of
possibly different lengths (a short dangerous shortcut, a long safe road...).
A piece picks a branch when its move enters a region.

A piece's position is (progress, choices):

    progress -1               in camp (not in play)
    progress 0 .. finish-1    on the board
    progress finish           reached the goal
    choices                   {region id: branch index} for regions it entered

Its concrete path is the route with every region replaced by the chosen (or,
for regions not reached yet, the main) branch.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum
from functools import lru_cache
from pathlib import Path

MAPS_DIR = Path(__file__).parent / "maps"
CAMP = -1


class Color(StrEnum):
    RED = "red"
    GREEN = "green"
    YELLOW = "yellow"
    BLUE = "blue"


CLOCKWISE: tuple[Color, ...] = (Color.RED, Color.GREEN, Color.YELLOW, Color.BLUE)

# Tiles where nobody can be knocked out or targeted, and that never carry hazards.
IMMUNE_KINDS = frozenset({"start", "safe", "home", "goal"})
HAZARD_TYPES = frozenset(
    {"pit", "slide", "portal", "current", "crumble", "ice", "thin_ice", "spring", "anvil", "conveyor"}
)
Choices = dict[str, int]


@dataclass(frozen=True)
class Node:
    id: str
    kind: str
    pos: tuple[float, float, float]
    loop_index: int | None  # position on the shared loop (branch tiles get a proportional index)
    hazard: dict = field(default_factory=dict, hash=False, compare=False)


@dataclass(frozen=True)
class Branch:
    name: str
    tag: str
    nodes: tuple[str, ...]


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    branches: tuple[Branch, ...]


Segment = str | Region


def _choice_key(choices: Choices) -> tuple:
    return tuple(sorted(choices.items()))


class Board:
    def __init__(self, data: dict):
        self.data = data
        self.id: str = data["id"]
        self.name: str = data["name"]
        self.pieces_per_team: int = data.get("piecesPerTeam", 3)
        self.regions: dict[str, Region] = {
            rid: Region(
                rid,
                r.get("name", rid),
                tuple(
                    Branch(b.get("name", f"Route {i + 1}"), b.get("tag", ""), tuple(b["nodes"]))
                    for i, b in enumerate(r["branches"])
                ),
            )
            for rid, r in data.get("regions", {}).items()
        }

        # Loop indices: main tiles count up; branch tiles are spread over the main branch's span.
        loop_index: dict[str, int] = {}
        i = 0
        for entry in data["loop"]:
            if isinstance(entry, str):
                loop_index[entry] = i
                i += 1
                continue
            region = self.regions[entry["region"]]
            span = len(region.branches[0].nodes)
            for b in region.branches:
                n = len(b.nodes)
                for k, nid in enumerate(b.nodes):
                    loop_index[nid] = i + (round(k * (span - 1) / (n - 1)) if n > 1 else 0)
            i += span
        self.loop_length = i
        self.nodes: dict[str, Node] = {
            n["id"]: Node(n["id"], n["kind"], tuple(n["pos"]), loop_index.get(n["id"]), n.get("hazard") or {})
            for n in data["nodes"]
        }
        self.routes: dict[Color, list[Segment]] = {
            Color(c): [e if isinstance(e, str) else self.regions[e["region"]] for e in r]
            for c, r in data["routes"].items()
        }
        self.events: list[dict] = data.get("events", [])
        self._paths: dict[tuple, list[str]] = {}
        self._validate()

    # ------------------------------------------------------------------ validation
    def _validate(self) -> None:
        for color, route in self.routes.items():
            for seg in route:
                ids = [seg] if isinstance(seg, str) else [n for b in seg.branches for n in b.nodes]
                missing = [nid for nid in ids if nid not in self.nodes]
                if missing:
                    raise ValueError(f"{self.id}: route {color} references unknown nodes {missing[:3]}")
        for n in self.nodes.values():
            if not n.hazard:
                continue
            if n.hazard.get("type") not in HAZARD_TYPES:
                raise ValueError(f"{self.id}: unknown hazard on {n.id}: {n.hazard}")
            if n.kind in IMMUNE_KINDS:
                raise ValueError(f"{self.id}: hazard on protected tile {n.id}")
            if n.hazard["type"] == "portal" and n.hazard.get("to") not in self.nodes:
                raise ValueError(f"{self.id}: portal on {n.id} leads nowhere")

    # ------------------------------------------------------------------ paths
    @property
    def teams(self) -> list[Color]:
        return [c for c in CLOCKWISE if c in self.routes]

    def path(self, color: Color, choices: Choices | None = None) -> list[str]:
        """The concrete list of tiles a piece walks, given its branch choices."""
        choices = choices or {}
        key = (color, _choice_key(choices))
        cached = self._paths.get(key)
        if cached is None:
            cached = []
            for seg in self.routes[color]:
                if isinstance(seg, str):
                    cached.append(seg)
                else:
                    cached.extend(seg.branches[choices.get(seg.id, 0)].nodes)
            self._paths[key] = cached
        return cached

    def finish(self, color: Color, choices: Choices | None = None) -> int:
        return len(self.path(color, choices)) - 1

    def node(self, color: Color, progress: int, choices: Choices | None = None) -> Node | None:
        """The node a piece stands on, or None in camp."""
        if progress < 0:
            return None
        path = self.path(color, choices)
        return self.nodes[path[min(progress, len(path) - 1)]]

    def region_entries(self, color: Color, choices: Choices | None = None) -> list[tuple[Region, int]]:
        """(region, progress of its first tile) along this piece's path."""
        out, p = [], 0
        choices = choices or {}
        for seg in self.routes[color]:
            if isinstance(seg, str):
                p += 1
            else:
                out.append((seg, p))
                p += len(seg.branches[choices.get(seg.id, 0)].nodes)
        return out

    def trim(self, color: Color, progress: int, choices: Choices) -> Choices:
        """Forget branch choices for regions the piece is now behind (e.g. after a knockback)."""
        entries = {r.id: e for r, e in self.region_entries(color, choices)}
        return {rid: b for rid, b in choices.items() if rid in entries and entries[rid] <= progress}

    def locate(self, color: Color, node_id: str, choices: Choices | None = None) -> tuple[int, Choices] | None:
        """Where a tile sits on this team's route: (progress, choices needed to be there)."""
        choices = dict(choices or {})
        p = 0
        for seg in self.routes[color]:
            if isinstance(seg, str):
                if seg == node_id:
                    return p, self.trim(color, p, choices)
                p += 1
                continue
            for bi, branch in enumerate(seg.branches):
                if node_id in branch.nodes:
                    new = {**choices, seg.id: bi}
                    at = p + branch.nodes.index(node_id)
                    return at, self.trim(color, at, new)
            p += len(seg.branches[choices.get(seg.id, 0)].nodes)
        return None

    def forward_options(
        self, color: Color, progress: int, choices: Choices, steps: int
    ) -> list[tuple[int, Choices, int | None]]:
        """Where `steps` forward can take a piece: (progress, choices, branch picked or None)."""
        if progress < 0:
            return []
        target = progress + steps
        for region, entry in self.region_entries(color, choices):
            if region.id not in choices and progress < entry <= target:
                out = []
                for bi in range(len(region.branches)):
                    ch = {**choices, region.id: bi}
                    if target <= self.finish(color, ch):
                        out.append((target, ch, bi))
                return out
        return [(target, choices, None)] if target <= self.finish(color, choices) else []

    # ------------------------------------------------------------------ misc
    def is_immune(self, node: Node | None) -> bool:
        return node is None or node.kind in IMMUNE_KINDS

    def loop_distance(self, a: Node, b: Node) -> int | None:
        """Shortest number of steps between two shared-loop tiles."""
        if a.loop_index is None or b.loop_index is None:
            return None
        d = abs(a.loop_index - b.loop_index)
        return min(d, self.loop_length - d)

    def summary(self) -> dict:
        features = {n.hazard["type"] for n in self.nodes.values() if n.hazard}
        if self.regions:
            features.add("branches")
        features |= {e["type"] for e in self.events}
        return {
            "id": self.id,
            "name": self.name,
            "description": self.data.get("description", ""),
            "theme": self.data.get("theme", ""),
            "teams": [c.value for c in self.teams],
            "tiles": len(self.nodes),
            "piecesPerTeam": self.pieces_per_team,
            "features": sorted(features),
        }


@lru_cache
def load_board(map_id: str) -> Board:
    path = MAPS_DIR / f"{map_id}.json"
    if not path.is_file() or path.parent != MAPS_DIR:
        raise KeyError(map_id)
    return Board(json.loads(path.read_text(encoding="utf-8")))


def available_maps() -> list[Board]:
    order = {"emerald_wilds": 0, "molten_forge": 1, "frost_glacier": 2, "classic_arena": 3}
    return sorted((load_board(p.stem) for p in MAPS_DIR.glob("*.json")), key=lambda b: (order.get(b.id, 9), b.id))


DEFAULT_MAP = "emerald_wilds"
