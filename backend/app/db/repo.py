"""Small data-access helpers used by the API."""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..rooms.service import MatchRecord
from .models import Guest, MatchParticipant, MatchResult


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_guest(session: AsyncSession, name: str) -> tuple[Guest, str]:
    token = secrets.token_urlsafe(32)
    guest = Guest(name=name, token_hash=hash_token(token))
    session.add(guest)
    await session.commit()
    return guest, token


async def guest_by_token(session: AsyncSession, token: str) -> Guest | None:
    guest = await session.scalar(select(Guest).where(Guest.token_hash == hash_token(token)))
    if guest is not None:
        guest.last_seen_at = datetime.now(UTC)
        await session.commit()
    return guest


async def save_match(session: AsyncSession, record: MatchRecord) -> MatchResult:
    match = MatchResult(
        room_code=record.room_code,
        map_id=record.map_id,
        seed=record.seed,
        duration_s=record.duration_s,
        turns=record.turns,
        participants=[MatchParticipant(**p) for p in record.participants],
    )
    session.add(match)
    await session.commit()
    return match
