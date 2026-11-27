import { Vector3 } from '@babylonjs/core';
import type { Color, EventsMessage, GameEvent, RoomView } from '../../core/protocol';
import type { CharacterActor } from '../actors/character';
import type { GameScene } from '../game-scene';

/** Sounds/HUD moments the Angular side reacts to. */
export type SceneCue =
  | 'dice'
  | 'step'
  | 'summon'
  | 'charge'
  | 'hit'
  | 'launch'
  | 'land'
  | 'cast'
  | 'zap'
  | 'slash'
  | 'blink'
  | 'blocked'
  | 'mana'
  | 'home'
  | 'finish'
  | 'gameOver';

const IMPACT_WORDS = ['BONK!', 'POW!', 'WHAM!', 'SMASH!', 'KO!', 'THWACK!'];

/**
 * Plays server events in order as choreographed beats (camera + characters +
 * VFX + cues). After each batch the scene snaps to the authoritative room
 * state, so a missed or skipped animation can never leave the board wrong.
 */
export class EventPlayer {
  room: RoomView | null = null;
  private queue: EventsMessage[] = [];
  private running = false;
  private disposed = false;

  constructor(private gs: GameScene) {}

  get busy() {
    return this.running;
  }

  enqueue(msg: EventsMessage) {
    this.queue.push(msg);
    if (!this.running) void this.drain();
  }

  /** A snapshot with no events (lobby change, presence, resync). */
  snapshot(room: RoomView) {
    if (this.running) {
      this.room = room;
      return;
    }
    this.reconcile(room, false);
  }

  private async drain() {
    this.running = true;
    this.gs.refreshHighlights();
    while (this.queue.length && !this.disposed) {
      // Far behind (e.g. tab was in the background): skip straight to the latest state.
      if (this.queue.length > 4) {
        const latest = this.queue[this.queue.length - 1];
        this.queue = [];
        this.reconcile(latest.room, true);
        continue;
      }
      this.gs.timeScale = this.queue.length > 1 ? 1.8 : 1;
      const msg = this.queue.shift()!;
      try {
        await this.play(msg.events);
      } catch (e) {
        console.error('event playback failed', e);
      }
      this.reconcile(msg.room, false);
    }
    this.gs.timeScale = 1;
    this.running = false;
    this.gs.refreshHighlights();
  }

  /** Put every piece where the server says it is. */
  reconcile(room: RoomView, instant: boolean) {
    this.room = room;
    const match = room.match;
    if (!match) return;
    this.gs.world.setTurnColor(match.phase === 'over' ? null : match.current);
    for (const [color, team] of Object.entries(match.teams) as [Color, (typeof match.teams)[string]][]) {
      team.pieces.forEach((progress, i) => {
        const actor = this.gs.actor(color, i);
        if (!actor) return;
        const at = this.spot(color, progress, i);
        if (instant || Vector3.DistanceSquared(actor.position, at) > 0.01) {
          if (!actor.busy) actor.place(at, this.gs.layout.forward(color, progress));
        }
        const statuses = team.statuses[i] ?? [];
        actor.setStatus('shield', statuses.includes('shield'));
        actor.setStatus('rooted', statuses.includes('rooted'));
      });
    }
  }

  /** Where a piece stands, spreading out pieces that share a tile. */
  private spot(color: Color, progress: number, piece: number): Vector3 {
    const base = this.gs.layout.position(color, progress, piece);
    const node = this.gs.layout.nodeAt(color, progress);
    if (!node || !this.room?.match) return base;
    const sharing: string[] = [];
    for (const [c, team] of Object.entries(this.room.match.teams) as [Color, { pieces: number[] }][]) {
      team.pieces.forEach((p, i) => {
        if (this.gs.layout.nodeAt(c, p)?.id === node.id) sharing.push(`${c}${i}`);
      });
    }
    if (sharing.length < 2) return base;
    const k = sharing.indexOf(`${color}${piece}`);
    const a = (k / sharing.length) * Math.PI * 2;
    return base.add(new Vector3(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32));
  }

  private focus(color: Color): Vector3 {
    // The most advanced piece on the board, or the camp.
    const team = this.room?.match?.teams[color];
    let best = -1;
    let at = Vector3.FromArray(this.gs.layout.data.camps[color].center);
    team?.pieces.forEach((p, i) => {
      if (p > best && p < this.gs.layout.finish(color)) {
        best = p;
        const a = this.gs.actor(color, i);
        if (a) at = a.position.clone();
      }
    });
    return at;
  }

