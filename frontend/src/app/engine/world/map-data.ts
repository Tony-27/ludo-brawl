import { Vector3 } from '@babylonjs/core';
import type { Color } from '../../core/protocol';

export type HazardType = 'pit' | 'slide' | 'portal' | 'current' | 'crumble';

/** Shape of backend/app/game/maps/*.json (served by GET /api/maps/:id). */
export interface MapNode {
  id: string;
  kind: 'normal' | 'start' | 'safe' | 'shrine' | 'home' | 'goal';
  pos: [number, number, number];
  lane?: number;
  bridge?: boolean;
  hazard?: { type: HazardType; steps?: number; to?: string; uses?: number };
}

/** A step is one tile id, or two ids (lane 0, lane 1) inside a fork. */
export type Step = string | [string, string];

export interface MapData {
  id: string;
  name: string;
  description: string;
  theme: 'wilds' | 'arena' | 'forge' | string;
  piecesPerTeam: number;
  nodes: MapNode[];
  loop: Step[];
  routes: Record<Color, Step[]>;
  camps: Record<Color, { center: [number, number, number]; slots: [number, number, number][] }>;
  goal: [number, number, number];
  zones: { from: number; to: number; biome: string }[];
  rivers: { points: [number, number][]; width: number; kind?: 'water' | 'lava' }[];
  bounds: number;
}

const lanesOf = (step: Step): string[] => (Array.isArray(step) ? step : [step]);

/** Fast lookups over a map: where does a piece with a given progress (and lane) stand? */
export class BoardLayout {
  readonly nodes = new Map<string, MapNode>();
  /** Loop index of each shared tile (both lanes of a fork share one). */
  readonly loopIndex = new Map<string, number>();

  constructor(readonly data: MapData) {
    for (const n of data.nodes) this.nodes.set(n.id, n);
    data.loop.forEach((step, i) => lanesOf(step).forEach((id) => this.loopIndex.set(id, i)));
  }

  finish(color: Color): number {
    return this.data.routes[color].length - 1;
  }

  isFork(color: Color, progress: number): boolean {
    const step = this.data.routes[color]?.[progress];
    return Array.isArray(step);
  }

  nodeAt(color: Color, progress: number, lane = 0): MapNode | null {
    if (progress < 0) return null;
    const step = this.data.routes[color]?.[progress];
    if (step === undefined) return null;
    const ids = lanesOf(step);
    return this.nodes.get(ids[Math.min(lane, ids.length - 1)]) ?? null;
  }

  /** World position of a piece (camp slot when progress is -1). */
  position(color: Color, progress: number, piece: number, lane = 0): Vector3 {
    const node = this.nodeAt(color, progress, lane);
    if (node) return Vector3.FromArray(node.pos);
    const slots = this.data.camps[color].slots;
    return Vector3.FromArray(slots[piece % slots.length]);
  }

  /** Lane a piece walking from `start` keeps at `p` (fork lanes stick until the fork ends). */
  laneAlong(color: Color, start: number, end: number, endLane: number, p: number): number {
    if (!this.isFork(color, p)) return 0;
    // Inside the same fork region as the destination: use the destination's lane.
    const [lo, hi] = p <= end ? [p, end] : [end, p];
    for (let k = lo; k <= hi; k++) if (!this.isFork(color, k)) return 0;
    void start;
    return endLane;
  }

  /** Direction a piece faces when standing still: towards its next tile. */
  forward(color: Color, progress: number, lane = 0): Vector3 {
    const here = this.nodeAt(color, progress, lane);
    const next = this.nodeAt(color, Math.min(progress + 1, this.finish(color)), lane);
    if (here && next && here !== next) return Vector3.FromArray(next.pos).subtract(Vector3.FromArray(here.pos)).normalize();
    const camp = Vector3.FromArray(this.data.camps[color].center);
    return Vector3.FromArray(this.data.goal).subtract(camp).normalize();
  }

  /** All loop tiles in order, main lane first (used for spacing and scenery). */
  loopNodes(): MapNode[] {
    return this.data.loop.map((s) => this.nodes.get(lanesOf(s)[0])!);
  }

  biomeAt(loopIndex: number): string {
    const z = this.data.zones.find((zone) => loopIndex >= zone.from && loopIndex <= zone.to);
    return z?.biome ?? this.data.theme;
  }
}
