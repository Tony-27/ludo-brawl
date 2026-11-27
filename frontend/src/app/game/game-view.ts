import { Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, viewChild } from '@angular/core';
import { COLOR_LABEL, Color, PlayerView } from '../core/models';
import { RoomStore } from '../core/room-store.service';
import { Board } from './board';
import { Dice } from './dice';
import { FINISH } from './geometry';

const MEDALS = ['🥇', '🥈', '🥉', '4th'];

@Component({
  selector: 'app-game',
  imports: [Board, Dice],
  templateUrl: './game-view.html',
  styleUrl: './game-view.scss',
})
export class GameView implements OnDestroy {
  protected store = inject(RoomStore);
  protected readonly label = COLOR_LABEL;
  protected readonly medals = MEDALS;
  protected readonly pipSlots = [0, 1, 2, 3];

  protected room = computed(() => this.store.room()!);
  protected game = computed(() => this.room().game!);
  protected finished = computed(() => this.room().state === 'finished');
  protected current = computed(() => this.playerOf(this.game().current));
  protected myColor = computed(() => this.store.me()?.color ?? null);

  protected seats = computed(() => {
    const g = this.game();
    return g.turnOrder.map((color) => {
      const pieces = g.pieces[color] ?? [];
      const rank = g.ranking.indexOf(color);
      return {
        color,
        player: this.playerOf(color),
        home: pieces.filter((p) => p >= FINISH).length,
        rank: rank === -1 ? null : rank,
        active: !this.finished() && g.current === color,
      };
    });
  });

  protected podium = computed(() =>
    this.game().ranking.map((color, i) => ({ color, medal: MEDALS[i], player: this.playerOf(color) })),
  );

  protected status = computed(() => {
    const g = this.game();
    if (this.finished()) return 'Game over!';
    const who = this.current();
    if (this.store.myTurn()) {
      return g.phase === 'roll' ? 'Your turn. Roll the dice!' : 'Pick a highlighted piece to move.';
    }
    if (!who) return '';
    return g.phase === 'roll' ? `${who.name} is rolling…` : `${who.name} is choosing a move…`;
  });

  protected canRoll = computed(() => this.store.myTurn() && this.game().phase === 'roll' && !this.store.busy());
  protected canMove = computed(() => this.store.myTurn() && this.game().phase === 'move' && !this.store.busy());

  // Turn countdown for humans.
  private now = signal(Date.now());
  private clock = setInterval(() => this.now.set(Date.now()), 250);
  protected timeLeft = computed(() => {
    const deadline = this.store.turnDeadline();
    if (deadline === null || this.finished()) return null;
    return Math.max(0, Math.ceil((deadline - this.now()) / 1000));
  });
  protected timePct = computed(() => {
    const t = this.timeLeft();
    return t === null ? 0 : Math.min(100, (t / 30) * 100);
  });

  private logEl = viewChild<ElementRef<HTMLElement>>('log');
  protected showResults = signal(true);

  constructor() {
    effect(() => {
      void this.room().log.length;
      const el = this.logEl()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
    // Re-open the results dialog whenever a game ends.
    effect(() => {
      if (this.finished()) this.showResults.set(true);
    });
  }

  ngOnDestroy() {
    clearInterval(this.clock);
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, [role=button]')) return;
    if ((e.key === ' ' || e.key === 'Enter') && this.canRoll()) {
      e.preventDefault();
      this.store.roll();
    }
  }

  protected playerOf(color: Color): PlayerView | null {
    return this.room().players.find((p) => p.color === color) ?? null;
  }
}