  // ------------------------------------------------------------------ choreography
  private async play(events: GameEvent[]) {
    for (let i = 0; i < events.length; i++) {
      if (this.disposed) return;
      const e = events[i];
      const next = events[i + 1];
      switch (e.type) {
        case 'turnStarted': {
          const at = this.focus(e.color);
          this.gs.world.setTurnColor(e.color);
          this.gs.director.followTarget(() => at, 15, 0.9);
          break;
        }
        case 'rolled':
          await this.rolled(e.color, e.value);
          break;
        case 'turnPassed': {
          const at = this.focus(e.color);
          this.gs.fx.text(at, e.reason === 'threeSixes' ? 'THREE SIXES!' : 'NO MOVES', '#ffffff', 0.8);
          await this.gs.tween.wait(0.6);
          break;
        }
        case 'moved': {
          const attack = next?.type === 'captured' && next.byColor === e.color && next.byPiece === e.piece ? next : null;
          await this.moved(e.color, e.piece, e.from, e.to, e.path, attack);
          if (attack) i++; // the capture was played as part of the move
          break;
        }
        case 'captured':
          await this.captured(e.byColor, e.byPiece, e.color, e.piece);
          break;
        case 'abilityCast':
          await this.cast(e);
          break;
        case 'knockedBack':
          await this.knockedBack(e.color, e.piece, e.from, e.to, e.byColor);
          break;
        case 'teleported':
          await this.teleported(e.color, e.piece, e.from, e.to);
          break;
        case 'blocked': {
          const a = this.gs.actor(e.color, e.piece);
          if (a) {
            this.gs.onCue('blocked');
            void a.oneShot('block', 1.3);
            this.gs.fx.text(a.position, e.reason === 'shield' ? 'BLOCKED!' : 'SAFE!', '#9fe8ff', 0.8);
            this.gs.fx.blink(a.position, [0.6, 0.9, 1]);
          }
          await this.gs.tween.wait(0.35);
          break;
        }
        case 'statusChanged':
          this.gs.actor(e.color, e.piece)?.setStatus(e.status, e.active);
          break;
        case 'manaChanged':
          if (e.delta > 0 && (e.reason === 'shrine' || e.reason === 'passive')) {
            const at = this.focus(e.color);
            this.gs.fx.manaGain(at);
            this.gs.fx.text(at, `+${e.delta} MANA`, '#7fc8ff', 0.6);
            this.gs.onCue('mana');
          }
          break;
        case 'pieceFinished': {
          const a = this.gs.actor(e.color, e.piece);
          if (a) {
            this.gs.onCue('home');
            this.gs.fx.sparkle(a.position, [1, 0.85, 0.4], 80);
            this.gs.fx.text(a.position, 'HOME!', '#8dff9b');
            await a.oneShot('victory', 1.2);
          }
          break;
        }
        case 'playerFinished': {
          this.gs.onCue('finish');
          const camp = Vector3.FromArray(this.gs.layout.data.camps[e.color].center);
          this.gs.fx.sparkle(camp.add(new Vector3(0, 2, 0)), this.gs.teamRgb(e.color), 160);
          break;
        }
        case 'gameOver': {
          this.gs.onCue('gameOver');
          const winner = e.ranking[0];
          for (let p = 0; p < this.gs.layout.data.piecesPerTeam; p++) void this.gs.actor(winner, p)?.play('victory', { loop: true });
          this.gs.director.overview();
          break;
        }
      }
    }
  }

  private async rolled(color: Color, value: number) {
    const at = this.focus(color);
    const cam = this.gs.director.camera.position;
    const toCam = cam.subtract(at);
    toCam.y = 0;
    toCam.normalize();
    const side = new Vector3(-toCam.z, 0, toCam.x);
    const land = at.add(toCam.scale(1.6)).add(side.scale(1.1));
    land.y = this.gs.world.groundY(land.x, land.z) + 0.1;
    const from = land.add(new Vector3(0, 3.5, 0)).add(side.scale(-1.5));
    this.gs.director.followTarget(() => at, 11, 0.95);
    this.gs.onCue('dice');
    await this.gs.dice.throw(from, land, value, this.gs.teamRgb(color));
    this.gs.fx.text(land, `${value}`, '#ffffff', 0.9);
    this.gs.dice.hide(1.0);
    await this.gs.tween.wait(0.15);
  }

