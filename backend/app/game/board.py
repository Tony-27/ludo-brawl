"""Boards are graphs loaded from map JSON (see scripts/build_maps.py).

Each team walks its own *route*: an ordered list of steps that starts on its
start tile, goes around the shared loop, then up a private home path to its
goal. A step is usually one tile; inside a *fork* a step offers two parallel
lanes (lane 0 = main, lane 1 = alternative), and a piece stays in the lane it
picked until the fork ends.

A piece's position is (progress, lane):

    progress -1               in camp (not in play)
    progress 0 .. finish-1    on the board
    progress finish           reached the goal
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
HAZARD_TYPES = frozenset({"pit", "slide", "portal", "current", "crumble"})


@dataclass(frozen=True)
class Node:
    id: str
    kind: str
    pos: tuple[float, float, float]
    loop_index: int | None  # position on the shared loop, None for private tiles
    lane: int = 0
    hazard: dict = field(default_factory=dict, hash=False, compare=False)


def _step(entry: str | list[str]) -> tuple[str, ...]:
    return tuple(entry) if isinstance(entry, list) else (entry,)


class Board:
    def __init__(self, data: dict):
        self.data = data
        self.id: str = data["id"]
        self.name: str = data["name"]
        self.pieces_per_team: int = data.get("piecesPerTeam", 3)
        loop_steps = [_step(e) for e in data["loop"]]
        loop_pos: dict[str, tuple[int, int]] = {}
        for i, step in enumerate(loop_steps):
            for lane, nid in enumerate(step):
                loop_pos[nid] = (i, lane)
        self.nodes: dict[str, Node] = {}
        for n in data["nodes"]:
            idx, lane = loop_pos.get(n["id"], (None, n.get("lane", 0)))
            self.nodes[n["id"]] = Node(n["id"], n["kind"], tuple(n["pos"]), idx, lane, n.get("hazard") or {})
        self.loop_length = len(loop_steps)
        self.routes: dict[Color, list[tuple[str, ...]]] = {
            Color(c): [_step(e) for e in r] for c, r in data["routes"].items()
        }
        self._validate()

    def _validate(self) -> None:
        for color, route in self.routes.items():
            for step in route:
                missing = [nid for nid in step if nid not in self.nodes]
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

    @property
    def teams(self) -> list[Color]:
        return [c for c in CLOCKWISE if c in self.routes]

    def finish(self, color: Color) -> int:
        return len(self.routes[color]) - 1

    def is_fork(self, color: Color, progress: int) -> bool:
        return 0 <= progress < len(self.routes[color]) and len(self.routes[color][progress]) > 1

    def node(self, color: Color, progress: int, lane: int = 0) -> Node | None:
        """The node a piece stands on, or None in camp."""
        if progress < 0:
            return None
        step = self.routes[color][progress]
        return self.nodes[step[min(lane, len(step) - 1)]]

    def locate(self, color: Color, node_id: str) -> tuple[int, int] | None:
        """(progress, lane) of a node on this team's route, if it is on it."""
        for i, step in enumerate(self.routes[color]):
            if node_id in step:
                return i, step.index(node_id)
        return None

    def lane_after(self, color: Color, start: int, start_lane: int, end: int, chosen: int | None) -> int:
        """Lane a piece ends in after moving from `start` to `end` (either direction)."""
        if not self.is_fork(color, end):
            return 0
        lo, hi = sorted((max(start, 0), end))
        stayed = start >= 0 and all(self.is_fork(color, p) for p in range(lo, hi + 1))
        if stayed:
            return start_lane
        return chosen if chosen in (0, 1) else 0

    def needs_lane_choice(self, color: Color, start: int, end: int) -> bool:
        if not self.is_fork(color, end):
            return False
        return not (start >= 0 and all(self.is_fork(color, p) for p in range(start, end + 1)))

    def is_immune(self, node: Node | None) -> bool:
        return node is None or node.kind in IMMUNE_KINDS

    def loop_distance(self, a: Node, b: Node) -> int | None:
        """Shortest number of steps between two shared-loop tiles."""
        if a.loop_index is None or b.loop_index is None:
            return None
        d = abs(a.loop_index - b.loop_index)
        return min(d, self.loop_length - d)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.data.get("description", ""),
            "theme": self.data.get("theme", ""),
            "teams": [c.value for c in self.teams],
            "tiles": len(self.nodes),
            "piecesPerTeam": self.pieces_per_team,
            "features": sorted({n.hazard["type"] for n in self.nodes.values() if n.hazard})
            + (["forks"] if any(len(s) > 1 for r in self.routes.values() for s in r) else []),
        }


@lru_cache
def load_board(map_id: str) -> Board:
    path = MAPS_DIR / f"{map_id}.json"
    if not path.is_file() or path.parent != MAPS_DIR:
        raise KeyError(map_id)
    return Board(json.loads(path.read_text(encoding="utf-8")))


def available_maps() -> list[Board]:
    order = {"emerald_wilds": 0, "molten_forge": 1, "classic_arena": 2}
    return sorted((load_board(p.stem) for p in MAPS_DIR.glob("*.json")), key=lambda b: (order.get(b.id, 9), b.id))


DEFAULT_MAP = "emerald_wilds"
