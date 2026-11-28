import { Vector3 } from '@babylonjs/core';
import type { Color } from '../../core/protocol';

export type HazardType =
  | 'pit'
  | 'slide'
  | 'portal'
  | 'current'
  | 'crumble'
  | 'ice'
  | 'thin_ice'
  | 'spring'
  | 'anvil'
  | 'conveyor';

/** Shape of backend/app/game/maps/*.json (served by GET /api/maps/:id). */
export interface MapNode {
  id: string;
  kind: 'normal' | 'start' | 'safe' | 'shrine' | 'home' | 'goal';
  pos: [number, number, number];
  bridge?: boolean;
  lake?: boolean;
  cliff?: boolean;
  hazard?: { type: HazardType; steps?: number; to?: string; uses?: number };
}

/** A loop/route entry: one tile id, or a region with several branches. */
export type Step = string | { region: string };

export interface MapRegion {
  name: string;
  branches: { name: string; tag: string; nodes: string[] }[];
}

export interface MapEventSpec {
  type: 'eruption' | 'avalanche' | 'freeze' | 'conveyor';
  tiles?: string[];
  every?: number;
  region?: string;
  branch?: number;
}

export interface MapData {
  id: string;
  name: string;
  description: string;
  theme: 'wilds' | 'arena' | 'forge' | 'frost' | string;
  piecesPerTeam: number;
  nodes: MapNode[];
  loop: Step[];
  regions?: Record<string, MapRegion>;
  routes: Record<Color, Step[]>;
  events?: MapEventSpec[];
  camps: Record<Color, { center: [number, number, number]; slots: [number, number, number][] }>;
  goal: [number, number, number];
  zones: { from: number; to: number; biome: string }[];
  rivers: { points: [number, number][]; width: number; kind?: 'water' | 'lava' }[];
  lakes?: { center: [number, number]; radius: number }[];
  bounds: number;
}

/**
 * Lookups over a map. The server tells the client which tile every piece
 * stands on and which tiles each move walks, so the client only needs
 * geometry and neighbours here, never the route rules.
 */
export class BoardLayout {
  readonly nodes = new Map<string, MapNode>();
  /** Approximate position on the shared loop (branch tiles get a proportional index). */
  readonly loopIndex = new Map<string, number>();
  readonly loopLength: number;
  /** Region/branch a tile belongs to. */
  readonly branchOf = new Map<string, { region: string; branch: number }>();
  private nextOf = new Map<string, string>();
  private prevOf = new Map<string, string>();
  private mainPaths = new Map<Color, string[]>();

  constructor(readonly data: MapData) {
    for (const n of data.nodes) this.nodes.set(n.id, n);
    const regions = data.regions ?? {};
    let i = 0;
    for (const step of data.loop) {
      if (typeof step === 'string') {
        this.loopIndex.set(step, i++);
        continue;
      }
      const region = regions[step.region];
      const span = region.branches[0].nodes.length;
      region.branches.forEach((b, bi) => {
        const n = b.nodes.length;
        b.nodes.forEach((id, k) => {
          this.loopIndex.set(id, i + (n > 1 ? Math.round((k * (span - 1)) / (n - 1)) : 0));
          this.branchOf.set(id, { region: step.region, branch: bi });
        });
      });
      i += span;
    }
    this.loopLength = i;

    // Neighbours along every branch of every route.
    for (const [color, route] of Object.entries(data.routes) as [Color, Step[]][]) {
      const main: string[] = [];
      let prevTails: string[] = [];
      const link = (from: string, to: string) => {
        if (!this.nextOf.has(from)) this.nextOf.set(from, to);
        if (!this.prevOf.has(to)) this.prevOf.set(to, from);
      };
      for (const step of route) {
        if (typeof step === 'string') {
          for (const t of prevTails) link(t, step);
          prevTails = [step];
          main.push(step);
          continue;
        }
        const tails: string[] = [];
        regions[step.region].branches.forEach((b, bi) => {
          b.nodes.forEach((id, k) => {
            if (k === 0) for (const t of prevTails) link(t, id);
            else link(b.nodes[k - 1], id);
          });
          tails.push(b.nodes[b.nodes.length - 1]);
          if (bi === 0) main.push(...b.nodes);
        });
        prevTails = tails;
      }
      this.mainPaths.set(color, main);
    }
  }

  /** The team's route taking every region's main branch. */
  mainPath(color: Color): string[] {
    return this.mainPaths.get(color) ?? [];
  }

  next(id: string): MapNode | null {
    const n = this.nextOf.get(id);
    return n ? (this.nodes.get(n) ?? null) : null;
  }

  prev(id: string): MapNode | null {
    const n = this.prevOf.get(id);
    return n ? (this.nodes.get(n) ?? null) : null;
  }

  tilePos(id: string): Vector3 | null {
    const n = this.nodes.get(id);
    return n ? Vector3.FromArray(n.pos) : null;
  }

  /** World position of a piece: its tile, or its camp slot. */
  position(color: Color, tile: string | null | undefined, piece: number): Vector3 {
    const at = tile ? this.tilePos(tile) : null;
    if (at) return at;
    const slots = this.data.camps[color].slots;
    return Vector3.FromArray(slots[piece % slots.length]);
  }

  /** Direction a piece faces when standing still: towards its next tile. */
  forward(color: Color, tile: string | null | undefined): Vector3 {
    const here = tile ? this.nodes.get(tile) : null;
    const next = here ? this.next(here.id) : null;
    if (here && next) return Vector3.FromArray(next.pos).subtract(Vector3.FromArray(here.pos)).normalize();
    const camp = Vector3.FromArray(this.data.camps[color].center);
    return Vector3.FromArray(this.data.goal).subtract(camp).normalize();
  }

  /** The shared loop along main branches (used for spacing and scenery). */
  loopNodes(): MapNode[] {
    const regions = this.data.regions ?? {};
    const out: MapNode[] = [];
    for (const step of this.data.loop) {
      if (typeof step === 'string') out.push(this.nodes.get(step)!);
      else out.push(...regions[step.region].branches[0].nodes.map((id) => this.nodes.get(id)!));
    }
    return out;
  }

  biomeAt(loopIndex: number): string {
    const z = this.data.zones.find((zone) => loopIndex >= zone.from && loopIndex <= zone.to);
    return z?.biome ?? this.data.theme;
  }
}
