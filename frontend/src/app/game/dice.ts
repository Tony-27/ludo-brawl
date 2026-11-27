import { Component, OnDestroy, computed, effect, input, output, signal, untracked } from '@angular/core';
import { Color } from '../core/models';

const PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

@Component({
  selector: 'app-dice',
  template: `
    <button
      type="button"
      class="die"
      [class]="color()"
      [class.rolling]="rolling()"
      [class.ready]="enabled()"
      [disabled]="!enabled()"
      (click)="roll.emit()"
      [attr.aria-label]="enabled() ? 'Roll the dice' : 'Dice showing ' + (value() ?? 'nothing')"
    >
      @for (i of cells; track i) {
        <span class="pip" [class.on]="pips().includes(i)"></span>
      }
    </button>
  `,
  styles: `
    :host { display: inline-block; }
    .die {
      --c: var(--line);
      width: 92px;
      height: 92px;
      padding: 14px;
      border-radius: 20px;
      background: #fffdf7;
      border: 4px solid var(--c);
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: repeat(3, 1fr);
      place-items: center;
      box-shadow: 0 8px 0 color-mix(in srgb, var(--c) 70%, #000), 0 14px 30px rgba(0,0,0,.35);
      transition: transform .12s;
      cursor: default;
    }
    .die.red { --c: var(--red); }
    .die.green { --c: var(--green); }
    .die.yellow { --c: var(--yellow); }
    .die.blue { --c: var(--blue); }
    .die.ready { cursor: pointer; animation: nudge 1.6s ease-in-out infinite; }
    .die.ready:hover { transform: translateY(-3px) rotate(-4deg); }
    .die.ready:active { transform: translateY(4px); box-shadow: 0 4px 0 color-mix(in srgb, var(--c) 70%, #000); }
    .die.rolling { animation: tumble .5s ease-out; }
    .pip { width: 16px; height: 16px; border-radius: 50%; }
    .pip.on { background: #1d1b22; }
    @keyframes tumble {
      0% { transform: rotate(0) scale(1); }
      30% { transform: rotate(140deg) scale(1.15); }
      60% { transform: rotate(250deg) scale(0.95); }
      100% { transform: rotate(360deg) scale(1); }
    }
    @keyframes nudge {
      0%, 80%, 100% { transform: rotate(0); }
      85% { transform: rotate(-8deg); }
      90% { transform: rotate(8deg); }
      95% { transform: rotate(-4deg); }
    }
  `,
})
export class Dice implements OnDestroy {
  readonly value = input<number | null>(null);
  readonly rollSeq = input(0);
  readonly color = input<Color>('red');
  readonly enabled = input(false);
  readonly roll = output<void>();

  protected readonly cells = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  protected rolling = signal(false);
  private face = signal<number | null>(null);
  protected pips = computed(() => PIPS[this.face() ?? 0] ?? []);
  private lastSeq = -1;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const seq = this.rollSeq();
      const value = this.value();
      untracked(() => {
        if (this.lastSeq === -1 || seq === this.lastSeq) {
          this.lastSeq = seq;
          if (!this.rolling()) this.face.set(value);
          return;
        }
        this.lastSeq = seq;
        this.tumble(value);
      });
    });
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private tumble(final: number | null) {
    if (this.timer) clearInterval(this.timer);
    this.rolling.set(true);
    let ticks = 0;
    this.timer = setInterval(() => {
      if (++ticks >= 6) {
        clearInterval(this.timer!);
        this.timer = null;
        this.face.set(final);
        this.rolling.set(false);
        return;
      }
      this.face.set(1 + Math.floor(Math.random() * 6));
    }, 70);
  }
}
