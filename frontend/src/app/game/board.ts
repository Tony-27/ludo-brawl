import { Component, ElementRef, OnDestroy, afterNextRender, effect, inject, input, output } from '@angular/core';
import { SoundService } from '../audio/sound.service';
import { Color, GameView, PlayerView } from '../core/models';
import { BoardScene } from './three/board-scene';

/** Hosts the Three.js tabletop and feeds it game snapshots. */
@Component({
  selector: 'app-board',
  template: `<div class="hint">Drag to rotate · scroll to zoom</div>`,
  styles: `
    :host {
      display: block;
      position: relative;
      width: 100%;
      aspect-ratio: 1;
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
      background: #15122b;
      cursor: grab;
    }
    :host:active { cursor: grabbing; }
    .hint {
      position: absolute;
      left: 12px;
      bottom: 10px;
      z-index: 1;
      font-size: 0.75rem;
      color: #fff9;
      pointer-events: none;
      text-shadow: 0 1px 2px #000;
    }
  `,
})
export class Board implements OnDestroy {
  readonly game = input.required<GameView>();
  readonly players = input.required<PlayerView[]>();
  readonly myColor = input<Color | null>(null);
  readonly canMove = input(false);
  readonly move = output<number>();

  private host = inject(ElementRef<HTMLElement>);
  private sound = inject(SoundService);
  private scene: BoardScene | null = null;

  constructor() {
    afterNextRender(() => {
      this.scene = new BoardScene(this.host.nativeElement);
      this.scene.onPick = (piece) => this.move.emit(piece);
      this.scene.onEvent = (e) => this.sound.sceneEvent(e);
      this.push();
    });
    effect(() => {
      // Track all inputs, then hand them to the scene.
      this.game();
      this.players();
      this.myColor();
      this.canMove();
      this.push();
    });
  }

  private push() {
    this.scene?.setState(this.game(), this.players(), this.myColor(), this.canMove());
  }

  ngOnDestroy() {
    this.scene?.dispose();
    this.scene = null;
  }
}
