from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import repo
from ..db.models import Guest
from ..db.session import Database
from ..rooms.service import LudoError, RoomService


def get_db(request: Request) -> Database:
    return request.app.state.db


def get_rooms(request: Request) -> RoomService:
    return request.app.state.rooms


async def get_session(db: Database = Depends(get_db)) -> AsyncIterator[AsyncSession]:
    async with db.sessions() as session:
        yield session


def bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


async def current_guest(
    authorization: str | None = Header(None), session: AsyncSession = Depends(get_session)
) -> Guest:
    token = bearer(authorization)
    guest = await repo.guest_by_token(session, token) if token else None
    if guest is None:
        raise LudoError("Please sign in as a guest first.", 401)
    return guest
