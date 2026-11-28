"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .api import catalog, guests, rooms
from .db import repo
from .db.session import Database
from .realtime import hub as realtime
from .rooms.service import LudoError, MatchRecord, RoomService, Timings
from .settings import Settings, get_settings

log = logging.getLogger("ludobrawl")
TICK_SECONDS = 0.1


def create_app(
    settings: Settings | None = None,
    *,
    room_service: RoomService | None = None,
    run_ticker: bool = True,
) -> FastAPI:
    settings = settings or get_settings()
    db = Database(settings.database_url)
    service = room_service or RoomService(
        Timings(
            bot_delay=settings.bot_delay,
            turn_timeout=settings.turn_timeout,
            act_timeout=settings.act_timeout,
            room_idle_ttl=settings.room_ttl,
        )
    )
    hub = realtime.Hub(service)
    background: set[asyncio.Task] = set()

    async def persist(record: MatchRecord) -> None:
        try:
            async with db.sessions() as session:
                await repo.save_match(session, record)
        except Exception:
            log.exception("could not save match %s", record.room_code)

    def on_finished(record: MatchRecord) -> None:
        task = asyncio.get_running_loop().create_task(persist(record))
        background.add(task)
        task.add_done_callback(background.discard)

    service.on_match_finished = on_finished

    async def ticker() -> None:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            try:
                service.tick()
            except Exception:  # one bad room must not stop the loop
                log.exception("tick failed")

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if settings.db_auto_create:
            await db.create_all()
        task = asyncio.create_task(ticker()) if run_ticker else None
        yield
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        if background:
            await asyncio.gather(*background, return_exceptions=True)
        await db.dispose()

    app = FastAPI(title="Ludo Brawl", version="2.0.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.db = db
    app.state.rooms = service
    app.state.hub = hub
    app.state.background = background
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(LudoError)
    async def ludo_error(_: Request, exc: LudoError):
        return JSONResponse({"error": exc.message}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        errors = exc.errors()
        msg = str(errors[0].get("msg", "Invalid request.")) if errors else "Invalid request."
        return JSONResponse({"error": msg.removeprefix("Value error, ")}, status_code=400)

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True, "rooms": len(service.store.all())}

    app.include_router(guests.router)
    app.include_router(catalog.router)
    app.include_router(rooms.router)
    app.include_router(realtime.router)

    static: Path = settings.static_dir
    if static.is_dir():
        index = static / "index.html"
        root = static.resolve()

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            if path.startswith("api/"):
                return JSONResponse({"error": "Not found"}, status_code=404)
            candidate = (static / path).resolve()
            if path and candidate.is_file() and candidate.is_relative_to(root):
                return FileResponse(candidate)
            return FileResponse(index)

    return app


app = create_app()
