import {
  Color3,
  Color4,
  DynamicTexture,
  GlowLayer,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PointLight,
  Scene,
  StandardMaterial,
  Texture,
  Vector3,
} from '@babylonjs/core';
import { Animator, ease } from '../core/tween';

type RGB = [number, number, number];

/** One-shot visual effects. Everything cleans itself up. */
export class Effects {
  readonly glow: GlowLayer;
  private flare: Texture;
  private flash: PointLight;

  constructor(
    private scene: Scene,
    private tween: Animator,
  ) {
    this.glow = new GlowLayer('glow', scene, { mainTextureSamples: 2, blurKernelSize: 48 });
    this.glow.intensity = 0.6;
    const t = new DynamicTexture('flare', { width: 64, height: 64 }, scene, false);
    const g = t.getContext() as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    t.update();
    this.flare = t;
    this.flash = new PointLight('fxFlash', Vector3.Zero(), scene);
    this.flash.intensity = 0;
    this.flash.range = 9;
  }

  private burst(at: Vector3, opts: { color: RGB; count: number; power: [number, number]; life: [number, number]; size: [number, number]; gravity?: number; up?: number; additive?: boolean }) {
    const ps = new ParticleSystem('burst', opts.count, this.scene);
    ps.particleTexture = this.flare;
    ps.emitter = at.clone();
    ps.minEmitBox = ps.maxEmitBox = Vector3.Zero();
    const [r, g, b] = opts.color;
    ps.color1 = new Color4(r, g, b, 1);
    ps.color2 = new Color4(Math.min(1, r + 0.3), Math.min(1, g + 0.3), Math.min(1, b + 0.3), 1);
    ps.colorDead = new Color4(r, g, b, 0);
    ps.minSize = opts.size[0];
    ps.maxSize = opts.size[1];
    ps.minLifeTime = opts.life[0];
    ps.maxLifeTime = opts.life[1];
    ps.minEmitPower = opts.power[0];
    ps.maxEmitPower = opts.power[1];
    ps.direction1 = new Vector3(-1, opts.up ?? 1, -1);
    ps.direction2 = new Vector3(1, (opts.up ?? 1) * 2, 1);
    ps.gravity = new Vector3(0, -(opts.gravity ?? 6), 0);
    ps.blendMode = opts.additive === false ? ParticleSystem.BLENDMODE_STANDARD : ParticleSystem.BLENDMODE_ADD;
    ps.manualEmitCount = opts.count;
    ps.targetStopDuration = opts.life[1];
    ps.disposeOnStop = true;
    ps.start();
  }

  impact(at: Vector3, color: RGB, big = true) {
    const p = at.add(new Vector3(0, 0.8, 0));
    this.burst(p, { color, count: big ? 70 : 30, power: [2, big ? 7 : 4], life: [0.25, 0.6], size: [0.08, 0.3] });
    this.burst(p, { color: [1, 1, 1], count: big ? 30 : 12, power: [4, 9], life: [0.1, 0.3], size: [0.05, 0.15] });
    this.dust(at, big ? 24 : 10);
    this.shockwave(at, color);
    this.lightFlash(p, color, big ? 60 : 25);
  }

  dust(at: Vector3, count = 14) {
    this.burst(at.add(new Vector3(0, 0.1, 0)), { color: [0.75, 0.68, 0.55], count, power: [0.6, 1.8], life: [0.4, 0.9], size: [0.25, 0.6], gravity: -0.5, up: 0.4, additive: false });
  }

  sparkle(at: Vector3, color: RGB, count = 50) {
    this.burst(at.add(new Vector3(0, 0.4, 0)), { color, count, power: [1, 3], life: [0.6, 1.4], size: [0.06, 0.18], gravity: -1.5, up: 2.5 });
  }

  manaGain(at: Vector3) {
    this.burst(at.add(new Vector3(0, 0.6, 0)), { color: [0.4, 0.7, 1], count: 18, power: [0.4, 1.2], life: [0.6, 1.1], size: [0.08, 0.16], gravity: -2.5, up: 1.5 });
  }

  lightFlash(at: Vector3, color: RGB, intensity: number) {
    this.flash.position.copyFrom(at);
    this.flash.diffuse = new Color3(...color);
    void this.tween.tween(0.35, (t) => (this.flash.intensity = intensity * (1 - t)), ease.outQuad);
  }

  shockwave(at: Vector3, color: RGB) {
    const ring = MeshBuilder.CreateTorus('shock', { diameter: 1, thickness: 0.08, tessellation: 48 }, this.scene);
    const mat = new StandardMaterial('shockMat', this.scene);
    mat.emissiveColor = new Color3(...color);
    mat.disableLighting = true;
    ring.material = mat;
    ring.position.copyFrom(at).addInPlaceFromFloats(0, 0.1, 0);
    ring.isPickable = false;
    void this.tween
      .tween(0.45, (t) => {
        ring.scaling.setAll(1 + t * 4);
        mat.alpha = 1 - t;
      }, ease.outCubic)
      .then(() => {
        ring.dispose();
        mat.dispose();
      });
  }

