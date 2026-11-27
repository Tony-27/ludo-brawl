import { Component, ElementRef, OnDestroy, afterNextRender, effect, inject, input, output, untracked, viewChild } from '@angular/core';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { SoundService } from '../audio/sound.service';
import { Color } from '../core/models';
import { TEAM_HEX } from './three/pawn';

// BoxGeometry material order is +x, -x, +y, -y, +z, -z. Opposite faces add up to 7.
const FACE_VALUES = [3, 4, 1, 6, 2, 5];
// Rotation that turns the face showing `value` towards the camera (+z).
const SHOW: Record<number, THREE.Euler> = {
  1: new THREE.Euler(Math.PI / 2, 0, 0),
  2: new THREE.Euler(0, 0, 0),
  3: new THREE.Euler(0, -Math.PI / 2, 0),
  4: new THREE.Euler(0, Math.PI / 2, 0),
  5: new THREE.Euler(0, Math.PI, 0),
  6: new THREE.Euler(-Math.PI / 2, 0, 0),
};
const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.27, 0.25], [0.73, 0.25], [0.27, 0.5], [0.73, 0.5], [0.27, 0.75], [0.73, 0.75]],
};

@Component({
  selector: 'app-dice',
  template: `
    <button
      type="button"
      class="die"
      [class.ready]="enabled()"
      [disabled]="!enabled()"
      (click)="roll.emit()"
      [attr.aria-label]="enabled() ? 'Roll the dice' : 'Dice showing ' + (value() ?? 'nothing')"
    >
      <div #stage class="stage"></div>
      @if (enabled()) {
        <span class="tag">ROLL!</span>
      }
    </button>
  `,
  styles: `
    :host { display: inline-block; }
    .die {
      position: relative;
      width: 112px;
      height: 112px;
      padding: 0;
      border: none;
      border-radius: 24px;
      background: radial-gradient(circle at 50% 40%, #ffffff14, transparent 70%);
      cursor: default;
    }
    .stage, .stage canvas { width: 100%; height: 100%; display: block; }
    .die.ready { cursor: pointer; }
    .die.ready:hover { background: radial-gradient(circle at 50% 40%, #ffffff2a, transparent 70%); }
    .die:focus-visible { outline: 3px solid var(--yellow); outline-offset: 2px; }
    .tag {
      position: absolute;
      left: 50%;
      bottom: -4px;
      transform: translateX(-50%);
      font-size: 0.7rem;
      font-weight: 900;
      letter-spacing: 0.15em;
      color: #1d1630;
      background: var(--yellow);
      padding: 2px 8px;
      border-radius: 999px;
      animation: pulse 1s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes pulse { 50% { transform: translateX(-50%) scale(1.1); } }
  `,
})
export class Dice implements OnDestroy {
  readonly value = input<number | null>(null);
  readonly rollSeq = input(0);
  readonly color = input<Color>('red');
  readonly enabled = input(false);
  readonly roll = output<void>();

  private stage = viewChild.required<ElementRef<HTMLElement>>('stage');
  private sound = inject(SoundService);

  private renderer?: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
  private cube?: THREE.Mesh;
  private glow = new THREE.PointLight(0xffffff, 0, 6);
  private faces: THREE.MeshStandardMaterial[] = [];
  private raf = 0;
  private clock = new THREE.Clock();
  private lastSeq = -1;
  private rollStart = -1;
  private fromQ = new THREE.Quaternion();
  private targetQ = new THREE.Quaternion().setFromEuler(SHOW[1]);
  private spinAxis = new THREE.Vector3(1, 1, 0).normalize();
  private paintedColor: Color | null = null;

  constructor() {
    afterNextRender(() => this.init());
    effect(() => {
      const seq = this.rollSeq();
      const value = this.value();
      const color = this.color();
      untracked(() => {
        this.paint(color);
        if (this.lastSeq === -1 || seq === this.lastSeq) {
          this.lastSeq = seq;
          if (value && this.rollStart < 0) this.targetQ.setFromEuler(SHOW[value]);
          if (this.cube && this.rollStart < 0) this.cube.quaternion.copy(this.targetQ);
          return;
        }
        this.lastSeq = seq;
        this.startRoll(value ?? 1);
      });
    });
  }

