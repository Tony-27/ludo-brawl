import * as THREE from 'three';

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  max: number;
  gravity: number;
  shrink: boolean;
}

interface Floater {
  sprite: THREE.Sprite;
  life: number;
  max: number;
  rise: number;
}

const sparkGeo = new THREE.TetrahedronGeometry(0.07, 0);
const puffGeo = new THREE.IcosahedronGeometry(0.12, 0);
const confettiGeo = new THREE.PlaneGeometry(0.1, 0.06);

/** Particles, floating combat text, impact flashes and camera shake. */
export class Fx {
  private particles: Particle[] = [];
  private floaters: Floater[] = [];
  private flash = new THREE.PointLight(0xffffff, 0, 7, 1.5);
  private flashLife = 0;
  private shakeAmt = 0;
  readonly shakeOffset = new THREE.Vector3();

  constructor(private scene: THREE.Scene) {
    scene.add(this.flash);
  }

  burst(at: THREE.Vector3, opts: { color: number; count?: number; speed?: number; up?: number; gravity?: number; life?: number; kind?: 'spark' | 'puff' | 'confetti' }) {
    const { color, count = 24, speed = 3, up = 2, gravity = 9, life = 0.8, kind = 'spark' } = opts;
    for (let i = 0; i < count; i++) {
      const geo = kind === 'puff' ? puffGeo : kind === 'confetti' ? confettiGeo : sparkGeo;
      const tint = kind === 'confetti' ? new THREE.Color().setHSL(Math.random(), 0.85, 0.6) : new THREE.Color(color);
      const mat = new THREE.MeshBasicMaterial({
        color: tint,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: kind === 'spark' ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(at);
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      const vel = new THREE.Vector3(Math.cos(a) * s, up * (0.5 + Math.random()), Math.sin(a) * s);
      this.scene.add(mesh);
      const max = life * (0.7 + Math.random() * 0.6);
      this.particles.push({
        mesh,
        vel,
        spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10),
        life: max,
        max,
        gravity,
        shrink: kind !== 'confetti',
      });
    }
  }

  text(at: THREE.Vector3, label: string, color = '#ffe14d') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 192;
    const g = canvas.getContext('2d')!;
    g.font = '900 120px "Segoe UI Black", Impact, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 22;
    g.strokeStyle = '#1b1028';
    g.strokeText(label, 256, 100);
    g.fillStyle = color;
    g.fillText(label, 256, 100);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.position.copy(at);
    sprite.renderOrder = 10;
    sprite.scale.set(0.1, 0.04, 1);
    this.scene.add(sprite);
    this.floaters.push({ sprite, life: 1.2, max: 1.2, rise: 1.2 });
  }

  impact(at: THREE.Vector3, color: number, shake = 0.35) {
    this.flash.position.copy(at).add(new THREE.Vector3(0, 0.8, 0));
    this.flash.color.set(color);
    this.flashLife = 0.35;
    this.shakeAmt = Math.max(this.shakeAmt, shake);
  }

  shake(amount: number) {
    this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  update(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(1 - dt * 0.8);
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      const k = Math.max(0, p.life / p.max);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, k * 1.5);
      if (p.shrink) p.mesh.scale.setScalar(0.3 + k * 0.9);
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
      }
    }

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      const t = 1 - f.life / f.max;
      const pop = t < 0.15 ? t / 0.15 : 1;
      const s = 2.4 * (pop < 1 ? 0.5 + pop * 0.7 : 1.2 - Math.min(0.2, (t - 0.15) * 0.3));
      f.sprite.scale.set(s, s * 0.375, 1);
      f.sprite.position.y += f.rise * dt * (1 - t);
      (f.sprite.material as THREE.SpriteMaterial).opacity = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      if (f.life <= 0) {
        this.scene.remove(f.sprite);
        f.sprite.material.map?.dispose();
        f.sprite.material.dispose();
        this.floaters.splice(i, 1);
      }
    }

    if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flash.intensity = Math.max(0, this.flashLife / 0.35) * 40;
    } else {
      this.flash.intensity = 0;
    }

    if (this.shakeAmt > 0.001) {
      this.shakeOffset.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).multiplyScalar(this.shakeAmt);
      this.shakeAmt *= Math.pow(0.02, dt);
    } else {
      this.shakeOffset.set(0, 0, 0);
    }
  }
}