  /** A sweeping blade arc in front of `at`, facing `dir`. */
  slash(at: Vector3, dir: Vector3, color: RGB, reach = 2) {
    // A crescent: a tapered ribbon along a 160° arc.
    const outer: Vector3[] = [];
    const inner: Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = -Math.PI * 0.45 + (i / 24) * Math.PI * 0.9;
      const w = Math.sin((i / 24) * Math.PI) * 0.28;
      outer.push(new Vector3(Math.cos(a) * (reach * 0.8 + w), 0, Math.sin(a) * (reach * 0.8 + w)));
      inner.push(new Vector3(Math.cos(a) * (reach * 0.8 - w), 0, Math.sin(a) * (reach * 0.8 - w)));
    }
    const arc = MeshBuilder.CreateRibbon('slash', { pathArray: [outer, inner], sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    const mat = new StandardMaterial('slashMat', this.scene);
    mat.emissiveColor = new Color3(...color);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    arc.material = mat;
    arc.position.copyFrom(at).addInPlaceFromFloats(0, 0.9, 0);
    // Ribbon's centre points along +x; turn it to face `dir`.
    arc.rotation.y = Math.atan2(dir.x, dir.z) - Math.PI / 2;
    arc.rotation.x = 0.25;
    arc.isPickable = false;
    void this.tween
      .tween(0.4, (t) => {
        arc.rotation.y += 0.12;
        arc.scaling.setAll(0.7 + t * 0.6);
        mat.alpha = 1 - t * t;
      })
      .then(() => {
        arc.dispose();
        mat.dispose();
      });
    this.burst(arc.position, { color, count: 40, power: [2, 5], life: [0.2, 0.5], size: [0.05, 0.14], gravity: 2 });
  }

  /** Jagged lightning bolt from the sky (or a caster) onto a target. */
  lightning(from: Vector3, to: Vector3, color: RGB) {
    const pts: Vector3[] = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const p = Vector3.Lerp(from, to, i / steps);
      if (i > 0 && i < steps) p.addInPlaceFromFloats((Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.7);
      pts.push(p);
    }
    const bolt = MeshBuilder.CreateTube('bolt', { path: pts, radius: 0.06, tessellation: 6, cap: Mesh.CAP_ALL }, this.scene);
    const mat = new StandardMaterial('boltMat', this.scene);
    mat.emissiveColor = new Color3(...color);
    mat.disableLighting = true;
    bolt.material = mat;
    bolt.isPickable = false;
    this.lightFlash(to.add(new Vector3(0, 1, 0)), color, 90);
    void this.tween
      .tween(0.35, (t) => (mat.alpha = t < 0.5 ? 1 : 1 - (t - 0.5) * 2))
      .then(() => {
        bolt.dispose();
        mat.dispose();
      });
  }

  /** Swirl of light where a hero vanishes / reappears. */
  blink(at: Vector3, color: RGB) {
    this.burst(at.add(new Vector3(0, 0.8, 0)), { color, count: 60, power: [0.5, 2.5], life: [0.3, 0.7], size: [0.06, 0.2], gravity: -3, up: 1.5 });
    this.shockwave(at, color);
  }

  /** Big floating combat text ("BONK!", "+2", "BLOCKED"). */
  text(at: Vector3, label: string, color = '#ffe14d', size = 1) {
    const tex = new DynamicTexture('fxText', { width: 512, height: 192 }, this.scene, true);
    tex.hasAlpha = true;
    const g = tex.getContext() as CanvasRenderingContext2D;
    g.clearRect(0, 0, 512, 192);
    g.font = '900 118px "Segoe UI Black", Impact, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 22;
    g.strokeStyle = '#1b1028';
    g.strokeText(label, 256, 100, 490);
    g.fillStyle = color;
    g.fillText(label, 256, 100, 490);
    tex.update();
    const plane = MeshBuilder.CreatePlane('fxTextPlane', { width: 2.4 * size, height: 0.9 * size }, this.scene);
    const mat = new StandardMaterial('fxTextMat', this.scene);
    mat.diffuseTexture = tex;
    mat.opacityTexture = tex;
    mat.emissiveColor = Color3.White();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    plane.material = mat;
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.position.copyFrom(at).addInPlaceFromFloats(0, 2.2, 0);
    plane.isPickable = false;
    plane.renderingGroupId = 1;
    const start = plane.position.y;
    void this.tween
      .tween(1.3, (t) => {
        const pop = t < 0.12 ? ease.outBack(t / 0.12) : 1;
        plane.scaling.setAll(0.4 + pop * 0.6);
        plane.position.y = start + t * 1.2;
        mat.alpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      })
      .then(() => {
        plane.dispose();
        mat.dispose();
        tex.dispose();
      });
  }

  dispose() {
    this.glow.dispose();
    this.flare.dispose();
    this.flash.dispose();
  }
}
