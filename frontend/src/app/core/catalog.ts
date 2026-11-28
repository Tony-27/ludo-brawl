import type { Color } from './protocol';

/** GET /api/heroes */
export interface AbilityInfo {
  id: string;
  name: string;
  slot: 'basic' | 'utility' | 'ultimate';
  cost: number;
  targeting: 'ownPiece' | 'ownPieceSteps' | 'enemyPiece' | 'tile' | 'none';
  effect: string;
  description: string;
  params: Record<string, number | boolean>;
}

export interface SkinInfo {
  id: string;
  name: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
}

export interface HeroInfo {
  id: string;
  name: string;
  title: string;
  role: string;
  selectable: boolean;
  passive: string | null;
  skins: SkinInfo[];
  abilities: AbilityInfo[];
}

/** GET /api/maps */
export interface MapSummary {
  id: string;
  name: string;
  description: string;
  theme: string;
  teams: Color[];
  tiles: number;
  piecesPerTeam: number;
  features: string[];
}

export const COLOR_LABEL: Record<Color, string> = { red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue' };
