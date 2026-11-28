import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { Animator } from '../core/tween';

type RGB = [number, number, number];

const FACES: { value: number; normal: Vector3 }[] = [
  { value: 1, normal: new Vector3(0, 1, 0) },
  { value: 6, normal: new Vector3(0, -1, 0) },
  { value: 2, normal: new Vector3(0, 0, 1) },
  { value: 5, normal: new Vector3(0, 0, -1) },
  { value: 3, normal: new Vector3(1, 0, 0) },
  { value: 4, normal: new Vector3(-1, 0, 0) },
];

const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.27, 0.25], [0.73, 0.25], [0.27, 0.5], [0.73, 0.5], [0.27, 0.75], [0.73, 0.75]],
};

/** A big die that gets thrown onto the board next to whoever is rolling. */
export class WorldDice {
  readonly root: TransformNode;
  private body: Mesh;
  private bodyMat: StandardMaterial;
  private faces: { value: number; normal: Vector3; mat: StandardMaterial; tex: DynamicTexture }[] = [];

  constructor(
    private scene: Scene,
    shadows: ShadowGenerator,
    private tween: Animator,
  ) {
    this.root = new TransformNode('dice', scene);
    this.bodyMat = new StandardMaterial('diceBody', scene);
    this.bodyMat.diffuseColor = new Color3(0.95, 0.93, 0.88);
    this.bodyMat.specularColor = new Color3(0.4, 0.4, 0.4);
    this.body = MeshBuilder.CreateBox('diceBody', { size: 0.96 }, scene);
    this.body.material = this.bodyMat;
    this.body.parent = this.root;
    this.body.isPickable = false;
    shadows.addShadowCaster(this.body);

    for (const f of FACES) {
      const tex = new DynamicTexture(`diceFace${f.value}`, { width: 128, height: 128 }, scene, true);
      const mat = new StandardMaterial(`diceFaceMat${f.value}`, scene);
      mat.diffuseTexture = tex;
      mat.specularColor = new Color3(0.3, 0.3, 0.3);
      const plane = MeshBuilder.CreatePlane(`diceFacePlane${f.value}`, { size: 0.98 }, scene);
      plane.material = mat;
      plane.parent = this.root;
      plane.isPickable = false;
      // Planes face -z by default; orient so their visible side points along the face normal.
      plane.position = f.normal.scale(0.5);
      plane.lookAt(plane.position.add(f.normal.scale(-1)));
      this.faces.push({ ...f, mat, tex });
    }
    this.paint([0.9, 0.22, 0.22]);
    this.root.setEnabled(false);
  }

  paint(color: RGB) {
    const css = `rgb(${color.map((c) => Math.round(c * 255)).join(',')})`;
    this.bodyMat.diffuseColor = new Color3(...color);
    this.bodyMat.emissiveColor = new Color3(color[0] * 0.15, color[1] * 0.15, color[2] * 0.15);
    for (const f of this.faces) {
      const g = f.tex.getContext() as CanvasRenderingContext2D;
      g.fillStyle = css;
      g.fillRect(0, 0, 128, 128);
      const grad = g.createRadialGradient(48, 40, 8, 64, 64, 100);
      grad.addColorStop(0, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(0,0,0,0.15)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      for (const [x, y] of PIPS[f.value]) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.beginPath();
        g.arc(x * 128 + 2, y * 128 + 3, 12, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fffaf0';
        g.beginPath();
        g.arc(x * 128, y * 128, 12, 0, Math.PI * 2);
        g.fill();
      }
      f.tex.update();
    }
  }

  /** Throw from `from` to land at `to` showing `value` on top. */
  async throw(from: Vector3, to: Vector3, value: number, color: RGB): Promise<void> {
    this.paint(color);
    const face = FACES.find((f) => f.value === value) ?? FACES[0];
    // Rotation that turns the face's normal straight up, plus a random twist.
    const up = new Quaternion();
    Quaternion.FromUnitVectorsToRef(face.normal, Vector3.Up(), up);
    const final = Quaternion.RotationAxis(Vector3.Up(), Math.random() * Math.PI * 2).multiply(up);
    const axis = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const start = Quaternion.RotationAxis(axis, Math.random() * 6);
    this.gen++;
    this.root.setEnabled(true);
    this.root.scaling.setAll(0.55);
    this.root.rotationQuaternion = start.clone();
    const landY = to.y + 0.33;
    await this.tween.tween(0.85, (t) => {
      // Two bounces that settle.
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      const bounce = t < 0.55 ? Math.sin((t / 0.55) * Math.PI) * 2.2 : Math.sin(((t - 0.55) / 0.45) * Math.PI) * 0.5;
      const y = from.y + (landY - from.y) * Math.min(1, t / 0.55) + bounce;
      this.root.position.set(x, Math.max(landY, y), z);
      const spin = Quaternion.RotationAxis(axis, (1 - t) * (1 - t) * Math.PI * 8);
      Quaternion.SlerpToRef(start, final, 1 - Math.pow(1 - t, 3), this.root.rotationQuaternion!);
      this.root.rotationQuaternion!.multiplyInPlace(spin);
    });
    this.root.rotationQuaternion = final;
    this.root.position.y = landY;
  }

  /** A throw started after a hide was requested cancels that hide. */
  private gen = 0;

  hide(delay = 1.2) {
    if (!this.root.isEnabled()) return;
    const gen = this.gen;
    if (delay <= 0) {
      this.root.setEnabled(false);
      return;
    }
    void this.tween.wait(delay).then(() => {
      if (gen !== this.gen) return;
      return this.tween
        .tween(0.25, (t) => gen === this.gen && this.root.scaling.setAll(0.55 * (1 - t)))
        .then(() => gen === this.gen && this.root.setEnabled(false));
    });
  }

  dispose() {
    this.root.dispose(false, true);
  }
}
