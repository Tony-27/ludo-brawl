import { ArcRotateCamera, Scene, Vector3 } from '@babylonjs/core';
import { lerp } from '../core/tween';

export interface Shot {
  target: Vector3;
  radius: number;
  beta: number; // polar angle, 0 = straight down
  alpha?: number; // keep current azimuth when omitted
}

/**
 * Drives an ArcRotateCamera like a game camera: an overview of the board,
 * following the hero who is acting, and short cinematic shots for big
 * moments. If the player grabs the camera, the director backs off for a few
 * seconds and then eases back in.
 */
export class CameraDirector {
  readonly camera: ArcRotateCamera;
  private goal: Shot;
  private follow: (() => Vector3) | null = null;
  private stiffness = 3;
  private userUntil = 0;
  private time = 0;
  private shake = 0;
  private homeAlpha: number;

  constructor(
    scene: Scene,
    canvas: HTMLCanvasElement,
    private bounds: number,
  ) {
    this.homeAlpha = -Math.PI / 2;
    this.camera = new ArcRotateCamera('cam', this.homeAlpha, 0.9, bounds * 1.9, Vector3.Zero(), scene);
    this.camera.fov = 0.75;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 600;
    this.camera.lowerRadiusLimit = 4;
    this.camera.upperRadiusLimit = bounds * 3;
    this.camera.lowerBetaLimit = 0.25;
    this.camera.upperBetaLimit = 1.38;
    this.camera.wheelDeltaPercentage = 0.01;
    this.camera.panningSensibility = 0;
    this.camera.inertia = 0.85;
    this.camera.attachControl(canvas, true);
    this.goal = this.overviewShot();

    const markUser = () => (this.userUntil = this.time + 4);
    canvas.addEventListener('pointerdown', markUser);
    canvas.addEventListener('wheel', markUser, { passive: true });
  }

  /** Point the default view from behind a team's camp. */
  setHomeAngle(campCenter: Vector3) {
    // ArcRotate alpha is measured from +x towards +z; put the camera beyond the camp.
    this.homeAlpha = Math.atan2(campCenter.z, campCenter.x);
    this.camera.alpha = this.homeAlpha;
    this.goal = this.overviewShot();
    this.snap();
  }

  overviewShot(): Shot {
    return { target: Vector3.Zero(), radius: this.bounds * 1.75, beta: 0.82, alpha: this.homeAlpha };
  }

  overview() {
    this.follow = null;
    this.stiffness = 1.8;
    this.goal = this.overviewShot();
  }

  /** Keep a moving point in frame at a closer, more dramatic angle. */
  followTarget(get: () => Vector3, radius = 13, beta = 0.95) {
    this.follow = get;
    this.stiffness = 3.2;
    this.goal = { target: get().clone(), radius, beta };
  }

  /** A short cinematic shot: frame a point closely, then hold until the next instruction. */
  cinematic(shot: Shot, stiffness = 5) {
    this.follow = null;
    this.stiffness = stiffness;
    this.goal = shot;
    this.userUntil = 0;
  }

  addShake(amount: number) {
    this.shake = Math.max(this.shake, amount);
  }

  snap() {
    this.camera.target.copyFrom(this.goal.target);
    this.camera.radius = this.goal.radius;
    this.camera.beta = this.goal.beta;
    if (this.goal.alpha !== undefined) this.camera.alpha = this.goal.alpha;
  }

  update(dt: number) {
    this.time += dt;
    if (this.follow) this.goal.target = this.follow().clone();
    const userActive = this.time < this.userUntil;
    const k = 1 - Math.exp(-this.stiffness * dt);
    const cam = this.camera;
    // Target always eases (so the camera keeps up with the action); framing only when the player isn't steering.
    Vector3.LerpToRef(cam.target, this.goal.target.add(new Vector3(0, 0.8, 0)), userActive ? k * 0.4 : k, cam.target);
    if (!userActive) {
      cam.radius = lerp(cam.radius, this.goal.radius, k);
      cam.beta = lerp(cam.beta, this.goal.beta, k);
      if (this.goal.alpha !== undefined) {
        let d = this.goal.alpha - cam.alpha;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        cam.alpha += d * k * 0.6;
      }
    }
    if (this.shake > 0.001) {
      cam.target.addInPlace(new Vector3((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake));
      this.shake *= Math.pow(0.01, dt);
    }
  }
}