  private tilePositions(color: Color, piece: number, progresses: number[]): Vector3[] {
    return progresses.map((p) => this.gs.layout.position(color, p, piece));
  }

  private async moved(
    color: Color,
    piece: number,
    from: number,
    to: number,
    path: number[],
    attack: { color: Color; piece: number } | null,
  ) {
    const actor = this.gs.actor(color, piece);
    if (!actor) return;
    this.gs.director.followTarget(() => actor.position, 12, 0.92);
    if (from < 0) {
      this.gs.onCue('summon');
      const target = this.gs.layout.position(color, 0, piece);
      this.gs.fx.blink(actor.position, this.gs.skinFor(color).vfx);
      await actor.leap(target, 2.2, 0.7, true);
      this.gs.fx.dust(target, 16);
      if (attack) await this.captured(color, piece, attack.color, attack.piece, true);
      return;
    }
    const steps = this.tilePositions(color, piece, path);
    const run = attack ? steps.slice(0, -1) : steps;
    if (run.length) {
      const stepCue = setInterval(() => this.gs.onCue('step'), 280 / this.gs.timeScale);
      await actor.runAlong(run, 0.26);
      clearInterval(stepCue);
    }
    if (attack) await this.captured(color, piece, attack.color, attack.piece);
    void to;
  }

  /** The attacker leaps onto the victim's tile and sends it flying home. */
  private async captured(byColor: Color, byPiece: number, color: Color, piece: number, alreadyThere = false) {
    const attacker = this.gs.actor(byColor, byPiece);
    const victim = this.gs.actor(color, piece);
    if (!attacker || !victim) return;
    const target = victim.position.clone();
    victim.faceTo(attacker.position);
    attacker.faceTo(target);
    // Cinematic: low, close, slightly slowed.
    this.gs.director.cinematic({ target: target, radius: 7, beta: 1.1 }, 6);
    this.gs.focusDepth(target);
    this.gs.onCue('charge');
    void victim.oneShot('block', 1.2);
    if (!alreadyThere) {
      this.gs.timeScale = 0.75;
      void attacker.play('attack', { loop: false, speed: 1.2 });
      await attacker.leap(target, 1.4, 0.5);
    } else {
      await attacker.oneShot('attack', 1.3);
    }
    this.gs.timeScale = 1;
    this.gs.onCue('hit');
    const color3 = this.gs.skinFor(byColor).vfx;
    this.gs.fx.impact(target, color3, true);
    this.gs.fx.text(target, IMPACT_WORDS[Math.floor(Math.random() * IMPACT_WORDS.length)]);
    this.gs.director.addShake(0.5);
    // Hit-stop for weight.
    this.gs.timeScale = 0.15;
    await this.gs.tween.wait(0.025);
    this.gs.timeScale = 1;
    this.gs.onCue('launch');
    const home = this.gs.layout.position(color, -1, piece);
    void attacker.oneShot('victory', 1.4);
    await victim.launchedHome(home, this.gs.layout.forward(color, -1));
    this.gs.onCue('land');
    this.gs.fx.dust(home, 20);
  }

