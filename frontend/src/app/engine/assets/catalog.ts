/**
 * Art catalogue: which model, props, tint and animations each skin uses, and
 * which environment models exist. Swapping placeholder art for custom art is
 * a change to this file only.
 */
import type { Color } from '../../core/protocol';

export const ASSET_ROOT = 'assets/';

/** Logical animation states every hero must provide. */
export type AnimState =
  | 'idle'
  | 'run'
  | 'jump'
  | 'land'
  | 'attack'
  | 'cast'
  | 'castLoop'
  | 'hit'
  | 'knockdown'
  | 'standUp'
  | 'dodge'
  | 'victory'
  | 'block';

/** KayKit adventurers share one rig and one set of clip names. */
const KAYKIT_ANIMS: Record<AnimState, string> = {
  idle: 'Idle',
  run: 'Running_A',
  jump: 'Jump_Start',
  land: 'Jump_Land',
  attack: '1H_Melee_Attack_Slice_Diagonal',
  cast: 'Spellcast_Shoot',
  castLoop: 'Spellcasting',
  hit: 'Hit_A',
  knockdown: 'Death_A',
  standUp: 'Lie_StandUp',
  dodge: 'Dodge_Backward',
  victory: 'Cheer',
  block: 'Block',
};

export interface SkinArt {
  id: string;
  model: string; // .glb under ASSET_ROOT
  /** Prop meshes to keep visible; every other prop mesh in the model is hidden. */
  props: string[];
  /** All prop meshes the model contains (hidden unless listed in `props`). */
  allProps: string[];
  /** Mesh name fragment that gets the team colour (e.g. the cape). */
  teamTint: string;
  /** Optional colour grade for the whole character (rare/epic skins). */
  tint?: [number, number, number];
  /** Glow colour used by this skin's ability VFX. */
  vfx: [number, number, number];
  anims: Record<AnimState, string>;
  scale: number;
}

const KNIGHT_PROPS = ['1H_Sword_Offhand', 'Badge_Shield', 'Rectangle_Shield', 'Round_Shield', 'Spike_Shield', '1H_Sword', '2H_Sword', 'Knight_Helmet'];
const BARBARIAN_PROPS = ['1H_Axe_Offhand', 'Barbarian_Round_Shield', '1H_Axe', '2H_Axe', 'Mug', 'Barbarian_Hat'];
const MAGE_PROPS = ['Spellbook', 'Spellbook_open', '1H_Wand', '2H_Staff', 'Mage_Hat'];
const ROGUE_PROPS = ['Knife_Offhand', '1H_Crossbow', '2H_Crossbow', 'Knife', 'Throwable'];

