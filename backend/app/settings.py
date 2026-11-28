"""Configuration from environment variables (prefix LUDO_) or a .env file."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LUDO_", env_file=".env", extra="ignore")

    # Postgres in production, e.g. postgresql+asyncpg://ludo:ludo@localhost:5432/ludo
    database_url: str = "sqlite+aiosqlite:///./ludobrawl.db"
    # Create tables on startup (handy for local SQLite). Use Alembic migrations in production.
    db_auto_create: bool = True

    bot_delay: float = 1.1
    turn_timeout: float = 30.0
    act_timeout: float = 12.0
    room_ttl: float = 2 * 60 * 60

    cors_origins: list[str] = ["http://localhost:4200"]
    static_dir: Path = REPO_ROOT / "frontend" / "dist" / "frontend" / "browser"


@lru_cache
def get_settings() -> Settings:
    return Settings()
