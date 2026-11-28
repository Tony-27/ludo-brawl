"""Hero and ability catalogue (data). Effects are implemented in spells.py.

Heroes carry the gameplay abilities. Skins are purely cosmetic and only
change how a hero looks and sounds, never what it can do.

Every hero has three abilities:
    basic    cheap, used often
    utility  mid-cost tool or defence
    ultimate the big moment: usable once per match
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Targeting = Literal["ownPiece", "ownPieceSteps", "enemyPiece", "tile", "none"]
Slot = Literal["basic", "utility", "ultimate"]


@dataclass(frozen=True)
class Ability:
    id: str
    name: str
    slot: Slot
    cost: int
    targeting: Targeting
    effect: str  # key into spells.EFFECTS
    description: str
    params: dict = field(default_factory=dict)

    @property
    def once_per_match(self) -> bool:
        return self.slot == "ultimate"


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
    role: str
    abilities: tuple[str, str, str]
    passive: str | None
    passive_text: str
    skins: tuple[Skin, ...]
    selectable: bool = True


def A(id, name, slot, cost, targeting, effect, description, **params) -> Ability:  # noqa: N802 - tiny DSL
    return Ability(id, name, slot, cost, targeting, effect, description, params)


ABILITIES: dict[str, Ability] = {
    a.id: a
    for a in [
        # -- Samurai: duelist, burst on the front line
        A(
            "quick_draw",
            "Quick Draw",
            "basic",
            2,
            "ownPiece",
            "dash",
            "Dash one of your pieces 2 tiles forward, knocking out an enemy you land on.",
            steps=2,
        ),
        A(
            "katana_slash",
            "Katana Slash",
            "utility",
            3,
            "ownPiece",
            "line",
            "Slash the 2 tiles ahead of one of your pieces. Enemies there are knocked back 4.",
            reach=2,
            knockback=4,
        ),
        A(
            "thousand_cuts",
            "Thousand Cuts",
            "ultimate",
            5,
            "none",
            "radius",
            "Every enemy within 4 tiles of any of your pieces is knocked back 3.",
            radius=4,
            knockback=3,
        ),
        # -- Viking: brawler (same kit shape as the Samurai, heavier flavour)
        A(
            "charge",
            "Charge",
            "basic",
            2,
            "ownPiece",
            "dash",
            "Charge one of your pieces 2 tiles forward, knocking out an enemy you crash into.",
            steps=2,
        ),
        A(
            "cleave",
            "Cleave",
            "utility",
            3,
            "ownPiece",
            "line",
            "Cleave the 2 tiles ahead of one of your pieces. Enemies there are knocked back 4.",
            reach=2,
            knockback=4,
        ),
        A(
            "berserker_rage",
            "Berserker Rage",
            "ultimate",
            5,
            "none",
            "radius",
            "Every enemy within 4 tiles of any of your pieces is knocked back 3.",
            radius=4,
            knockback=3,
        ),
        # -- Grand Wizard: long-range control
        A(
            "zap",
            "Zap",
            "basic",
            2,
            "enemyPiece",
            "strike",
            "Strike an enemy within 6 tiles of one of your pieces, knocking it back 3.",
            range=6,
            knockback=3,
        ),
        A(
            "blink",
            "Blink",
            "utility",
            3,
            "ownPieceSteps",
            "blink",
            "Teleport one of your pieces 1 to 3 tiles forward.",
            maxSteps=3,
        ),
        A(
            "meteor",
            "Meteor",
            "ultimate",
            5,
            "tile",
            "meteor",
            "Call a meteor on a tile within 8 tiles: enemies on it and beside it are knocked back 4, "
            "and it leaves a crater (a pit) for 2 rounds.",
            range=8,
            knockback=4,
            splash=1,
            turns=2,
        ),
        # -- Knight: protector
        A(
            "shield_wall",
            "Shield Wall",
            "basic",
            2,
            "ownPiece",
            "shield",
            "Protect one of your pieces from attacks and falls until your next turn.",
            turns=1,
        ),
        A(
            "shield_bash",
            "Shield Bash",
            "utility",
            3,
            "enemyPiece",
            "strike",
            "Bash an enemy within 2 tiles: knocked back 2 and rooted for a turn.",
            range=2,
            knockback=2,
            root=1,
        ),
        A(
            "rally",
            "Rally",
            "ultimate",
            5,
            "none",
            "rally",
            "Every piece you have on the trail advances 2 tiles and is shielded until your next turn.",
            steps=2,
        ),
        # -- Ranger: sniper and trapper
        A(
            "piercing_arrow",
            "Piercing Arrow",
            "basic",
            2,
            "ownPiece",
            "line",
            "Hit the first enemy up to 6 tiles ahead of one of your pieces, knocking it back 3.",
            reach=6,
            knockback=3,
            firstOnly=True,
        ),
        A(
            "snare_trap",
            "Snare Trap",
            "utility",
            3,
            "tile",
            "trap",
            "Hide a trap on a tile within 4 tiles. The next enemy to land there is rooted and knocked back 2.",
            range=4,
            knockback=2,
            root=1,
            turns=4,
        ),
        A(
            "rain_of_arrows",
            "Rain of Arrows",
            "ultimate",
            5,
            "none",
            "radius",
            "Every enemy up to 6 tiles ahead of any of your pieces is knocked back 2.",
            radius=6,
            knockback=2,
            aheadOnly=True,
        ),
        # -- Druid: battlefield manipulation
        A(
            "entangling_roots",
            "Entangling Roots",
            "basic",
            2,
            "enemyPiece",
            "strike",
            "Root an enemy within 6 tiles: it can't move on its owner's next turn.",
            range=6,
            root=1,
        ),
        A(
            "wild_growth",
            "Wild Growth",
            "utility",
            3,
            "enemyPiece",
            "swap",
            "Swap places with an enemy within 5 tiles of one of your pieces.",
            range=5,
        ),
        A(
            "overgrowth",
            "Overgrowth",
            "ultimate",
            5,
            "none",
            "radius",
            "Root every enemy within 5 tiles of any of your pieces.",
            radius=5,
            root=1,
        ),
        # -- Dragon Rider: aggressive mobility
        A(
            "dive",
            "Dive",
            "basic",
            2,
            "ownPiece",
            "dash",
            "Swoop one of your pieces 3 tiles forward, knocking out an enemy you land on.",
            steps=3,
        ),
        A(
            "fire_breath",
            "Fire Breath",
            "utility",
            3,
            "ownPiece",
            "line",
            "Breathe fire over the 3 tiles ahead: enemies are knocked back 2 and the ground burns for 2 rounds.",
            reach=3,
            knockback=2,
            burn=2,
        ),
        A(
            "inferno",
            "Inferno",
            "ultimate",
            5,
            "none",
            "radius",
            "Every enemy within 3 tiles of any of your pieces is knocked back 4.",
            radius=3,
            knockback=4,
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
            "Duelist",
            ("quick_draw", "katana_slash", "thousand_cuts"),
            "bushido",
            "Bushido: gain 1 mana whenever you knock an enemy out.",
            (Skin("samurai_default", "Ronin"), Skin("samurai_oni", "Crimson Oni", "epic")),
        ),
        Hero(
            "viking",
            "Viking",
            "Storm of the North",
            "Brawler",
            ("charge", "cleave", "berserker_rage"),
            "bloodlust",
            "Bloodlust: gain 1 mana whenever you knock an enemy out.",
            (Skin("viking_default", "Raider"), Skin("viking_jarl", "Jarl", "epic")),
        ),
        Hero(
            "grand_wizard",
            "Grand Wizard",
            "Keeper of the Storm",
            "Controller",
            ("zap", "blink", "meteor"),
            None,
            "",
            (Skin("wizard_default", "Archmage"), Skin("wizard_frost", "Frostweaver", "rare")),
        ),
        Hero(
            "knight",
            "Knight",
            "Shield of the Realm",
            "Protector",
            ("shield_wall", "shield_bash", "rally"),
            None,
            "",
            (Skin("knight_default", "Paladin"), Skin("knight_gilded", "Gilded Champion", "epic")),
        ),
        Hero(
            "ranger",
            "Ranger",
            "Eye of the Wilds",
            "Sniper",
            ("piercing_arrow", "snare_trap", "rain_of_arrows"),
            None,
            "",
            (Skin("ranger_default", "Pathfinder"), Skin("ranger_shadow", "Shadowstalker", "rare")),
        ),
        Hero(
            "druid",
            "Druid",
            "Voice of the Grove",
            "Manipulator",
            ("entangling_roots", "wild_growth", "overgrowth"),
            None,
            "",
            (Skin("druid_default", "Grovewarden"), Skin("druid_autumn", "Autumn Sage", "rare")),
        ),
        Hero(
            "dragon_rider",
            "Dragon Rider",
            "Wings of Cinder",
            "Striker",
            ("dive", "fire_breath", "inferno"),
            None,
            "",
            (Skin("dragon_rider_default", "Emberwing"), Skin("dragon_rider_storm", "Stormscale", "epic")),
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
            "role": h.role,
            "selectable": h.selectable,
            "passive": h.passive_text or None,
            "skins": [{"id": s.id, "name": s.name, "rarity": s.rarity} for s in h.skins],
            "abilities": [
                {
                    "id": a.id,
                    "name": a.name,
                    "slot": a.slot,
                    "cost": a.cost,
                    "targeting": a.targeting,
                    "effect": a.effect,
                    "description": a.description,
                    "params": a.params,
                }
                for a in (ABILITIES[aid] for aid in h.abilities)
            ],
        }
        for h in HEROES.values()
    ]