  private async cast(e: Extract<GameEvent, { type: 'abilityCast' }>) {
    const skin = this.gs.skinFor(e.color);
    const vfx = skin.vfx;
    // Caster: the named piece, or (for targeted spells) the closest piece to the target.
    let caster: CharacterActor | undefined = e.piece != null ? this.gs.actor(e.color, e.piece) : undefined;
    let targetActor: CharacterActor | undefined;
    if (e.targetColor && e.targetPiece != null) targetActor = this.gs.actor(e.targetColor, e.targetPiece);
    if (!caster) {
      const team = this.room?.match?.teams[e.color];
      let best = Infinity;
      team?.pieces.forEach((p, i) => {
        const a = this.gs.actor(e.color, i);
        if (!a || p < 0) return;
        const d = targetActor ? Vector3.Distance(a.position, targetActor.position) : 0;
        if (d < best) {
          best = d;
          caster = a;
        }
      });
    }
    const at = caster?.position.clone() ?? this.focus(e.color);
    this.gs.director.cinematic({ target: at, radius: 6.5, beta: 1.05 }, 5);
    this.gs.focusDepth(at);
    this.gs.onCue('cast');
    const tiles = e.tiles.map((id) => this.gs.layout.nodes.get(id)).filter(Boolean).map((n) => Vector3.FromArray(n!.pos));

    switch (e.ability) {
      case 'katana_slash':
      case 'fire_breath':
      case 'piercing_arrow': {
        if (caster && tiles.length) caster.faceTo(tiles[tiles.length - 1]);
        this.gs.fx.text(at, e.ability === 'katana_slash' ? 'KATANA SLASH' : e.ability.replace('_', ' ').toUpperCase(), '#ffe9a8', 0.7);
        if (caster) await caster.oneShot('cast', 1.25);
        this.gs.onCue('slash');
        const dir = tiles.length ? tiles[tiles.length - 1].subtract(at).normalize() : Vector3.Forward();
        this.gs.fx.slash(at, dir, vfx, Math.max(1.5, tiles.length));
        for (const t of tiles) this.gs.fx.impact(t, vfx, false);
        this.gs.director.addShake(0.25);
        await this.gs.tween.wait(0.2);
        break;
      }
      case 'zap':
      case 'entangling_roots': {
        const target = targetActor?.position ?? tiles[0] ?? at;
        caster?.faceTo(target);
        this.gs.fx.text(at, e.ability === 'zap' ? 'ZAP!' : 'ROOTS!', '#bfe6ff', 0.7);
        if (caster) void caster.play('cast', { loop: false, speed: 1.3 });
        await this.gs.tween.wait(0.45);
        this.gs.director.cinematic({ target, radius: 7.5, beta: 1.0 }, 6);
        this.gs.onCue('zap');
        if (e.ability === 'zap') this.gs.fx.lightning(target.add(new Vector3(0.5, 9, -0.3)), target.add(new Vector3(0, 0.6, 0)), vfx);
        this.gs.fx.impact(target, vfx, e.ability === 'zap');
        this.gs.director.addShake(0.3);
        await this.gs.tween.wait(0.25);
        caster?.play('idle');
        break;
      }
      case 'blink': {
        this.gs.fx.text(at, 'BLINK', '#d8b8ff', 0.7);
        if (caster) await caster.oneShot('cast', 1.5);
        break;
      }
      case 'shield_wall': {
        if (caster) await caster.oneShot('block', 1.2);
        this.gs.fx.blink(at, [1, 0.9, 0.5]);
        break;
      }
    }
  }

  private async knockedBack(color: Color, piece: number, from: number, to: number, byColor: Color) {
    const actor = this.gs.actor(color, piece);
    if (!actor) return;
    const progresses: number[] = [];
    for (let p = from - 1; p >= to; p--) progresses.push(p);
    const pts = this.tilePositions(color, piece, progresses.length ? progresses : [to]);
    this.gs.onCue('hit');
    this.gs.fx.impact(actor.position, this.gs.skinFor(byColor).vfx, false);
    this.gs.fx.text(actor.position, `-${from - to}`, '#ff8a8a', 0.8);
    this.gs.director.followTarget(() => actor.position, 10, 0.95);
    await actor.knockedBack(pts, 0.35 + pts.length * 0.08);
    this.gs.fx.dust(actor.position, 12);
  }

  private async teleported(color: Color, piece: number, from: number, to: number) {
    const actor = this.gs.actor(color, piece);
    if (!actor) return;
    const vfx = this.gs.skinFor(color).vfx;
    this.gs.onCue('blink');
    this.gs.fx.blink(actor.position, vfx);
    await this.gs.tween.tween(0.18, (t) => actor.body.scaling.setAll(1 - t));
    const dest = this.gs.layout.position(color, to, piece);
    actor.place(dest, this.gs.layout.forward(color, to));
    this.gs.director.followTarget(() => actor.position, 10, 0.95);
    this.gs.fx.blink(dest, vfx);
    await this.gs.tween.tween(0.22, (t) => actor.body.scaling.setAll(t));
    actor.body.scaling.setAll(1);
    void from;
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
  }
}
