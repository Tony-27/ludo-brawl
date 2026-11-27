import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Color, GameView, PlayerView } from '../../core/models';
import { FINISH, YARD, YARD_ORIGIN, piecePoint } from '../geometry';
import { Animator, ease, lerp } from './animator';
import { Fx } from './fx';
import { ALTAR_TOP, BoardMap, buildMap } from './map';
import { PAWN_SCALE, Pawn, TEAM_HEX } from './pawn';

export type SceneEvent = 'hop' | 'summon' | 'charge' | 'hit' | 'launch' | 'land' | 'victory' | 'home' | 'finish';

type Positions = Partial<Record<Color, number[]>>;

const HOP_TIME = 0.2;
const IMPACT_WORDS = ['BONK!', 'POW!', 'WHAM!', 'SMASH!', 'KO!', 'THWACK!'];

/**
 * The 3D tabletop. Receives game snapshots and turns the difference between
 * what is on screen and the new snapshot into hops, leaps and brawls.
 */
export class BoardScene {
  onPick: (piece: number) => void = () => {};
  onEvent: (e: SceneEvent) => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  private controls: OrbitControls;
  private map: BoardMap;
  private fx: Fx;
  private anim = new Animator();
  private clock = new THREE.Clock();
  private raf = 0;
  private resize: ResizeObserver;

  private pawns = new Map<string, Pawn>();
  private shown: Positions = {};
  private queue: GameView[] = [];
  private running = false;
  private latest: GameView | null = null;
  private myColor: Color | null = null;
  private viewColor: Color | null | undefined = undefined;
  private canMove = false;
  private hovered: Pawn | null = null;
  private ghost: THREE.Mesh;
  private ranking = 0;
  private pointerDown: { x: number; y: number } | null = null;
  private raycaster = new THREE.Raycaster();

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';

    this.scene.background = new THREE.Color(0x15122b);
    // Soft image-based lighting so metal and gloss read properly.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();
    this.scene.fog = new THREE.Fog(0x15122b, 30, 60);

