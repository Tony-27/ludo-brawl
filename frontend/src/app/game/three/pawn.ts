import * as THREE from 'three';
import { Color } from '../../core/models';

/** Characters are a bit bigger than one board square's worth of 'piece'. */
export const PAWN_SCALE = 1.3;

export type Expression = 'normal' | 'happy' | 'angry' | 'scared' | 'dizzy';

export const TEAM_HEX: Record<Color, number> = {
  red: 0xe0403f,
  green: 0x2fae5f,
  yellow: 0xf0b21a,
  blue: 0x3d72e8,
};

/** Each colour is a little fantasy class with its own look. */
export const TEAM_CLASS: Record<Color, string> = {
  red: 'Warrior',
  green: 'Ranger',
  yellow: 'Wizard',
  blue: 'Knight',
};

const SKIN: Record<Color, number> = {
  red: 0xe8b38c,
  green: 0xf2cfa5,
  yellow: 0xd6a477,
  blue: 0xf6d7b8,
};

const shared = {
  base: new THREE.CylinderGeometry(0.27, 0.3, 0.07, 24),
  body: new THREE.CylinderGeometry(0.13, 0.23, 0.38, 20),
  belt: new THREE.TorusGeometry(0.175, 0.025, 8, 24),
  head: new THREE.SphereGeometry(0.19, 24, 18),
  // A cap of a slightly larger sphere, so the face follows the head's curve.
  face: new THREE.SphereGeometry(0.196, 24, 16, Math.PI / 2 - 0.85, 1.7, Math.PI / 2 - 0.85, 1.7),
  hit: new THREE.CylinderGeometry(0.34, 0.34, 1.0, 12),
  ring: new THREE.RingGeometry(0.3, 0.46, 40),
  arrow: new THREE.ConeGeometry(0.1, 0.2, 4),
  star: new THREE.OctahedronGeometry(0.05, 0),
  dark: new THREE.MeshStandardMaterial({ color: 0x2a2433, roughness: 0.6, metalness: 0.2 }),
  metal: new THREE.MeshStandardMaterial({ color: 0xc4c8d4, roughness: 0.35, metalness: 0.6 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x7a4a26, roughness: 0.8 }),
  bone: new THREE.MeshStandardMaterial({ color: 0xf3ead2, roughness: 0.5 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xf6c84a, roughness: 0.35, metalness: 0.55 }),
  starMat: new THREE.MeshBasicMaterial({ color: 0xffe066 }),
  hitMat: new THREE.MeshBasicMaterial({ visible: false }),
};

export class Pawn {
  readonly root = new THREE.Group(); // board position
  readonly lift = new THREE.Group(); // hop height / squash
  readonly spin = new THREE.Group(); // facing + flips
  readonly hit: THREE.Mesh;
  readonly weapon = new THREE.Group();

  private faceCanvas = document.createElement('canvas');
  private faceTex: THREE.CanvasTexture;
  private expression: Expression = 'normal';
  private blinking = false;
  private nextBlink = 1 + Math.random() * 3;
  private ring: THREE.Mesh;
  private arrow: THREE.Mesh;
  private stars = new THREE.Group();
  private highlighted = false;
  private idlePhase = Math.random() * Math.PI * 2;
  yaw = 0;
  /** While an animation drives the pawn, idle motion pauses. */
  busy = false;

