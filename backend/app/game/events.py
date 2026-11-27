"""Domain events. The engine emits these; clients replay them as animations.

Every event is a small pydantic model with a literal `type`, so the union
below can be exported to JSON Schema and turned into TypeScript types.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from .board import Color


class _Event(BaseModel):
    model_config = ConfigDict(frozen=True)


class TurnStarted(_Event):
    type: Literal["turnStarted"] = "turnStarted"
    color: Color
    turn: int


class ManaChanged(_Event):
    type: Literal["manaChanged"] = "manaChanged"
    color: Color
    mana: int
    delta: int
    reason: Literal["turn", "rolledOne", "shrine", "knockedOut", "knockedBack", "cast", "passive"]


class Rolled(_Event):
    type: Literal["rolled"] = "rolled"
    color: Color
    value: int


class TurnPassed(_Event):
    type: Literal["turnPassed"] = "turnPassed"
    color: Color
    reason: Literal["noMoves", "threeSixes"]


class Moved(_Event):
    type: Literal["moved"] = "moved"
    color: Color
    piece: int
    start: int = Field(alias="from")
    end: int = Field(alias="to")
    path: list[int]
    model_config = ConfigDict(frozen=True, populate_by_name=True)


class Captured(_Event):
    """A piece was landed on and sent back to its camp."""

    type: Literal["captured"] = "captured"
    color: Color
    piece: int
    byColor: Color
    byPiece: int
    at: int  # victim's progress before capture


class AbilityCast(_Event):
    type: Literal["abilityCast"] = "abilityCast"
    color: Color
    hero: str
    ability: str
    piece: int | None = None
    targetColor: Color | None = None
    targetPiece: int | None = None
    tiles: list[str] = []  # node ids the effect covers (for VFX)


class KnockedBack(_Event):
    type: Literal["knockedBack"] = "knockedBack"
    color: Color
    piece: int
    start: int = Field(alias="from")
    end: int = Field(alias="to")
    byColor: Color
    ability: str
    model_config = ConfigDict(frozen=True, populate_by_name=True)


class Teleported(_Event):
    type: Literal["teleported"] = "teleported"
    color: Color
    piece: int
    start: int = Field(alias="from")
    end: int = Field(alias="to")
    model_config = ConfigDict(frozen=True, populate_by_name=True)


class Blocked(_Event):
    """An attack hit a piece that was protected."""

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
    | Blocked
    | StatusChanged
    | PieceFinished
    | PlayerFinished
    | GameOver,
    Field(discriminator="type"),
]


def dump(events: list[_Event]) -> list[dict]:
    return [e.model_dump(mode="json", by_alias=True) for e in events]
