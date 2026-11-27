from __future__ import annotations

from fastapi import APIRouter

from ..game.board import available_maps, load_board
from ..game.heroes import hero_catalog
from ..rooms.service import LudoError

router = APIRouter(prefix="/api", tags=["catalog"])


@router.get("/maps")
async def maps() -> list[dict]:
    return [b.summary() for b in available_maps()]


@router.get("/maps/{map_id}")
async def map_data(map_id: str) -> dict:
    try:
        return load_board(map_id).data
    except KeyError:
        raise LudoError("Unknown map.", 404) from None


@router.get("/heroes")
async def heroes() -> list[dict]:
    return hero_catalog()