  private init() {
    const el = this.stage().nativeElement;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(112, 112, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(this.renderer.domElement);

    this.camera.position.set(0, 1.1, 4.3);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x443366, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 4, 3);
    this.scene.add(key, this.glow);
    this.glow.position.set(0, -0.5, 1.5);

    for (let i = 0; i < 6; i++) this.faces.push(new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 }));
    this.cube = new THREE.Mesh(new RoundedBoxGeometry(1.25, 1.25, 1.25, 4, 0.18), this.faces);
    this.scene.add(this.cube);
    this.paintedColor = null;
    this.paint(this.color());
    this.cube.quaternion.copy(this.targetQ);
    this.loop();
  }

  private paint(color: Color) {
    if (!this.cube || this.paintedColor === color) return;
    this.paintedColor = color;
    const base = '#' + TEAM_HEX[color].toString(16).padStart(6, '0');
    this.faces.forEach((mat, i) => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      const grad = g.createRadialGradient(50, 40, 10, 64, 64, 100);
      grad.addColorStop(0, '#ffffff55');
      grad.addColorStop(1, '#00000000');
      g.fillStyle = base;
      g.fillRect(0, 0, 128, 128);
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      for (const [x, y] of PIPS[FACE_VALUES[i]]) {
        g.fillStyle = '#00000055';
        g.beginPath();
        g.arc(x * 128 + 2, y * 128 + 3, 12, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fffaf0';
        g.beginPath();
        g.arc(x * 128, y * 128, 12, 0, Math.PI * 2);
        g.fill();
      }
      mat.map?.dispose();
      mat.map = new THREE.CanvasTexture(c);
      mat.map.colorSpace = THREE.SRGBColorSpace;
      mat.needsUpdate = true;
    });
    this.glow.color.set(TEAM_HEX[color]);
  }

  private startRoll(value: number) {
    if (!this.cube) return;
    this.sound.play('dice');
    this.fromQ.copy(this.cube.quaternion);
    // Land on the right face, with a random twist so it never looks the same.
    this.targetQ.setFromEuler(SHOW[value]);
    this.spinAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.rollStart = this.clock.elapsedTime;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.renderer || !this.cube) return;
    this.clock.getDelta();
    const now = this.clock.elapsedTime;
    const cube = this.cube;

    if (this.rollStart >= 0) {
      const t = Math.min(1, (now - this.rollStart) / 0.9);
      // Tumble: big spins early that slow down, then settle onto the target face.
      const spin = new THREE.Quaternion().setFromAxisAngle(this.spinAxis, (1 - t) ** 2 * Math.PI * 6);
      const settle = this.fromQ.clone().slerp(this.targetQ, 1 - (1 - t) ** 3);
      cube.quaternion.copy(spin.multiply(settle));
      cube.position.y = Math.abs(Math.sin(t * Math.PI * 2.5)) * (1 - t) * 0.9;
      const s = 1 + Math.sin(t * Math.PI) * 0.12;
      cube.scale.setScalar(s);
      this.glow.intensity = 8 * (1 - t);
      if (t >= 1) {
        this.rollStart = -1;
        cube.quaternion.copy(this.targetQ);
        cube.position.y = 0;
        cube.scale.setScalar(1);
      }
    } else if (this.enabled()) {
      // Eager hover and wiggle: "roll me!"
      cube.position.y = 0.12 + Math.sin(now * 3) * 0.08;
      const wobble = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(now * 2.3) * 0.18, Math.sin(now * 1.7) * 0.35, 0));
      cube.quaternion.copy(this.targetQ).premultiply(wobble);
      this.glow.intensity = 3 + Math.sin(now * 4) * 1.5;
    } else {
      cube.position.y *= 0.9;
      cube.quaternion.slerp(this.targetQ, 0.15);
      this.glow.intensity *= 0.9;
    }
    this.renderer.render(this.scene, this.camera);
  };

  ngOnDestroy() {
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
  }
}
