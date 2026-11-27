"""Hero and ability catalogue (data only; effects live in rules.py).

Heroes carry the gameplay abilities. Skins are purely cosmetic and only
change how a hero looks and sounds, never what it can do.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Targeting = Literal["ownPiece", "ownPieceSteps", "enemyPiece"]


@dataclass(frozen=True)
class Ability:
    id: str
    name: str
    cost: int
    targeting: Targeting
    description: str
    params: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Skin:
    id: str
    name: str
    rarity: Literal["common", "rare", "epic", "legendary"] = "common"


@dataclass(frozen=True)
class Hero:
    id: str
    name: str
    title: str
    abilities: tuple[str, ...]
    passive: str | None
    passive_text: str
    skins: tuple[Skin, ...]
    selectable: bool = True


ABILITIES: dict[str, Ability] = {
    a.id: a
    for a in [
        Ability(
            "katana_slash",
            "Katana Slash",
            3,
            "ownPiece",
            "Slash the 2 tiles in front of one of your pieces. Enemies there are knocked back 4 tiles.",
            {"reach": 2, "knockback": 4},
        ),
        Ability(
            "zap",
            "Zap",
            3,
            "enemyPiece",
            "Strike an enemy within 6 tiles of one of your pieces, knocking it back 3 tiles.",
            {"range": 6, "knockback": 3},
        ),
        Ability(
            "blink",
            "Blink",
            4,
            "ownPieceSteps",
            "Teleport one of your pieces 1 to 3 tiles forward.",
            {"maxSteps": 3},
        ),
        Ability(
            "shield_wall",
            "Shield Wall",
            3,
            "ownPiece",
            "Protect one of your pieces from all attacks until your next turn.",
            {"turns": 1},
        ),
        Ability(
            "entangling_roots",
            "Entangling Roots",
            4,
            "enemyPiece",
            "Root an enemy within 6 tiles: it can't move on its owner's next turn.",
            {"range": 6, "turns": 1},
        ),
        Ability(
            "fire_breath",
            "Fire Breath",
            4,
            "ownPiece",
            "Breathe fire over the 3 tiles ahead, knocking enemies back 2.",
            {"reach": 3, "knockback": 2},
        ),
        Ability(
            "piercing_arrow",
            "Piercing Arrow",
            3,
            "ownPiece",
            "Hit the first enemy up to 6 tiles ahead, knocking it back 3.",
            {"reach": 6, "knockback": 3, "firstOnly": True},
        ),
    ]
}

HEROES: dict[str, Hero] = {
    h.id: h
    for h in [
        Hero(
            "samurai",
            "Samurai",
            "Blade of the Rising Dawn",
            ("katana_slash",),
            "bushido",
            "Bushido: gain 1 mana whenever you knock an enemy out.",
            (Skin("samurai_default", "Ronin"), Skin("samurai_oni", "Oni Mask", "epic")),
        ),
        Hero(
            "grand_wizard",
            "Grand Wizard",
            "Keeper of the Storm",
            ("zap", "blink"),
            None,
            "",
            (Skin("wizard_default", "Archmage"), Skin("wizard_frost", "Frostweaver", "rare")),
        ),
        Hero(
            "knight",
            "Knight",
            "Shield of the Realm",
            ("shield_wall",),
            None,
            "",
            (Skin("knight_default", "Paladin"),),
            selectable=False,
        ),
        Hero(
            "dragon_rider",
            "Dragon Rider",
            "Wings of Cinder",
            ("fire_breath",),
            None,
            "",
            (Skin("dragon_rider_default", "Emberwing"),),
            selectable=False,
        ),
        Hero(
            "ranger",
            "Ranger",
            "Eye of the Wilds",
            ("piercing_arrow",),
            None,
            "",
            (Skin("ranger_default", "Pathfinder"),),
            selectable=False,
        ),
        Hero(
            "druid",
            "Druid",
            "Voice of the Grove",
            ("entangling_roots",),
            None,
            "",
            (Skin("druid_default", "Grovewarden"),),
            selectable=False,
        ),
    ]
}

DEFAULT_HERO = "samurai"


def hero_catalog() -> list[dict]:
    return [
        {
            "id": h.id,
            "name": h.name,
            "title": h.title,
            "selectable": h.selectable,
            "passive": h.passive_text or None,
            "skins": [{"id": s.id, "name": s.name, "rarity": s.rarity} for s in h.skins],
            "abilities": [
                {
                    "id": a.id,
                    "name": a.name,
                    "cost": a.cost,
                    "targeting": a.targeting,
                    "description": a.description,
                    "params": a.params,
                }
                for a in (ABILITIES[aid] for aid in h.abilities)
            ],
        }
        for h in HEROES.values()
    ]