  constructor(
    readonly color: Color,
    readonly index: number,
  ) {
    const team = new THREE.MeshStandardMaterial({ color: TEAM_HEX[color], roughness: 0.45, metalness: 0.1 });
    const skin = new THREE.MeshStandardMaterial({ color: SKIN[color], roughness: 0.7 });

    this.root.scale.setScalar(PAWN_SCALE);
    this.root.add(this.lift);
    this.lift.add(this.spin);

    const base = new THREE.Mesh(shared.base, shared.dark);
    base.position.y = 0.035;
    const body = new THREE.Mesh(shared.body, team);
    body.position.y = 0.26;
    const belt = new THREE.Mesh(shared.belt, shared.dark);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.2;
    const head = new THREE.Mesh(shared.head, skin);
    head.position.y = 0.6;

    this.faceCanvas.width = this.faceCanvas.height = 128;
    this.faceTex = new THREE.CanvasTexture(this.faceCanvas);
    this.faceTex.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.Mesh(
      shared.face,
      new THREE.MeshBasicMaterial({ map: this.faceTex, transparent: true, alphaTest: 0.05 }),
    );
    face.position.set(0, 0.6, 0);

    this.spin.add(base, body, belt, head, face);
    this.buildGear(color, team);

    // Gather the head and everything worn on it into one group, then make it a
    // bit big (cartoon proportions) and tilt it back so faces read from above.
    const headGroup = new THREE.Group();
    headGroup.position.y = 0.6;
    for (const part of [...this.spin.children]) {
      if (part !== this.weapon && part.position.y >= 0.55) {
        part.position.y -= 0.6;
        headGroup.add(part);
      }
    }
    headGroup.scale.setScalar(1.2);
    headGroup.rotation.x = -0.3;
    this.spin.add(headGroup);
    this.spin.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== face) o.castShadow = true;
    });

    // Dizzy stars orbit the head after a knockout.
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(shared.star, shared.starMat);
      s.position.set(Math.cos((i / 3) * Math.PI * 2) * 0.24, 0, Math.sin((i / 3) * Math.PI * 2) * 0.24);
      this.stars.add(s);
    }
    this.stars.position.y = 0.85;
    this.stars.visible = false;
    this.lift.add(this.stars);

    this.ring = new THREE.Mesh(
      shared.ring,
      new THREE.MeshBasicMaterial({ color: 0xffc21a, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.02;
    this.ring.visible = false;
    this.root.add(this.ring);

    // A bouncing "pick me" arrow above movable pieces.
    this.arrow = new THREE.Mesh(shared.arrow, new THREE.MeshBasicMaterial({ color: 0xffd23f }));
    this.arrow.rotation.x = Math.PI;
    this.arrow.position.y = 1.25;
    this.arrow.visible = false;
    this.root.add(this.arrow);

    this.hit = new THREE.Mesh(shared.hit, shared.hitMat);
    this.hit.position.y = 0.5;
    this.hit.userData['pawn'] = this;
    this.root.add(this.hit);

    this.drawFace();
  }

  private buildGear(color: Color, team: THREE.Material) {
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, p: [number, number, number], r: [number, number, number] = [0, 0, 0], parent: THREE.Object3D = this.spin) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...p);
      m.rotation.set(...r);
      parent.add(m);
      return m;
    };

    this.weapon.position.set(0.27, 0.32, 0.05);
    this.spin.add(this.weapon);

    switch (color) {
      case 'red': {
        // Horned helmet + axe.
        add(new THREE.SphereGeometry(0.205, 20, 10, 0, Math.PI * 2, 0, Math.PI / 3), shared.metal, [0, 0.62, 0]);
        add(new THREE.ConeGeometry(0.045, 0.2, 10), shared.bone, [0.2, 0.75, 0], [0, 0, -1.0]);
        add(new THREE.ConeGeometry(0.045, 0.2, 10), shared.bone, [-0.2, 0.75, 0], [0, 0, 1.0]);
        add(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), shared.wood, [0, 0.1, 0], [0, 0, 0], this.weapon);
        add(new THREE.BoxGeometry(0.16, 0.13, 0.03), shared.metal, [0.07, 0.3, 0], [0, 0, 0], this.weapon);
        break;
      }
      case 'green': {
        // Hood + feather + bow.
        add(new THREE.ConeGeometry(0.22, 0.3, 20, 1, true), team, [0, 0.74, -0.05], [-0.35, 0, 0]);
        add(new THREE.CylinderGeometry(0.012, 0.03, 0.22, 6), shared.bone, [0.12, 0.85, -0.08], [0.3, 0, -0.5]);
        add(new THREE.TorusGeometry(0.2, 0.015, 6, 20, Math.PI), shared.wood, [0, 0.15, 0], [0, 0, -Math.PI / 2], this.weapon);
        add(new THREE.CylinderGeometry(0.004, 0.004, 0.4, 4), shared.bone, [0, 0.15, 0], [0, 0, 0], this.weapon);
        break;
      }
      case 'yellow': {
        // Pointy hat + staff with a glowing orb.
        add(new THREE.CylinderGeometry(0.3, 0.3, 0.025, 24), team, [0, 0.74, 0]);
        add(new THREE.ConeGeometry(0.17, 0.42, 20), team, [0, 0.96, -0.02], [-0.15, 0, 0.1]);
        add(new THREE.CylinderGeometry(0.02, 0.025, 0.7, 8), shared.wood, [0, 0.18, 0], [0, 0, 0], this.weapon);
        const orb = add(
          new THREE.SphereGeometry(0.07, 16, 12),
          new THREE.MeshStandardMaterial({ color: 0x9ff0ff, emissive: 0x44c8ff, emissiveIntensity: 1.6 }),
          [0, 0.56, 0],
          [0, 0, 0],
          this.weapon,
        );
        orb.castShadow = false;
        break;
      }
      case 'blue': {
        // Crowned helmet with plume, sword and shield.
        add(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 20, 1, true), shared.gold, [0, 0.74, 0]);
        add(new THREE.SphereGeometry(0.08, 12, 10), team, [0, 0.88, -0.04]).scale.set(0.8, 1.6, 1.4);
        add(new THREE.BoxGeometry(0.035, 0.5, 0.012), shared.metal, [0, 0.3, 0], [0, 0, 0], this.weapon);
        add(new THREE.BoxGeometry(0.14, 0.03, 0.03), shared.gold, [0, 0.06, 0], [0, 0, 0], this.weapon);
        const shield = add(new THREE.CylinderGeometry(0.15, 0.15, 0.03, 20), team, [-0.26, 0.3, 0.08], [Math.PI / 2, 0, 0.2]);
        add(new THREE.TorusGeometry(0.15, 0.015, 6, 24), shared.gold, [0, 0.016, 0], [Math.PI / 2, 0, 0], shield);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ face
  setExpression(e: Expression) {
    if (this.expression === e) return;
    this.expression = e;
    this.stars.visible = e === 'dizzy';
    this.drawFace();
  }

  private drawFace() {
    const g = this.faceCanvas.getContext('2d')!;
    const e = this.expression;
    g.clearRect(0, 0, 128, 128);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const ink = '#2b1d1a';

    // Blush
    g.fillStyle = 'rgba(255,110,110,0.35)';
    g.beginPath();
    g.ellipse(30, 78, 11, 7, 0, 0, Math.PI * 2);
    g.ellipse(98, 78, 11, 7, 0, 0, Math.PI * 2);
    g.fill();

    const eye = (x: number) => {
      g.strokeStyle = ink;
      g.fillStyle = ink;
      g.lineWidth = 6;
      if (e === 'dizzy') {
        g.beginPath();
        g.moveTo(x - 9, 50);
        g.lineTo(x + 9, 68);
        g.moveTo(x + 9, 50);
        g.lineTo(x - 9, 68);
        g.stroke();
        return;
      }
      if (e === 'happy' || this.blinking) {
        g.beginPath();
        if (e === 'happy') g.arc(x, 64, 10, Math.PI * 1.1, Math.PI * 1.9);
        else {
          g.moveTo(x - 10, 60);
          g.lineTo(x + 10, 60);
        }
        g.stroke();
        return;
      }
      const big = e === 'scared' ? 15 : 12;
      g.fillStyle = '#fff';
      g.beginPath();
      g.ellipse(x, 58, big * 0.85, big, 0, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 3;
      g.stroke();
      g.fillStyle = ink;
      g.beginPath();
      g.arc(x + (e === 'angry' ? 0 : 2), 60, e === 'scared' ? 4 : 6.5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(x + 4, 56, 2.2, 0, Math.PI * 2);
      g.fill();
    };
    eye(42);
    eye(86);

    // Brows
    g.strokeStyle = ink;
    g.lineWidth = 6;
    g.beginPath();
    if (e === 'angry') {
      g.moveTo(28, 36);
      g.lineTo(54, 46);
      g.moveTo(100, 36);
      g.lineTo(74, 46);
    } else if (e === 'scared') {
      g.moveTo(30, 38);
      g.lineTo(52, 32);
      g.moveTo(98, 38);
      g.lineTo(76, 32);
    }
    g.stroke();

    // Mouth
    g.lineWidth = 5;
    g.beginPath();
    switch (e) {
      case 'happy':
        g.fillStyle = '#7a2230';
        g.moveTo(46, 84);
        g.quadraticCurveTo(64, 112, 82, 84);
        g.closePath();
        g.fill();
        g.stroke();
        break;
      case 'angry':
        g.fillStyle = '#fff';
        g.rect(48, 86, 32, 11);
        g.fill();
        g.stroke();
        g.beginPath();
        g.moveTo(56, 86);
        g.lineTo(56, 97);
        g.moveTo(64, 86);
        g.lineTo(64, 97);
        g.moveTo(72, 86);
        g.lineTo(72, 97);
        g.lineWidth = 2;
        g.stroke();
        break;
      case 'scared':
        g.fillStyle = '#5a1a24';
        g.ellipse(64, 92, 8, 10, 0, 0, Math.PI * 2);
        g.fill();
        break;
      case 'dizzy':
        g.moveTo(46, 92);
        g.quadraticCurveTo(52, 84, 58, 92);
        g.quadraticCurveTo(64, 100, 70, 92);
        g.quadraticCurveTo(76, 84, 82, 92);
        g.stroke();
        break;
      default:
        g.arc(64, 82, 13, Math.PI * 0.2, Math.PI * 0.8);
        g.stroke();
    }
    this.faceTex.needsUpdate = true;
  }

  // ------------------------------------------------------------------ state
  setHighlight(on: boolean) {
    this.highlighted = on;
    this.ring.visible = on;
    this.arrow.visible = on;
  }

  update(dt: number, t: number) {
    // Blink every few seconds.
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && (this.expression === 'normal' || this.expression === 'angry')) {
      this.blinking = !this.blinking;
      this.nextBlink = this.blinking ? 0.12 : 2 + Math.random() * 4;
      this.drawFace();
    }

    if (!this.busy) {
      // Gentle breathing bob; movable pawns bounce eagerly.
      const amp = this.highlighted ? 0.06 : 0.012;
      const speed = this.highlighted ? 7 : 2.2;
      this.lift.position.y = Math.abs(Math.sin(t * speed + this.idlePhase)) * amp;
      const targetYaw = this.yaw;
      this.spin.rotation.y += (targetYaw - this.spin.rotation.y) * Math.min(1, dt * 6);
    }
    this.weapon.rotation.z = Math.sin(t * 1.7 + this.idlePhase) * 0.06;

    if (this.stars.visible) this.stars.rotation.y += dt * 5;
    if (this.highlighted) {
      const s = 1 + Math.sin(t * 6) * 0.08;
      this.ring.scale.set(s, s, s);
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.65 + Math.sin(t * 6) * 0.3;
      this.arrow.position.y = 1.25 + Math.abs(Math.sin(t * 5)) * 0.2;
      this.arrow.rotation.y += dt * 3;
    }
  }

  /** Turn to look at a world point (yaw only). */
  lookAt(x: number, z: number, immediate = false) {
    const dx = x - this.root.position.x;
    const dz = z - this.root.position.z;
    if (Math.abs(dx) + Math.abs(dz) < 1e-3) return;
    let target = Math.atan2(dx, dz);
    // Choose the shortest rotation.
    const cur = this.spin.rotation.y;
    while (target - cur > Math.PI) target -= Math.PI * 2;
    while (target - cur < -Math.PI) target += Math.PI * 2;
    this.yaw = target;
    if (immediate) this.spin.rotation.y = target;
  }

  dispose() {
    this.faceTex.dispose();
  }
}