    // Lighting: cool sky, warm sun, torches and the altar crystal live in the map.
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3a2a1a, 0.6));
    const sun = new THREE.DirectionalLight(0xffe2b8, 2.4);
    sun.position.set(9, 16, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -12;
    sc.right = sc.top = 12;
    sc.near = 1;
    sc.far = 40;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);

    this.map = buildMap();
    this.scene.add(this.map.group);
    this.fx = new Fx(this.scene);

    this.ghost = new THREE.Mesh(
      new THREE.TorusGeometry(0.32, 0.05, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    );
    this.ghost.rotation.x = -Math.PI / 2;
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 9;
    this.controls.maxDistance = 34;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = 1.2;
    this.controls.target.set(0, 0, 0);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerleave', this.onPointerLeave);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.loop();
  }

  // ---------------------------------------------------------------- input from Angular
  setState(game: GameView, players: PlayerView[], myColor: Color | null, canMove: boolean) {
    this.myColor = myColor;
    this.canMove = canMove;
    this.latest = game;

    const names: Partial<Record<Color, string>> = {};
    for (const p of players) if (game.turnOrder.includes(p.color)) names[p.color] = p.name;
    this.map.setNames(names);
    this.map.setTurn(game.phase === 'over' ? null : game.current);

    if (this.viewColor !== myColor) {
      this.viewColor = myColor;
      this.placeCamera(myColor ?? game.turnOrder[0]);
    }

    const colors = Object.keys(game.pieces).sort().join();
    const have = Object.keys(this.shown).sort().join();
    if (colors !== have) {
      this.rebuild(game);
      return;
    }

    const last = this.queue[this.queue.length - 1];
    if (!last || last !== game) this.queue.push(game);
    if (!this.running) void this.drain();
    else this.refreshHighlights();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    this.pawns.forEach((p) => p.dispose());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    el.remove();
  }

  // ---------------------------------------------------------------- setup
  private rebuild(game: GameView) {
    this.anim.flush();
    this.queue = [];
    for (const p of this.pawns.values()) {
      this.scene.remove(p.root);
      p.dispose();
    }
    this.pawns.clear();
    this.shown = clone(game.pieces);
    this.ranking = game.ranking.length;
    for (const [color, pieces] of Object.entries(game.pieces) as [Color, number[]][]) {
      pieces.forEach((_, i) => {
        const pawn = new Pawn(color, i);
        pawn.spin.rotation.order = 'YXZ';
        this.pawns.set(`${color}${i}`, pawn);
        this.scene.add(pawn.root);
      });
    }
    this.layout(0);
    this.refreshHighlights();
  }

  private placeCamera(color: Color) {
    const [ox, oy] = YARD_ORIGIN[color];
    const az = Math.atan2(ox + 3 - 7.5, oy + 3 - 7.5);
    const aspect = this.camera.aspect || 1;
    const dist = Math.min(32, 21 / Math.min(1, Math.pow(aspect, 0.85)));
    const polar = 0.92;
    this.camera.position.set(
      Math.sin(az) * Math.sin(polar) * dist,
      Math.cos(polar) * dist,
      Math.cos(az) * Math.sin(polar) * dist,
    );
    this.controls.update();
  }

  private fit() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    const speed = this.queue.length > 1 ? 2 : 1;
    this.anim.update(dt * speed);
    this.map.update(t);
    this.fx.update(dt);
    for (const p of this.pawns.values()) {
      if (!p.busy) p.lookAt(this.camera.position.x, this.camera.position.z);
      p.update(dt, t);
    }
    if (this.ghost.visible) this.ghost.rotation.z += dt * 2;
    this.controls.update();
    this.camera.position.add(this.fx.shakeOffset);
    this.renderer.render(this.scene, this.camera);
    this.camera.position.sub(this.fx.shakeOffset);
  };

  // ---------------------------------------------------------------- positions
  private spot(color: Color, progress: number, piece: number): THREE.Vector3 {
    const [gx, gy] = piecePoint(color, progress, piece);
    let y: number;
    if (progress === YARD) y = this.map.yardTop;
    else if (progress >= FINISH) y = ALTAR_TOP;
    else y = this.map.topAt(Math.floor(gx), Math.floor(gy));
    return new THREE.Vector3(gx - 7.5, y, gy - 7.5);
  }

  /** Final resting places, spreading out pawns that share a square. */
  private restingSpots(): Map<Pawn, { pos: THREE.Vector3; scale: number }> {
    const out = new Map<Pawn, { pos: THREE.Vector3; scale: number }>();
    const groups = new Map<string, Pawn[]>();
    for (const [color, pieces] of Object.entries(this.shown) as [Color, number[]][]) {
      pieces.forEach((progress, i) => {
        const pawn = this.pawns.get(`${color}${i}`)!;
        const pos = this.spot(color, progress, i);
        out.set(pawn, { pos, scale: PAWN_SCALE });
        const k = `${pos.x.toFixed(2)},${pos.z.toFixed(2)}`;
        groups.set(k, [...(groups.get(k) ?? []), pawn]);
      });
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.forEach((pawn, i) => {
        const a = (i / group.length) * Math.PI * 2 + Math.PI / 4;
        const e = out.get(pawn)!;
        e.pos.x += Math.cos(a) * 0.24;
        e.pos.z += Math.sin(a) * 0.24;
        e.scale = PAWN_SCALE * 0.72;
      });
    }
    return out;
  }

  private layout(duration: number): Promise<void> {
    const spots = this.restingSpots();
    const moves: Promise<void>[] = [];
    for (const [pawn, { pos, scale }] of spots) {
      const from = pawn.root.position.clone();
      const fromScale = pawn.root.scale.x;
      if (duration <= 0 || from.distanceTo(pos) < 1e-3) {
        pawn.root.position.copy(pos);
        pawn.root.scale.setScalar(scale);
        continue;
      }
      const far = from.distanceTo(pos) > 1.5;
      moves.push(
        this.anim.tween(
          far ? 0.5 : duration,
          (t) => {
            pawn.root.position.lerpVectors(from, pos, t);
            pawn.root.position.y += Math.sin(Math.PI * t) * (far ? 1.2 : 0.15);
            pawn.root.scale.setScalar(lerp(fromScale, scale, t));
          },
          ease.inOutQuad,
        ),
      );
    }
    return Promise.all(moves).then(() => {});
  }

  // ---------------------------------------------------------------- state machine
  private async drain() {
    this.running = true;
    this.refreshHighlights();
    while (this.queue.length) {
      if (this.queue.length > 3) {
        // Too far behind (e.g. fast bots): skip ahead to the newest state.
        const newest = this.queue[this.queue.length - 1];
        this.queue = [];
        this.shown = clone(newest.pieces);
        this.ranking = newest.ranking.length;
        await this.layout(0.3);
        continue;
      }
      const next = this.queue.shift()!;
      try {
        await this.animateTo(next);
      } catch (e) {
        console.error(e);
        this.shown = clone(next.pieces);
        await this.layout(0);
      }
    }
    this.running = false;
    this.refreshHighlights();
  }

  private async animateTo(game: GameView) {
    const target = clone(game.pieces);
    const mv = game.lastMove;
    const moverShown = mv ? this.shown[mv.color]?.[mv.piece] : undefined;

    if (mv && moverShown === mv.start && mv.end !== mv.start) {
      // Snap any unrelated differences first (e.g. a missed update).
      for (const color of Object.keys(target) as Color[]) {
        target[color]!.forEach((p, i) => {
          const isMover = color === mv.color && i === mv.piece;
          const isVictim = mv.captures.some((c) => c.color === color && c.piece === i);
          if (!isMover && !isVictim) this.shown[color]![i] = p;
        });
      }
      await this.layout(0.25);
      await this.playMove(game);
    }

    this.shown = target;
    await this.layout(0.3);

    if (game.ranking.length > this.ranking) {
      const winner = game.ranking[game.ranking.length - 1];
      this.celebrate(winner);
    }
    this.ranking = game.ranking.length;
  }

  private async playMove(game: GameView) {
    const mv = game.lastMove!;
    const pawn = this.pawns.get(`${mv.color}${mv.piece}`)!;
    pawn.busy = true;
    pawn.root.scale.setScalar(PAWN_SCALE);

    const victims = mv.captures.map((c) => this.pawns.get(`${c.color}${c.piece}`)!).filter(Boolean);

    if (mv.start === YARD) {
      // Leap out of the castle onto the start square.
      const to = this.spot(mv.color, 0, mv.piece);
      this.onEvent('summon');
      pawn.setExpression('happy');
      await this.arc(pawn, to, 1.3, 0.55, true);
      this.fx.burst(to, { color: 0xd8cfbd, kind: 'puff', count: 10, speed: 1.2, up: 0.6, gravity: 1, life: 0.6 });
      if (victims.length) await this.brawl(pawn, to, victims, true);
    } else {
      const steps: number[] = [];
      for (let p = mv.start + 1; p <= mv.end; p++) steps.push(p);
      for (let i = 0; i < steps.length; i++) {
        const to = this.spot(mv.color, steps[i], mv.piece);
        const last = i === steps.length - 1;
        if (last && victims.length) {
          await this.brawl(pawn, to, victims, false);
        } else {
          this.onEvent('hop');
          await this.arc(pawn, to, 0.42, HOP_TIME, false);
        }
      }
    }

    this.shown[mv.color]![mv.piece] = mv.end;
    for (const c of mv.captures) this.shown[c.color]![c.piece] = YARD;

    if (mv.end >= FINISH) {
      const at = pawn.root.position.clone();
      this.onEvent('home');
      pawn.setExpression('happy');
      this.fx.burst(at, { color: 0xffd76a, count: 40, speed: 1.4, up: 5, gravity: 5, life: 1.3 });
      this.fx.text(at.clone().add(new THREE.Vector3(0, 1.3, 0)), 'HOME!', '#8dff9b');
      await this.anim.tween(0.4, (t) => (pawn.lift.position.y = Math.sin(Math.PI * t) * 0.6), ease.outQuad);
    }

    pawn.busy = false;
    void this.anim.wait(1.4).then(() => {
      if (!pawn.busy) pawn.setExpression('normal');
    });
  }

  /** Jump along an arc to a point, landing with a squash. */
  private async arc(pawn: Pawn, to: THREE.Vector3, height: number, time: number, flip: boolean) {
    const from = pawn.root.position.clone();
    pawn.lookAt(to.x, to.z, true);
    const startX = pawn.spin.rotation.x;
    await this.anim.tween(time, (t) => {
      pawn.root.position.lerpVectors(from, to, t);
      pawn.root.position.y = lerp(from.y, to.y, t) + Math.sin(Math.PI * t) * height;
      pawn.lift.position.y = 0;
      pawn.lift.scale.set(1 - Math.sin(Math.PI * t) * 0.08, 1 + Math.sin(Math.PI * t) * 0.15, 1 - Math.sin(Math.PI * t) * 0.08);
      if (flip) pawn.spin.rotation.x = startX + t * Math.PI * 2;
    });
    pawn.spin.rotation.x = 0;
    await this.anim.tween(
      0.09,
      (t) => {
        const s = Math.sin(Math.PI * t) * 0.25;
        pawn.lift.scale.set(1 + s * 0.5, 1 - s, 1 + s * 0.5);
      },
      ease.outQuad,
    );
    pawn.lift.scale.set(1, 1, 1);
  }

  /** The attacker leaps onto the target square and knocks every victim back to base. */
  private async brawl(attacker: Pawn, at: THREE.Vector3, victims: Pawn[], alreadyThere: boolean) {
    for (const v of victims) {
      v.busy = true;
      v.lookAt(attacker.root.position.x, attacker.root.position.z, true);
      v.setExpression('scared');
    }
    attacker.setExpression('angry');
    this.onEvent('charge');

    // Wind-up: crouch and raise the weapon.
    await this.anim.tween(
      0.28,
      (t) => {
        attacker.lift.scale.set(1 + t * 0.12, 1 - t * 0.25, 1 + t * 0.12);
        attacker.weapon.rotation.x = -t * 1.8;
        for (const v of victims) v.lift.position.y = Math.abs(Math.sin(t * Math.PI * 6)) * 0.05; // trembling
      },
      ease.outQuad,
    );

    // Leap and slam.
    const from = attacker.root.position.clone();
    const landing = alreadyThere ? at.clone() : at;
    attacker.lookAt(landing.x, landing.z, true);
    if (alreadyThere) attacker.lookAt(victims[0].root.position.x, victims[0].root.position.z, true);
    await this.anim.tween(alreadyThere ? 0.35 : 0.45, (t) => {
      attacker.root.position.lerpVectors(from, landing, t);
      attacker.root.position.y = lerp(from.y, landing.y, t) + Math.sin(Math.PI * t) * (alreadyThere ? 0.9 : 1.5);
      attacker.lift.scale.set(1, 1, 1);
      attacker.spin.rotation.x = -Math.sin(Math.PI * t) * 0.5;
      attacker.weapon.rotation.x = -1.8 + t * 3.2;
    });
    attacker.spin.rotation.x = 0;

    // IMPACT
    const color = TEAM_HEX[attacker.color];
    const hitAt = at.clone().add(new THREE.Vector3(0, 0.45, 0));
    this.onEvent('hit');
    this.fx.impact(hitAt, color, 0.45);
    this.fx.burst(hitAt, { color, count: 26, speed: 4.5, up: 3, life: 0.7 });
    this.fx.burst(hitAt, { color: 0xffffff, count: 14, speed: 5.5, up: 2, life: 0.45 });
    this.fx.burst(at, { color: 0xbfb6a3, kind: 'puff', count: 12, speed: 2, up: 0.8, gravity: 1, life: 0.7 });
    this.fx.text(hitAt.clone().add(new THREE.Vector3(0, 1.1, 0)), IMPACT_WORDS[Math.floor(Math.random() * IMPACT_WORDS.length)]);

    // Victims go flying home, spinning and dizzy.
    this.onEvent('launch');
    const flights = victims.map((v, i) => {
      v.setExpression('dizzy');
      const vFrom = v.root.position.clone();
      const home = this.spot(v.color, YARD, v.index);
      const spinDir = Math.random() < 0.5 ? -1 : 1;
      return this.anim
        .wait(i * 0.06)
        .then(() =>
          this.anim.tween(1.15, (t) => {
            v.root.position.lerpVectors(vFrom, home, t);
            v.root.position.y = lerp(vFrom.y, home.y, t) + Math.sin(Math.PI * t) * 3.6;
            v.root.scale.setScalar(PAWN_SCALE);
            v.lift.position.y = 0;
            v.spin.rotation.x = t * Math.PI * 4;
            v.spin.rotation.z = spinDir * t * Math.PI * 2;
          }),
        )
        .then(() => {
          v.spin.rotation.x = 0;
          v.spin.rotation.z = 0;
          this.onEvent('land');
          this.fx.burst(home, { color: TEAM_HEX[v.color], kind: 'puff', count: 10, speed: 1.5, up: 1, gravity: 2, life: 0.6 });
          return this.anim.tween(0.25, (t) => {
            const s = Math.sin(Math.PI * t) * 0.35;
            v.lift.scale.set(1 + s * 0.4, 1 - s, 1 + s * 0.4);
          });
        })
        .then(() => {
          v.lift.scale.set(1, 1, 1);
          v.busy = false;
          void this.anim.wait(2.2).then(() => v.setExpression('normal'));
        });
    });

    // Attacker: follow-through, then a little victory hop.
    const victory = this.anim
      .tween(0.15, (t) => {
        attacker.weapon.rotation.x = 1.4 - t * 1.4;
        const s = Math.sin(Math.PI * t) * 0.3;
        attacker.lift.scale.set(1 + s * 0.4, 1 - s, 1 + s * 0.4);
      })
      .then(() => {
        attacker.setExpression('happy');
        this.onEvent('victory');
        return this.anim.tween(0.45, (t) => {
          attacker.lift.position.y = Math.sin(Math.PI * t) * 0.55;
          attacker.spin.rotation.y += 0.25;
          attacker.weapon.rotation.x = -Math.sin(Math.PI * t) * 2.2;
        });
      })
      .then(() => {
        attacker.lift.position.y = 0;
        attacker.weapon.rotation.x = 0;
      });

    await Promise.all([...flights, victory]);
  }

  private celebrate(color: Color) {
    this.onEvent('finish');
    const [ox, oy] = YARD_ORIGIN[color];
    const over = new THREE.Vector3(ox + 3 - 7.5, 2.5, oy + 3 - 7.5);
    this.fx.burst(over, { color: 0xffffff, kind: 'confetti', count: 90, speed: 3.5, up: 6, gravity: 4, life: 2.5 });
    this.fx.burst(new THREE.Vector3(0, 1.8, 0), { color: TEAM_HEX[color], count: 50, speed: 3, up: 5, gravity: 5, life: 1.5 });
  }

  // ---------------------------------------------------------------- picking
  private movablePawns(): Pawn[] {
    const g = this.latest;
    if (!g || this.running || !this.canMove || !this.myColor || g.phase !== 'move' || g.current !== this.myColor) return [];
    return g.legalPieces.map((i) => this.pawns.get(`${this.myColor}${i}`)!).filter(Boolean);
  }

  private refreshHighlights() {
    const movable = new Set(this.movablePawns());
    for (const p of this.pawns.values()) p.setHighlight(movable.has(p));
    if (this.hovered && !movable.has(this.hovered)) this.setHover(null);
  }

  private pick(ev: PointerEvent): Pawn | null {
    const candidates = this.movablePawns();
    if (!candidates.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(candidates.map((p) => p.hit), false);
    return hits.length ? (hits[0].object.userData['pawn'] as Pawn) : null;
  }

  private setHover(p: Pawn | null) {
    this.hovered = p;
    this.renderer.domElement.style.cursor = p ? 'pointer' : 'grab';
    const g = this.latest;
    if (!p || !g || g.lastRoll === null) {
      this.ghost.visible = false;
      return;
    }
    const from = this.shown[p.color]?.[p.index] ?? YARD;
    const to = from === YARD ? 0 : Math.min(FINISH, from + g.lastRoll);
    const pos = this.spot(p.color, to, p.index);
    this.ghost.position.set(pos.x, pos.y + 0.04, pos.z);
    (this.ghost.material as THREE.MeshBasicMaterial).color.set(TEAM_HEX[p.color]);
    this.ghost.visible = true;
  }

  private onPointerDown = (ev: PointerEvent) => {
    this.pointerDown = { x: ev.clientX, y: ev.clientY };
  };

  private onPointerUp = (ev: PointerEvent) => {
    const d = this.pointerDown;
    this.pointerDown = null;
    if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6) return;
    const p = this.pick(ev);
    if (p) {
      this.setHover(null);
      this.onPick(p.index);
    }
  };

  private onPointerMove = (ev: PointerEvent) => {
    if (this.pointerDown) return;
    const p = this.pick(ev);
    if (p !== this.hovered) this.setHover(p);
  };

  private onPointerLeave = () => this.setHover(null);
}

function clone(p: Positions): Positions {
  const out: Positions = {};
  for (const [k, v] of Object.entries(p)) out[k as Color] = [...(v ?? [])];
  return out;
}
