"""Database models. Accounts, inventories and leaderboards will extend these."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class Guest(Base):
    """A player without an account yet. Later upgraded in place to a full account."""

    __tablename__ = "guests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(20))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class MatchResult(Base):
    __tablename__ = "matches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    room_code: Mapped[str] = mapped_column(String(8))
    map_id: Mapped[str] = mapped_column(String(64))
    seed: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    duration_s: Mapped[float] = mapped_column(Float)
    turns: Mapped[int] = mapped_column(Integer)
    finished_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)

    participants: Mapped[list[MatchParticipant]] = relationship(back_populates="match", cascade="all, delete-orphan")


class MatchParticipant(Base):
    __tablename__ = "match_participants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    match_id: Mapped[str] = mapped_column(ForeignKey("matches.id", ondelete="CASCADE"), index=True)
    guest_id: Mapped[str | None] = mapped_column(
        ForeignKey("guests.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(32))
    color: Mapped[str] = mapped_column(String(8))
    hero: Mapped[str] = mapped_column(String(32))
    skin: Mapped[str] = mapped_column(String(48))
    is_bot: Mapped[bool] = mapped_column(Boolean, default=False)
    place: Mapped[int | None] = mapped_column(Integer, nullable=True)

    match: Mapped[MatchResult] = relationship(back_populates="participants")
