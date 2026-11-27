"""FastAPI app: REST endpoints for actions, a WebSocket for live room updates."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, Header, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .game import Color
from .rooms import LudoError, Room, RoomManager

log = logging.getLogger("ludobrawl")

TICK_SECONDS = 0.2
DEFAULT_STATIC = Path(__file__).resolve().parents[2] / "frontend" / "dist" / "frontend" / "browser"


class NameBody(BaseModel):
    name: str = Field(max_length=100)


class ColorBody(BaseModel):
    color: Color


class MoveBody(BaseModel):
    piece: int = Field(ge=0, le=3)


# Endpoints are all `async def` so they run on the event loop, never in a
# thread pool: RoomManager and the hub queues are not thread-safe.
class Hub:
    """Fans room snapshots out to every WebSocket watching that room."""

    def __init__(self, manager: RoomManager):
        self.manager = manager
        self.queues: dict[str, set[asyncio.Queue]] = {}
        manager.subscribe(self.publish)

    def publish(self, room: Room) -> None:
        queues = self.queues.get(room.code)
        if not queues:
            return
        snapshot = self.manager.view(room)
        for q in queues:
            q.put_nowait(snapshot)

    def add(self, code: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self.queues.setdefault(code, set()).add(q)
        return q

    def remove(self, code: str, q: asyncio.Queue) -> None:
        queues = self.queues.get(code)
        if queues is not None:
            queues.discard(q)
            if not queues:
                del self.queues[code]


def create_app(manager: RoomManager | None = None, *, run_ticker: bool = True, static_dir: Path | None = None) -> FastAPI:
    manager = manager or RoomManager()
    hub = Hub(manager)

    async def ticker() -> None:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            try:
                manager.tick()
            except Exception:  # never let one bad room kill the loop
                log.exception("tick failed")

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        task = asyncio.create_task(ticker()) if run_ticker else None
        yield
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    app = FastAPI(title="Ludo Brawl", lifespan=lifespan)
    app.state.manager = manager

    origins = [o for o in os.environ.get("LUDO_CORS_ORIGINS", "http://localhost:4200").split(",") if o]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(LudoError)
    async def ludo_error(_: Request, exc: LudoError):
        return JSONResponse({"error": exc.message}, status_code=exc.status)

    def session(room: Room, player) -> dict:
        return {"room": manager.view(room), "playerId": player.id, "token": player.token}

    def actor(code: str, token: str | None):
        room = manager.get(code)
        return room, manager.authenticate(room, token)

    # ---------------------------------------------------------------- REST
    @app.get("/api/health")
    async def health():
        return {"ok": True, "rooms": len(manager.rooms)}

    @app.post("/api/rooms", status_code=201)
    async def create_room(body: NameBody):
        room, player = manager.create_room(body.name)
        return session(room, player)

    @app.get("/api/rooms/{code}")
    async def get_room(code: str):
        return manager.view(manager.get(code))

    @app.post("/api/rooms/{code}/join")
    async def join_room(code: str, body: NameBody):
        room, player = manager.join(code, body.name)
        return session(room, player)

    @app.post("/api/rooms/{code}/bots")
    async def add_bot(code: str, x_player_token: str | None = Header(None)):
        room, me = actor(code, x_player_token)
        manager.add_bot(room, me)
        return manager.view(room)

    @app.delete("/api/rooms/{code}/players/{player_id}")
    async def kick(code: str, player_id: str, x_player_token: str | None = Header(None)):
        room, me = actor(code, x_player_token)
        manager.kick(room, me, player_id)
        return manager.view(room)

    @app.post("/api/rooms/{code}/color")
    async def set_color(code: str, body: ColorBody, x_player_token: str | None = Header(None)):
        room, me = actor(code, x_player_token)
        manager.set_color(room, me, body.color)
        return manager.view(room)

    @app.post("/api/rooms/{code}/start")
    async def start(code: str, x_player_token: str | None = Header(None)):
        room, me = actor(code, x_player_token)
        manager.start(room, me)
        return manager.view(room)

    @app.post("/api/rooms/{code}/roll")
    async def roll(code: str, x_player_token: str | None = Header(None)):
        room, me = actor(code, x_player_token)
        manager.roll(room, me)
        return manager.view(room)

    @app.post("/api/rooms/{code}/move")
    async def move(code: str, body: MoveBody, x_player_token: str | None = Header(None)):
        room, me = actor(code, x_player_token)
        manager.move(room, me, body.piece)
        return manager.view(room)

    @app.post("/api/rooms/{code}/rematch")
    async def rematch(code: str, x_player_token: str | None = Header(None)):
        room, me = actor(code, x_player_token)
        manager.rematch(room, me)
        return manager.view(room)

    @app.post("/api/rooms/{code}/leave", status_code=204)
    async def leave(code: str, x_player_token: str | None = Header(None)):
        room, me = actor(code, x_player_token)
        manager.leave(room, me)

    # ---------------------------------------------------------------- live
    @app.websocket("/api/rooms/{code}/ws")
    async def room_socket(ws: WebSocket, code: str, token: str | None = None):
        await ws.accept()
        try:
            room, me = actor(code, token)
        except LudoError as e:
            await ws.close(code=4000 + e.status, reason=e.message)
            return

        queue = hub.add(room.code)
        manager.set_connected(room, me, +1)
        await ws.send_json(manager.view(room))

        async def pump() -> None:
            while True:
                await ws.send_json(await queue.get())

        async def drain() -> None:
            # The client only sends pings; we just need to notice disconnects.
            with suppress(WebSocketDisconnect):
                while True:
                    await ws.receive_text()

        tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in tasks:
                t.cancel()
            hub.remove(room.code, queue)
            if room.code in manager.rooms and me in room.players:
                manager.set_connected(room, me, -1)

    # ---------------------------------------------------------------- frontend
    static = static_dir or Path(os.environ.get("LUDO_STATIC_DIR", DEFAULT_STATIC))
    if static.is_dir():
        index = static / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            if path.startswith("api/"):
                return JSONResponse({"error": "Not found"}, status_code=404)
            candidate = (static / path).resolve()
            if path and candidate.is_file() and candidate.is_relative_to(static.resolve()):
                return FileResponse(candidate)
            return FileResponse(index)

    return app


app = create_app()
