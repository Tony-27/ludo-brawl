import { Vector3 } from '@babylonjs/core';
import type { Color } from '../../core/protocol';

/** Shape of backend/app/game/maps/*.json (served by GET /api/maps/:id). */
export interface MapNode {
  id: string;
  kind: 'normal' | 'start' | 'safe' | 'shrine' | 'home' | 'goal';
  pos: [number, number, number];
  bridge?: boolean;
}

export interface MapData {
  id: string;
  name: string;
  description: string;
  theme: 'wilds' | 'arena' | string;
  piecesPerTeam: number;
  nodes: MapNode[];
  loop: string[];
  routes: Record<Color, string[]>;
  camps: Record<Color, { center: [number, number, number]; slots: [number, number, number][] }>;
  goal: [number, number, number];
  zones: { from: number; to: number; biome: string }[];
  rivers: { points: [number, number][]; width: number }[];
  bounds: number;
}

/** Fast lookups over a map: where does a piece with a given progress stand? */
export class BoardLayout {
  readonly nodes = new Map<string, MapNode>();

  constructor(readonly data: MapData) {
    for (const n of data.nodes) this.nodes.set(n.id, n);
  }

  finish(color: Color): number {
    return this.data.routes[color].length - 1;
  }

  nodeAt(color: Color, progress: number): MapNode | null {
    if (progress < 0) return null;
    const id = this.data.routes[color]?.[progress];
    return id ? this.nodes.get(id) ?? null : null;
  }

  /** World position of a piece (camp slot when progress is -1). */
  position(color: Color, progress: number, piece: number): Vector3 {
    const node = this.nodeAt(color, progress);
    if (node) return Vector3.FromArray(node.pos);
    const slot = this.data.camps[color].slots[piece % this.data.camps[color].slots.length];
    return Vector3.FromArray(slot);
  }

  /** Direction a piece faces when standing still: towards its next tile. */
  forward(color: Color, progress: number): Vector3 {
    const here = this.nodeAt(color, progress);
    const next = this.nodeAt(color, Math.min(progress + 1, this.finish(color)));
    if (here && next && here !== next) return Vector3.FromArray(next.pos).subtract(Vector3.FromArray(here.pos)).normalize();
    const camp = Vector3.FromArray(this.data.camps[color].center);
    return Vector3.FromArray(this.data.goal).subtract(camp).normalize();
  }

  biomeAt(loopIndex: number): string {
    const z = this.data.zones.find((zone) => loopIndex >= zone.from && loopIndex <= zone.to);
    return z?.biome ?? this.data.theme;
  }
}