export const SKINS: Record<string, SkinArt> = {
  samurai_default: {
    id: 'samurai_default',
    model: 'characters/Knight.glb',
    props: ['2H_Sword'],
    allProps: KNIGHT_PROPS,
    teamTint: 'Cape',
    vfx: [1, 0.85, 0.55],
    anims: { ...KAYKIT_ANIMS, idle: '2H_Melee_Idle', attack: '2H_Melee_Attack_Slice', cast: '2H_Melee_Attack_Spin' },
    scale: 0.72,
  },
  samurai_oni: {
    id: 'samurai_oni',
    model: 'characters/Barbarian.glb',
    props: ['2H_Axe', 'Barbarian_Hat'],
    allProps: BARBARIAN_PROPS,
    teamTint: 'Cape',
    tint: [1.15, 0.75, 0.75],
    vfx: [1, 0.25, 0.2],
    anims: { ...KAYKIT_ANIMS, idle: '2H_Melee_Idle', attack: '2H_Melee_Attack_Chop', cast: '2H_Melee_Attack_Spin' },
    scale: 0.72,
  },
  wizard_default: {
    id: 'wizard_default',
    model: 'characters/Mage.glb',
    props: ['2H_Staff', 'Mage_Hat'],
    allProps: MAGE_PROPS,
    teamTint: 'Cape',
    vfx: [0.55, 0.8, 1],
    anims: { ...KAYKIT_ANIMS, attack: 'Spellcast_Shoot', cast: 'Spellcast_Long' },
    scale: 0.72,
  },
  wizard_frost: {
    id: 'wizard_frost',
    model: 'characters/Mage.glb',
    props: ['2H_Staff', 'Mage_Hat'],
    allProps: MAGE_PROPS,
    teamTint: 'Cape',
    tint: [0.8, 0.95, 1.2],
    vfx: [0.6, 0.95, 1],
    anims: { ...KAYKIT_ANIMS, attack: 'Spellcast_Shoot', cast: 'Spellcast_Long' },
    scale: 0.72,
  },
  knight_default: {
    id: 'knight_default',
    model: 'characters/Knight.glb',
    props: ['1H_Sword', 'Round_Shield', 'Knight_Helmet'],
    allProps: KNIGHT_PROPS,
    teamTint: 'Cape',
    vfx: [1, 0.95, 0.7],
    anims: { ...KAYKIT_ANIMS, attack: '1H_Melee_Attack_Chop', cast: 'Block_Attack' },
    scale: 0.72,
  },
  knight_gilded: {
    id: 'knight_gilded',
    model: 'characters/Knight.glb',
    props: ['1H_Sword', 'Badge_Shield', 'Knight_Helmet'],
    allProps: KNIGHT_PROPS,
    teamTint: 'Cape',
    tint: [1.25, 1.08, 0.62],
    vfx: [1, 0.85, 0.35],
    anims: { ...KAYKIT_ANIMS, attack: '1H_Melee_Attack_Chop', cast: 'Block_Attack' },
    scale: 0.72,
  },
  ranger_default: {
    id: 'ranger_default',
    model: 'characters/Rogue_Hooded.glb',
    props: ['2H_Crossbow'],
    allProps: ROGUE_PROPS,
    teamTint: 'Cape',
    vfx: [0.75, 1, 0.6],
    anims: { ...KAYKIT_ANIMS, idle: '2H_Ranged_Aiming', attack: '2H_Ranged_Shoot', cast: '2H_Ranged_Shooting' },
    scale: 0.72,
  },
  ranger_shadow: {
    id: 'ranger_shadow',
    model: 'characters/Rogue_Hooded.glb',
    props: ['1H_Crossbow', 'Knife_Offhand'],
    allProps: ROGUE_PROPS,
    teamTint: 'Cape',
    tint: [0.55, 0.55, 0.72],
    vfx: [0.7, 0.55, 1],
    anims: { ...KAYKIT_ANIMS, attack: '1H_Ranged_Shoot', cast: '1H_Ranged_Shooting' },
    scale: 0.72,
  },
  druid_default: {
    id: 'druid_default',
    model: 'characters/Mage.glb',
    props: ['2H_Staff'],
    allProps: MAGE_PROPS,
    teamTint: 'Cape',
    tint: [0.72, 1.08, 0.7],
    vfx: [0.45, 1, 0.4],
    anims: { ...KAYKIT_ANIMS, cast: 'Spellcast_Raise', attack: 'Spellcast_Shoot' },
    scale: 0.72,
  },
  druid_autumn: {
    id: 'druid_autumn',
    model: 'characters/Mage.glb',
    props: ['1H_Wand', 'Spellbook_open'],
    allProps: MAGE_PROPS,
    teamTint: 'Cape',
    tint: [1.2, 0.86, 0.6],
    vfx: [1, 0.65, 0.3],
    anims: { ...KAYKIT_ANIMS, cast: 'Spellcast_Raise', attack: 'Spellcast_Shoot' },
    scale: 0.72,
  },
  // Placeholder until we have a dragon: a fire-tinted barbarian.
  dragon_rider_default: {
    id: 'dragon_rider_default',
    model: 'characters/Barbarian.glb',
    props: ['1H_Axe', 'Barbarian_Round_Shield', 'Barbarian_Hat'],
    allProps: BARBARIAN_PROPS,
    teamTint: 'Cape',
    tint: [1.2, 0.85, 0.7],
    vfx: [1, 0.5, 0.15],
    anims: { ...KAYKIT_ANIMS, attack: '1H_Melee_Attack_Chop', cast: 'Throw' },
    scale: 0.72,
  },
  dragon_rider_storm: {
    id: 'dragon_rider_storm',
    model: 'characters/Barbarian.glb',
    props: ['1H_Axe', '1H_Axe_Offhand', 'Barbarian_Hat'],
    allProps: BARBARIAN_PROPS,
    teamTint: 'Cape',
    tint: [0.7, 0.88, 1.2],
    vfx: [0.5, 0.85, 1],
    anims: { ...KAYKIT_ANIMS, attack: 'Dualwield_Melee_Attack_Chop', cast: 'Throw' },
    scale: 0.72,
  },
};

export function skinArt(skinId: string, heroId: string): SkinArt {
  return SKINS[skinId] ?? SKINS[`${heroId}_default`] ?? SKINS['samurai_default'];
}

export const TEAM_RGB: Record<Color, [number, number, number]> = {
  red: [0.9, 0.22, 0.22],
  green: [0.2, 0.75, 0.38],
  yellow: [0.98, 0.72, 0.12],
  blue: [0.25, 0.48, 0.95],
};

export const TEAM_CSS: Record<Color, string> = {
  red: '#e53b3b',
  green: '#33bf61',
  yellow: '#f8b81f',
  blue: '#3f7bf2',
};

/** Environment models (KayKit hexagon pack), by role. */
export const ENV = {
  castle: (c: Color) => `env/${c}/building_castle_${c}.gltf`,
  tower: (c: Color) => `env/${c}/building_tower_A_${c}.gltf`,
  bridge: 'env/neutral/building_bridge_A.gltf',
  ruins: 'env/neutral/building_destroyed.gltf',
  stage: 'env/neutral/building_stage_A.gltf',
  trees: {
    jungle: ['env/nature/trees_A_large.gltf', 'env/nature/trees_A_medium.gltf', 'env/nature/tree_single_A.gltf', 'env/nature/trees_A_small.gltf'],
    forest: ['env/nature/trees_B_large.gltf', 'env/nature/trees_B_medium.gltf', 'env/nature/tree_single_B.gltf'],
    ruins: ['env/nature/tree_single_B.gltf', 'env/nature/trees_A_small.gltf'],
    arena: ['env/nature/trees_B_medium.gltf', 'env/nature/tree_single_A.gltf'],
  } as Record<string, string[]>,
  rocks: ['env/nature/rock_single_A.gltf', 'env/nature/rock_single_B.gltf', 'env/nature/rock_single_C.gltf', 'env/nature/rock_single_D.gltf', 'env/nature/rock_single_E.gltf'],
  hills: ['env/nature/hills_A_trees.gltf', 'env/nature/hill_single_A.gltf'],
  mountains: ['env/nature/mountain_A_grass_trees.gltf', 'env/nature/mountain_B_grass_trees.gltf', 'env/nature/mountain_C_grass.gltf'],
  clouds: ['env/nature/cloud_big.gltf', 'env/nature/cloud_small.gltf'],
  waterPlants: ['env/nature/waterlily_A.gltf', 'env/nature/waterlily_B.gltf', 'env/nature/waterplant_A.gltf', 'env/nature/waterplant_B.gltf'],
};
