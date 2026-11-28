from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..db.models import Guest
from ..game.board import DEFAULT_MAP, Color
from ..realtime.protocol import RoomView
from ..rooms.service import RoomService
from .deps import current_guest, get_rooms

router = APIRouter(prefix="/api/rooms", tags=["rooms"])


class CreateBody(BaseModel):
    mapId: str = DEFAULT_MAP


class BotBody(BaseModel):
    hero: str | None = None


class LoadoutBody(BaseModel):
    color: Color | None = None
    hero: str | None = None
    skin: str | None = None


class MapBody(BaseModel):
    mapId: str


class PracticeBody(BaseModel):
    enabled: bool


@router.post("", status_code=201)
async def create(
    body: CreateBody, guest: Guest = Depends(current_guest), rooms: RoomService = Depends(get_rooms)
) -> RoomView:
    return rooms.view(rooms.create_room(guest.id, guest.name, body.mapId))


@router.get("/{code}")
async def get(code: str, rooms: RoomService = Depends(get_rooms)) -> RoomView:
    return rooms.view(rooms.get(code))


@router.post("/{code}/join")
async def join(code: str, guest: Guest = Depends(current_guest), rooms: RoomService = Depends(get_rooms)) -> RoomView:
    return rooms.view(rooms.join(code, guest.id, guest.name))


def _seat(code: str, guest: Guest, rooms: RoomService):
    room = rooms.get(code)
    return room, rooms.seat_of(room, guest.id)


@router.post("/{code}/bots")
async def add_bot(
    code: str, body: BotBody, guest: Guest = Depends(current_guest), rooms: RoomService = Depends(get_rooms)
) -> RoomView:
    room, seat = _seat(code, guest, rooms)
    rooms.add_bot(room, seat, body.hero)
    return rooms.view(room)


@router.delete("/{code}/players/{player_id}")
async def kick(
    code: str, player_id: str, guest: Guest = Depends(current_guest), rooms: RoomService = Depends(get_rooms)
) -> RoomView:
    room, seat = _seat(code, guest, rooms)
    rooms.kick(room, seat, player_id)
    return rooms.view(room)


@router.post("/{code}/loadout")
async def loadout(
    code: str, body: LoadoutBody, guest: Guest = Depends(current_guest), rooms: RoomService = Depends(get_rooms)
) -> RoomView:
    room, seat = _seat(code, guest, rooms)
    rooms.set_loadout(room, seat, color=body.color, hero=body.hero, skin=body.skin)
    return rooms.view(room)


@router.post("/{code}/map")
async def set_map(
    code: str, body: MapBody, guest: Guest = Depends(current_guest), rooms: RoomService = Depends(get_rooms)
) -> RoomView:
    room, seat = _seat(code, guest, rooms)
    rooms.set_map(room, seat, body.mapId)
    return rooms.view(room)


@router.post("/{code}/practice")
async def set_practice(
    code: str, body: PracticeBody, guest: Guest = Depends(current_guest), rooms: RoomService = Depends(get_rooms)
) -> RoomView:
    room, seat = _seat(code, guest, rooms)
    rooms.set_practice(room, seat, body.enabled)
    return rooms.view(room)


@router.post("/{code}/start")
async def start(code: str, guest: Guest = Depends(current_guest), rooms: RoomService = Depends(get_rooms)) -> RoomView:
    room, seat = _seat(code, guest, rooms)
    rooms.start(room, seat)
    return rooms.view(room)


@router.post("/{code}/rematch")
async def rematch(
    code: str, guest: Guest = Depends(current_guest), rooms: RoomService = Depends(get_rooms)
) -> RoomView:
    room, seat = _seat(code, guest, rooms)
    rooms.rematch(room, seat)
    return rooms.view(room)


@router.post("/{code}/leave", status_code=204)
async def leave(code: str, guest: Guest = Depends(current_guest), rooms: RoomService = Depends(get_rooms)) -> None:
    room, seat = _seat(code, guest, rooms)
    rooms.leave(room, seat)
