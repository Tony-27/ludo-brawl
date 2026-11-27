import {
  AbstractMesh,
  AnimationGroup,
  AssetContainer,
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { Color } from '../../core/protocol';
import { AnimState, SkinArt, TEAM_RGB } from '../assets/catalog';
import { Animator, ease, lerp } from '../core/tween';

let actorSeq = 0;

/**
 * A hero on the board: an animated glTF character with a team-coloured cape,
 * skin tint, selection ring and status effects. Movement and combat moves are
 * promise-based so the event player can sequence them.
 */
export class CharacterActor {
  readonly root: TransformNode; // board position + facing
  readonly body: TransformNode; // hop height, squash, knockback spin
  readonly pickMeshes: AbstractMesh[] = [];
  private anims = new Map<string, AnimationGroup>();
  private current: AnimationGroup | null = null;
  private currentState: AnimState | null = null;
  private ring: Mesh;
  private ringMat: StandardMaterial;
  private marker: Mesh;
  private shield: Mesh;
  private roots: Mesh;
  private yaw = 0;
  private targetYaw = 0;
  private highlighted = false;
  busy = false;

  constructor(
    private scene: Scene,
    container: AssetContainer,
    readonly skin: SkinArt,
    readonly team: Color,
    readonly piece: number,
    shadows: ShadowGenerator,
    private tween: Animator,
  ) {
    const id = actorSeq++;
    this.root = new TransformNode(`actor${id}`, scene);
    this.body = new TransformNode(`actorBody${id}`, scene);
    this.body.parent = this.root;

    const inst = container.instantiateModelsToScene((n) => `${n}`, true, { doNotInstantiate: true });
    const model = inst.rootNodes[0] as TransformNode;
    model.parent = this.body;
    model.scaling.scaleInPlace(skin.scale);

    const [tr, tg, tb] = TEAM_RGB[team];
    const isProp = (name: string) => skin.allProps.some((p) => name === p || name.startsWith(`${p}_primitive`));
    const keep = (name: string) => skin.props.some((p) => name === p || name.startsWith(`${p}_primitive`));
    for (const mesh of model.getChildMeshes()) {
      if (isProp(mesh.name) && !keep(mesh.name)) {
        mesh.setEnabled(false);
        continue;
      }
      let mat = mesh.material;
      if (mat instanceof PBRMaterial) {
        if (mesh.name.includes(skin.teamTint)) {
          // Body parts share one atlas material: give the cape its own copy before dyeing it.
          mat = mat.clone(`${mat.name}_team_${team}`);
          mesh.material = mat;
          (mat as PBRMaterial).albedoColor = new Color3(tr, tg, tb);
          (mat as PBRMaterial).albedoTexture = null;
        } else if (skin.tint) {
          mat.albedoColor = new Color3(...skin.tint);
        }
        (mat as PBRMaterial).environmentIntensity = 0.6;
      }
      mesh.receiveShadows = true;
      mesh.isPickable = true;
      mesh.metadata = { actor: this };
      shadows.addShadowCaster(mesh);
      this.pickMeshes.push(mesh);
    }
    for (const g of inst.animationGroups) {
      g.stop();
      g.enableBlending = true;
      g.blendingSpeed = 0.12;
      // Names come back as "<clip>" or "Clone of <clip>".
      this.anims.set(g.name.replace(/^Clone of /, ''), g);
    }

    // Team ring under the feet, brighter when this piece can be moved.
    this.ringMat = new StandardMaterial(`ring${id}`, scene);
    this.ringMat.emissiveColor = new Color3(tr, tg, tb);
    this.ringMat.diffuseColor = Color3.Black();
    this.ringMat.alpha = 0.55;
    this.ringMat.disableLighting = true;
    this.ring = MeshBuilder.CreateTorus(`ringMesh${id}`, { diameter: 0.95, thickness: 0.06, tessellation: 40 }, scene);
    this.ring.material = this.ringMat;
    this.ring.parent = this.root;
    this.ring.position.y = 0.03;
    this.ring.isPickable = false;

    // Floating "pick me" marker.
    const markerMat = new StandardMaterial(`marker${id}`, scene);
    markerMat.emissiveColor = new Color3(1, 0.85, 0.25);
    markerMat.disableLighting = true;
    this.marker = MeshBuilder.CreateCylinder(`markerMesh${id}`, { height: 0.32, diameterTop: 0.26, diameterBottom: 0, tessellation: 4 }, scene);
    this.marker.material = markerMat;
    this.marker.parent = this.root;
    this.marker.position.y = 2.4;
    this.marker.isPickable = false;
    this.marker.setEnabled(false);

    const shieldMat = new StandardMaterial(`shield${id}`, scene);
    shieldMat.emissiveColor = new Color3(1, 0.9, 0.5);
    shieldMat.alpha = 0.22;
    shieldMat.disableLighting = true;
    shieldMat.backFaceCulling = false;
    this.shield = MeshBuilder.CreateSphere(`shieldMesh${id}`, { diameter: 1.7, segments: 16 }, scene);
    this.shield.material = shieldMat;
    this.shield.parent = this.root;
    this.shield.position.y = 0.8;
    this.shield.isPickable = false;
    this.shield.setEnabled(false);

    const rootMat = new StandardMaterial(`vines${id}`, scene);
    rootMat.diffuseColor = new Color3(0.25, 0.5, 0.15);
    rootMat.emissiveColor = new Color3(0.05, 0.2, 0.03);
    this.roots = MeshBuilder.CreateTorusKnot(`vinesMesh${id}`, { radius: 0.35, tube: 0.05, radialSegments: 64, p: 3, q: 7 }, scene);
    this.roots.material = rootMat;
    this.roots.parent = this.root;
    this.roots.position.y = 0.25;
    this.roots.scaling.y = 0.5;
    this.roots.isPickable = false;
    this.roots.setEnabled(false);

    this.play('idle');
  }

  // ------------------------------------------------------------------ animation
  play(state: AnimState, opts: { loop?: boolean; speed?: number } = {}): Promise<void> {
    const loop = opts.loop ?? (state === 'idle' || state === 'run' || state === 'castLoop');
    const group = this.anims.get(this.skin.anims[state]) ?? this.anims.get(this.skin.anims.idle);
    if (!group) return Promise.resolve();
    if (this.current === group && loop && this.currentState === state) return Promise.resolve();
    if (this.current && this.current !== group) this.current.stop();
    this.current = group;
    this.currentState = state;
    group.start(loop, opts.speed ?? 1, group.from, group.to, false);
    if (loop) return Promise.resolve();
    return new Promise((resolve) => {
      group.onAnimationGroupEndObservable.addOnce(() => resolve());
    });
  }

  /** Play a one-shot animation and return to idle afterwards. */
  async oneShot(state: AnimState, speed = 1): Promise<void> {
    await this.play(state, { loop: false, speed });
    if (this.currentState === state) this.play('idle');
  }

  // ------------------------------------------------------------------ placement
  get position(): Vector3 {
    return this.root.position;
  }

  place(at: Vector3, facing?: Vector3) {
    this.root.position.copyFrom(at);
    if (facing) this.faceDirection(facing, true);
  }

  faceDirection(dir: Vector3, immediate = false) {
    if (Math.abs(dir.x) + Math.abs(dir.z) < 1e-4) return;
    let target = Math.atan2(dir.x, dir.z);
    while (target - this.yaw > Math.PI) target -= Math.PI * 2;
    while (target - this.yaw < -Math.PI) target += Math.PI * 2;
    this.targetYaw = target;
    if (immediate) this.yaw = target;
  }

  faceTo(point: Vector3, immediate = false) {
    this.faceDirection(point.subtract(this.root.position), immediate);
  }

  /** Run along a list of tile positions, hopping lightly from tile to tile. */
  async runAlong(points: Vector3[], secondsPerTile = 0.28): Promise<void> {
    if (!points.length) return;
    this.busy = true;
    void this.play('run', { speed: 1.25 });
    for (const to of points) {
      const from = this.root.position.clone();
      this.faceTo(to);
      const hop = Math.min(0.35, Vector3.Distance(from, to) * 0.18);
      await this.tween.tween(secondsPerTile, (t) => {
        Vector3.LerpToRef(from, to, t, this.root.position);
        this.body.position.y = Math.sin(Math.PI * t) * hop;
      });
    }
    this.body.position.y = 0;
    this.play('idle');
    this.busy = false;
  }

  /** A big arcing jump (leaving camp, leaping into an attack, landing home). */
  async leap(to: Vector3, height = 1.6, seconds = 0.6, flip = false): Promise<void> {
    this.busy = true;
    const from = this.root.position.clone();
    this.faceTo(to);
    void this.play('jump', { loop: false, speed: 1.4 });
    await this.tween.tween(seconds, (t) => {
      Vector3.LerpToRef(from, to, t, this.root.position);
      this.body.position.y = Math.sin(Math.PI * t) * height;
      if (flip) this.body.rotation.x = t * Math.PI * 2;
    });
    this.body.rotation.x = 0;
    this.body.position.y = 0;
    await this.squash();
    void this.oneShot('land', 1.6);
    this.busy = false;
  }

  /** Knocked back along the trail: stagger, fly backwards, land. */
  async knockedBack(points: Vector3[], seconds = 0.75): Promise<void> {
    this.busy = true;
    void this.play('hit', { loop: false, speed: 1.3 });
    const from = this.root.position.clone();
    const to = points.length ? points[points.length - 1] : from;
    const lookAt = from.subtract(to);
    this.faceDirection(lookAt, true);
    await this.tween.tween(seconds, (t) => {
      // Follow the trail so we never cut across the map.
      const f = t * (points.length - 1 || 1);
      const i = Math.min(points.length - 1, Math.floor(f));
      const a = i === 0 ? from : points[i - 1] ?? from;
      const b = points[i] ?? to;
      Vector3.LerpToRef(a, b, f - Math.floor(f), this.root.position);
      if (points.length <= 1) Vector3.LerpToRef(from, to, t, this.root.position);
      this.body.position.y = Math.sin(Math.PI * t) * 1.2;
      this.body.rotation.x = -Math.sin(Math.PI * t) * 0.6;
    });
    this.body.rotation.x = 0;
    this.body.position.y = 0;
    await this.squash(0.35);
    this.play('idle');
    this.busy = false;
  }

  /** Sent flying all the way back to camp. */
  async launchedHome(to: Vector3, facing: Vector3): Promise<void> {
    this.busy = true;
    void this.play('knockdown', { loop: false, speed: 1.4 });
    const from = this.root.position.clone();
    const spin = Math.random() < 0.5 ? -1 : 1;
    await this.tween.tween(1.25, (t) => {
      Vector3.LerpToRef(from, to, t, this.root.position);
      this.body.position.y = Math.sin(Math.PI * t) * 5;
      this.body.rotation.x = t * Math.PI * 4;
      this.body.rotation.z = spin * t * Math.PI * 2;
    });
    this.body.rotation.set(0, 0, 0);
    this.body.position.y = 0;
    this.faceDirection(facing, true);
    await this.squash(0.4);
    await this.oneShot('standUp', 1.5);
    this.busy = false;
  }

  async squash(amount = 0.22): Promise<void> {
    await this.tween.tween(0.14, (t) => {
      const s = Math.sin(Math.PI * t) * amount;
      this.body.scaling.set(1 + s * 0.5, 1 - s, 1 + s * 0.5);
    });
    this.body.scaling.set(1, 1, 1);
  }

  // ------------------------------------------------------------------ state visuals
  setHighlighted(on: boolean) {
    this.highlighted = on;
    this.marker.setEnabled(on);
    this.ringMat.alpha = on ? 1 : 0.55;
  }

  setStatus(status: 'shield' | 'rooted', active: boolean) {
    (status === 'shield' ? this.shield : this.roots).setEnabled(active);
  }

  update(dt: number, t: number) {
    this.yaw = lerp(this.yaw, this.targetYaw, Math.min(1, dt * 10));
    this.root.rotation.y = this.yaw;
    if (this.highlighted) {
      this.marker.position.y = 2.4 + Math.abs(Math.sin(t * 5)) * 0.25;
      this.marker.rotation.y += dt * 3;
      const s = 1 + Math.sin(t * 6) * 0.1;
      this.ring.scaling.set(s, 1, s);
    } else {
      this.ring.scaling.set(1, 1, 1);
    }
    if (this.shield.isEnabled()) this.shield.rotation.y += dt;
    if (this.roots.isEnabled()) this.roots.rotation.y += dt * 0.5;
  }

  dispose() {
    for (const g of this.anims.values()) g.dispose();
    this.root.dispose(false, true);
  }
}

export { ease };
