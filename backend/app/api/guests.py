from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import repo
from ..db.models import Guest
from ..realtime.protocol import GuestSession, GuestView
from .deps import current_guest, get_session

router = APIRouter(prefix="/api", tags=["guests"])


class NameBody(BaseModel):
    name: str = Field(max_length=100)

    @field_validator("name")
    @classmethod
    def clean(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Please enter a name.")
        if len(v) > 20:
            raise ValueError("Names can be at most 20 characters.")
        return v


@router.post("/guests", status_code=201)
async def create_guest(body: NameBody, session: AsyncSession = Depends(get_session)) -> GuestSession:
    guest, token = await repo.create_guest(session, body.name)
    return GuestSession(id=guest.id, name=guest.name, token=token)


@router.get("/me")
async def me(guest: Guest = Depends(current_guest)) -> GuestView:
    return GuestView(id=guest.id, name=guest.name)


@router.patch("/me")
async def rename(
    body: NameBody, guest: Guest = Depends(current_guest), session: AsyncSession = Depends(get_session)
) -> GuestView:
    guest = await session.merge(guest)
    guest.name = body.name
    await session.commit()
    return GuestView(id=guest.id, name=guest.name)
