import { Component, OnDestroy, computed, effect, input, output, signal, untracked } from '@angular/core';
import { Color, GameView, PlayerView } from '../core/models';
import {
  FINISH,
  HOME_COLUMN,
  SAFE_SQUARES,
  TRACK,
  YARD,
  YARD_ORIGIN,
  piecePoint,
  trackColorAt,
} from './geometry';

type Positions = Partial<Record<Color, number[]>>;

interface RenderedPiece {
  key: string;
  color: Color;
  piece: number;
  x: number;
  y: number;
  scale: number;
  movable: boolean;
}

const STEP_MS = 140;
const ALL: Color[] = ['red', 'green', 'yellow', 'blue'];

@Component({
  selector: 'app-board',
  templateUrl: './board.html',
  styleUrl: './board.scss',
})
export class Board implements OnDestroy {
  readonly game = input.required<GameView>();
  readonly players = input.required<PlayerView[]>();
  readonly myColor = input<Color | null>(null);
  readonly canMove = input(false);
  readonly move = output<number>();

  protected readonly colors = ALL;
  protected readonly track = TRACK.map((cell, i) => ({
    cell,
    safe: SAFE_SQUARES.has(i),
    startOf: trackColorAt(i),
  }));
  protected readonly homeColumns = ALL.flatMap((color) => HOME_COLUMN[color].map((cell) => ({ color, cell })));
  protected readonly yardOrigin = YARD_ORIGIN;
  protected readonly yardSlots = [0, 1, 2, 3];

  /** Positions currently drawn; lags behind the server while a move animates. */
  private shown = signal<Positions>({});
  protected animating = signal(false);
  protected hovered = signal<number | null>(null);
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    effect(() => {
      const game = this.game();
      untracked(() => this.sync(game));
    });
  }

  ngOnDestroy() {
    this.cancel();
  }

  protected nameFor(color: Color): string {
    return this.players().find((p) => p.color === color)?.name ?? '';
  }

  protected inGame(color: Color): boolean {
    return this.game().turnOrder.includes(color);
  }

  protected movablePieces = computed(() => {
    const g = this.game();
    if (!this.canMove() || this.animating() || g.phase !== 'move' || g.current !== this.myColor()) {
      return new Set<number>();
    }
    return new Set(g.legalPieces);
  });

  protected pieces = computed<RenderedPiece[]>(() => {
    const shown = this.shown();
    const movable = this.movablePieces();
    const mine = this.myColor();
    const raw: RenderedPiece[] = [];
    for (const color of ALL) {
      (shown[color] ?? []).forEach((progress, piece) => {
        const [x, y] = piecePoint(color, progress, piece);
        raw.push({ key: `${color}${piece}`, color, piece, x, y, scale: 1, movable: color === mine && movable.has(piece) });
      });
    }
    // Spread out pieces sharing a square so they all stay visible and clickable.
    const groups = new Map<string, RenderedPiece[]>();
    for (const p of raw) {
      const k = `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const r = 0.2;
      group.forEach((p, i) => {
        const a = (i / group.length) * Math.PI * 2 - Math.PI / 4;
        p.x += Math.cos(a) * r;
        p.y += Math.sin(a) * r;
        p.scale = 0.7;
      });
    }
    // Draw movable pieces last so they sit on top.
    return raw.sort((a, b) => Number(a.movable) - Number(b.movable));
  });

  protected ghost = computed(() => {
    const piece = this.hovered();
    const g = this.game();
    const color = this.myColor();
    if (piece === null || !color || !this.movablePieces().has(piece) || g.lastRoll === null) return null;
    const from = g.pieces[color]?.[piece] ?? YARD;
    const to = from === YARD ? 0 : from + g.lastRoll;
    const [x, y] = piecePoint(color, to, piece);
    return { x, y, color };
  });

  protected onPiece(p: RenderedPiece) {
    if (p.movable) {
      this.hovered.set(null);
      this.move.emit(p.piece);
    }
  }

  protected transform(p: RenderedPiece) {
    return `translate(${p.x}px, ${p.y}px) scale(${p.scale})`;
  }

  // ---------------------------------------------------------------- animation
  private cancel() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.animating.set(false);
  }

  private sync(game: GameView) {
    this.cancel();
    const target: Positions = clone(game.pieces);
    const shown = this.shown();
    const mv = game.lastMove;
    const fromShown = mv ? shown[mv.color]?.[mv.piece] : undefined;

    // Animate the last move step by step if we are currently showing its start.
    if (mv && fromShown === mv.start && mv.start >= 0 && mv.end > mv.start && mv.end <= FINISH) {
      const frame: Positions = clone(shown);
      // Anything else that changed (other than captured pieces) snaps right away.
      for (const color of ALL) {
        if (!target[color]) {
          delete frame[color];
          continue;
        }
        frame[color] = target[color]!.map((p, i) => {
          const captured = mv.captures.some((c) => c.color === color && c.piece === i);
          if (color === mv.color && i === mv.piece) return mv.start;
          return captured ? (shown[color]?.[i] ?? p) : p;
        });
      }
      this.shown.set(frame);
      this.animating.set(true);
      for (let step = mv.start + 1; step <= mv.end; step++) {
        const at = step;
        this.timers.push(
          setTimeout(() => {
            this.shown.update((s) => {
              const next = clone(s);
              next[mv.color]![mv.piece] = at;
              return next;
            });
          }, (step - mv.start) * STEP_MS),
        );
      }
      this.timers.push(
        setTimeout(() => {
          this.shown.set(target);
          this.animating.set(false);
        }, (mv.end - mv.start) * STEP_MS + (mv.captures.length ? 220 : 0)),
      );
      return;
    }
    this.shown.set(target);
  }
}

function clone(p: Positions): Positions {
  const out: Positions = {};
  for (const [k, v] of Object.entries(p)) out[k as Color] = [...(v ?? [])];
  return out;
}
