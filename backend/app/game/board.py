"""Boards are graphs loaded from map JSON (see scripts/build_maps.py).

Each team walks its own *route*: an ordered list of node ids that starts on
its start tile, goes around the shared loop, then up a private home path to
its goal. A piece's position is its *progress* index into that route:

    -1                in camp (not in play)
    0 .. finish-1     on the board
    finish            reached the goal
"""

from __future__ import annotations

import json
from dataclasses import dataclass
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

# Tiles where nobody can be knocked out or targeted.
IMMUNE_KINDS = frozenset({"start", "safe", "home", "goal"})


@dataclass(frozen=True)
class Node:
    id: str
    kind: str
    pos: tuple[float, float, float]
    loop_index: int | None  # position on the shared loop, None for private tiles


class Board:
    def __init__(self, data: dict):
        self.data = data
        self.id: str = data["id"]
        self.name: str = data["name"]
        self.pieces_per_team: int = data.get("piecesPerTeam", 4)
        loop_ids: list[str] = data["loop"]
        loop_pos = {nid: i for i, nid in enumerate(loop_ids)}
        self.nodes: dict[str, Node] = {
            n["id"]: Node(n["id"], n["kind"], tuple(n["pos"]), loop_pos.get(n["id"])) for n in data["nodes"]
        }
        self.loop_length = len(loop_ids)
        self.routes: dict[Color, list[str]] = {Color(c): r for c, r in data["routes"].items()}
        for color, route in self.routes.items():
            missing = [nid for nid in route if nid not in self.nodes]
            if missing:
                raise ValueError(f"{self.id}: route {color} references unknown nodes {missing[:3]}")

    @property
    def teams(self) -> list[Color]:
        return [c for c in CLOCKWISE if c in self.routes]

    def finish(self, color: Color) -> int:
        return len(self.routes[color]) - 1

    def node(self, color: Color, progress: int) -> Node | None:
        """The node a piece stands on, or None in camp."""
        if progress < 0:
            return None
        return self.nodes[self.routes[color][progress]]

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
        }


@lru_cache
def load_board(map_id: str) -> Board:
    path = MAPS_DIR / f"{map_id}.json"
    if not path.is_file() or path.parent != MAPS_DIR:
        raise KeyError(map_id)
    return Board(json.loads(path.read_text(encoding="utf-8")))


def available_maps() -> list[Board]:
    return [load_board(p.stem) for p in sorted(MAPS_DIR.glob("*.json"))]


DEFAULT_MAP = "emerald_wilds"
