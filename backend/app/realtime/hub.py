"""WebSocket fan-out and the in-game command channel."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import suppress

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from ..db import repo
from ..rooms.service import LudoError, Room, RoomService
from .protocol import (
    PROTOCOL_VERSION,
    CastCommand,
    ClientMessage,
    EndTurnCommand,
    MoveCommand,
    PingCommand,
    PracticeCommand,
    ResyncCommand,
    RollCommand,
)

log = logging.getLogger("ludobrawl.ws")
_client_message = TypeAdapter(ClientMessage)


class Hub:
    """Pushes room updates to every socket watching a room."""

    def __init__(self, rooms: RoomService):
        self.rooms = rooms
        self.queues: dict[str, set[asyncio.Queue]] = {}
        rooms.subscribe(self.publish)

    def publish(self, room: Room, events: list[dict]) -> None:
        queues = self.queues.get(room.code)
        if not queues:
            return
        view = self.rooms.view(room).model_dump(mode="json")
        if events:
            message = {"type": "events", "seq": room.seq, "events": events, "room": view}
        else:
            message = {"type": "snapshot", "room": view}
        text = json.dumps(message)
        for q in queues:
            q.put_nowait(text)

    def add(self, code: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self.queues.setdefault(code, set()).add(q)
        return q

    def remove(self, code: str, q: asyncio.Queue) -> None:
        qs = self.queues.get(code)
        if qs is not None:
            qs.discard(q)
            if not qs:
                del self.queues[code]


router = APIRouter()


@router.websocket("/api/rooms/{code}/ws")
async def room_socket(ws: WebSocket, code: str, token: str | None = None) -> None:
    app = ws.app
    rooms: RoomService = app.state.rooms
    hub: Hub = app.state.hub
    await ws.accept()

    async with app.state.db.sessions() as session:
        guest = await repo.guest_by_token(session, token) if token else None
    try:
        if guest is None:
            raise LudoError("Please sign in as a guest first.", 401)
        room = rooms.get(code)
        seat = rooms.seat_of(room, guest.id)
    except LudoError as e:
        await ws.close(code=4000 + e.status, reason=e.message)
        return

    queue = hub.add(room.code)
    rooms.set_connected(room, seat, +1)
    await ws.send_json(
        {
            "type": "hello",
            "protocol": PROTOCOL_VERSION,
            "you": guest.id,
            "room": rooms.view(room).model_dump(mode="json"),
        }
    )

    async def pump() -> None:
        while True:
            await ws.send_text(await queue.get())

    async def handle(raw: str) -> None:
        try:
            msg = _client_message.validate_json(raw)
        except ValidationError:
            await ws.send_json({"type": "error", "message": "Malformed message."})
            return
        # The seat can change (e.g. a bot took over), so look it up every time.
        current = room.seat(guest.id)
        try:
            if current is None:
                raise LudoError("You are no longer in this room.", 403)
            if isinstance(msg, PingCommand):
                await ws.send_json({"type": "pong"})
            elif isinstance(msg, ResyncCommand):
                await ws.send_json({"type": "snapshot", "room": rooms.view(room).model_dump(mode="json")})
            elif isinstance(msg, RollCommand):
                rooms.roll(room, current)
            elif isinstance(msg, MoveCommand):
                rooms.move(room, current, msg.piece, msg.lane)
            elif isinstance(msg, CastCommand):
                rooms.cast(room, current, msg.ability, msg.target)
            elif isinstance(msg, EndTurnCommand):
                rooms.end_turn(room, current)
            elif isinstance(msg, PracticeCommand):
                rooms.practice(room, current, dice=msg.dice, mana=msg.mana)
        except LudoError as e:
            await ws.send_json({"type": "error", "message": e.message})

    async def commands() -> None:
        with suppress(WebSocketDisconnect):
            while True:
                await handle(await ws.receive_text())

    tasks = [asyncio.create_task(pump()), asyncio.create_task(commands())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        hub.remove(room.code, queue)
        current = room.seat(guest.id)
        if current is not None and rooms.store.get(room.code) is room:
            rooms.set_connected(room, current, -1)
