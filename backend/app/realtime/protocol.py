"""Wire protocol: everything the server sends and accepts, as pydantic models.

`scripts/gen_protocol.py` exports these to JSON Schema and the frontend turns
that into TypeScript (`npm run gen:protocol`), so both sides share one source
of truth. Bump PROTOCOL_VERSION on breaking changes.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from ..game.board import Color
from ..game.events import GameEvent

PROTOCOL_VERSION = 1


# ---------------------------------------------------------------- views
class PlayerView(BaseModel):
    id: str
    name: str
    color: Color
    hero: str
    skin: str
    isBot: bool
    connected: bool


class TeamView(BaseModel):
    hero: str
    pieces: list[int]
    lanes: list[int]
    mana: int
    maxMana: int
    finish: int
    ultUsed: bool
    statuses: list[list[str]]


class MoveOptionView(BaseModel):
    piece: int
    lane: int | None
    to: int


class TileView(BaseModel):
    effect: Literal["broken", "crater", "fire", "trap"]
    turns: int | None
    owner: Color | None


class MatchView(BaseModel):
    mapId: str
    turnOrder: list[Color]
    current: Color
    phase: Literal["roll", "move", "over"]
    turn: int
    lastRoll: int | None
    legalPieces: list[int]
    moveOptions: list[MoveOptionView]
    castUsed: bool
    castTargets: dict[str, list[dict]]
    ranking: list[Color]
    tiles: dict[str, TileView]
    teams: dict[Color, TeamView]
    turnTimeLeftMs: int | None = None


class RoomView(BaseModel):
    code: str
    state: Literal["lobby", "playing", "finished"]
    hostId: str
    mapId: str
    practice: bool
    version: int
    seq: int
    players: list[PlayerView]
    match: MatchView | None


class GuestView(BaseModel):
    id: str
    name: str


class GuestSession(GuestView):
    token: str


# ---------------------------------------------------------------- client -> server (WebSocket)
class RollCommand(BaseModel):
    type: Literal["roll"]


class MoveCommand(BaseModel):
    type: Literal["move"]
    piece: int = Field(ge=0, le=7)
    lane: int | None = Field(default=None, ge=0, le=1)


class CastCommand(BaseModel):
    type: Literal["cast"]
    ability: str
    target: dict


class PracticeCommand(BaseModel):
    """Practice rooms only: force the next roll and/or set your mana."""

    type: Literal["practice"]
    dice: int | None = Field(default=None, ge=1, le=6)
    mana: int | None = Field(default=None, ge=0, le=10)


class PingCommand(BaseModel):
    type: Literal["ping"]


class ResyncCommand(BaseModel):
    type: Literal["resync"]


ClientMessage = Annotated[
    RollCommand | MoveCommand | CastCommand | PracticeCommand | PingCommand | ResyncCommand,
    Field(discriminator="type"),
]


# ---------------------------------------------------------------- server -> client (WebSocket)
class HelloMessage(BaseModel):
    type: Literal["hello"] = "hello"
    protocol: int = PROTOCOL_VERSION
    you: str
    room: RoomView


class SnapshotMessage(BaseModel):
    """Full state; sent on connect, on resync and for lobby changes."""

    type: Literal["snapshot"] = "snapshot"
    room: RoomView


class EventsMessage(BaseModel):
    """Ordered game events followed by the resulting state.

    Clients animate `events` in order, then adopt `room` as the truth.
    """

    type: Literal["events"] = "events"
    seq: int
    events: list[GameEvent]
    room: RoomView


class ErrorMessage(BaseModel):
    type: Literal["error"] = "error"
    message: str


class PongMessage(BaseModel):
    type: Literal["pong"] = "pong"


ServerMessage = Annotated[
    HelloMessage | SnapshotMessage | EventsMessage | ErrorMessage | PongMessage,
    Field(discriminator="type"),
]
