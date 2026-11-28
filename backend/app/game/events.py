"""Domain events. The engine emits these; clients replay them as animations.

Every event is a small pydantic model with a literal `type`, so the union
below can be exported to JSON Schema and turned into TypeScript types.
Positions are (progress, lane) on the piece's own route; see board.py.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from .board import Color


class _Event(BaseModel):
    model_config = ConfigDict(frozen=True, populate_by_name=True)


class _Travel(_Event):
    """Base for events that move one piece from one spot to another."""

    color: Color
    piece: int
    start: int = Field(alias="from")
    end: int = Field(alias="to")
    lane: int = 0


class TurnStarted(_Event):
    type: Literal["turnStarted"] = "turnStarted"
    color: Color
    turn: int


class ManaChanged(_Event):
    type: Literal["manaChanged"] = "manaChanged"
    color: Color
    mana: int
    delta: int
    reason: Literal["turn", "rolledOne", "shrine", "knockedOut", "knockedBack", "cast", "passive", "burned", "practice"]


class Rolled(_Event):
    type: Literal["rolled"] = "rolled"
    color: Color
    value: int


class TurnPassed(_Event):
    type: Literal["turnPassed"] = "turnPassed"
    color: Color
    reason: Literal["noMoves", "threeSixes"]


class Moved(_Travel):
    type: Literal["moved"] = "moved"
    path: list[int]
    via: Literal["roll", "dash", "rally"] = "roll"


class Captured(_Event):
    """A piece was landed on and sent back to its camp."""

    type: Literal["captured"] = "captured"
    color: Color
    piece: int
    byColor: Color
    byPiece: int
    at: int


class AbilityCast(_Event):
    type: Literal["abilityCast"] = "abilityCast"
    color: Color
    hero: str
    ability: str
    piece: int | None = None
    targetColor: Color | None = None
    targetPiece: int | None = None
    tiles: list[str] = []  # node ids the effect covers (for VFX)


class KnockedBack(_Travel):
    type: Literal["knockedBack"] = "knockedBack"
    byColor: Color
    ability: str


class Teleported(_Travel):
    type: Literal["teleported"] = "teleported"


class Swapped(_Event):
    type: Literal["swapped"] = "swapped"
    color: Color
    piece: int
    to: int
    lane: int
    otherColor: Color
    otherPiece: int
    otherTo: int
    otherLane: int


class Fell(_Event):
    """Fell into a pit or crater: back to camp."""

    type: Literal["fell"] = "fell"
    color: Color
    piece: int
    at: int
    tile: str


class Slid(_Travel):
    type: Literal["slid"] = "slid"


class Portaled(_Travel):
    type: Literal["portaled"] = "portaled"


class Drifted(_Travel):
    type: Literal["drifted"] = "drifted"


class TileChanged(_Event):
    """A tile gained or lost a temporary effect (or a bridge broke for good)."""

    type: Literal["tileChanged"] = "tileChanged"
    tile: str
    effect: Literal["broken", "crater", "fire", "trap", "none"]
    turns: int | None = None
    owner: Color | None = None


class Blocked(_Event):
    """An attack or fall hit a piece that was protected."""

    type: Literal["blocked"] = "blocked"
    color: Color
    piece: int
    reason: Literal["safeTile", "shield"]


class StatusChanged(_Event):
    type: Literal["statusChanged"] = "statusChanged"
    color: Color
    piece: int
    status: Literal["shield", "rooted"]
    active: bool


class PieceFinished(_Event):
    type: Literal["pieceFinished"] = "pieceFinished"
    color: Color
    piece: int


class PlayerFinished(_Event):
    type: Literal["playerFinished"] = "playerFinished"
    color: Color
    place: int


class GameOver(_Event):
    type: Literal["gameOver"] = "gameOver"
    ranking: list[Color]


GameEvent = Annotated[
    TurnStarted
    | ManaChanged
    | Rolled
    | TurnPassed
    | Moved
    | Captured
    | AbilityCast
    | KnockedBack
    | Teleported
    | Swapped
    | Fell
    | Slid
    | Portaled
    | Drifted
    | TileChanged
    | Blocked
    | StatusChanged
    | PieceFinished
    | PlayerFinished
    | GameOver,
    Field(discriminator="type"),
]


def dump(events: list[_Event]) -> list[dict]:
    return [e.model_dump(mode="json", by_alias=True) for e in events]
