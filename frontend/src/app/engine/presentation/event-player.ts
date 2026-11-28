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
  | 'gameOver'
  | 'fall'
  | 'slide'
  | 'portal'
  | 'crumble'
  | 'fire'
  | 'meteor'
  | 'trap'
  | 'roots';

type Ev<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;

const IMPACT_WORDS = ['BONK!', 'POW!', 'WHAM!', 'SMASH!', 'KO!', 'THWACK!'];
const ABILITY_TITLES: Record<string, string> = {
  quick_draw: 'QUICK DRAW',
  charge: 'CHARGE!',
  cleave: 'CLEAVE',
  berserker_rage: 'BERSERKER RAGE',
  katana_slash: 'KATANA SLASH',
  thousand_cuts: 'THOUSAND CUTS',
  zap: 'ZAP!',
  blink: 'BLINK',
  meteor: 'METEOR',
  shield_wall: 'SHIELD WALL',
  shield_bash: 'SHIELD BASH',
  rally: 'RALLY!',
  piercing_arrow: 'PIERCING ARROW',
  snare_trap: 'SNARE TRAP',
  rain_of_arrows: 'RAIN OF ARROWS',
  entangling_roots: 'ROOTS!',
  wild_growth: 'WILD GROWTH',
  overgrowth: 'OVERGROWTH',
  dive: 'DIVE!',
  fire_breath: 'FIRE BREATH',
  inferno: 'INFERNO',
};
const ULTIMATES = new Set(['berserker_rage', 'thousand_cuts', 'meteor', 'rally', 'rain_of_arrows', 'overgrowth', 'inferno']);

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
  /** Positions this player believes in while animating (progress, lane). */
  private lanes = new Map<string, number>();

  constructor(private gs: GameScene) {}

  get busy() {
    return this.running;
  }

  enqueue(msg: EventsMessage) {
    this.queue.push(msg);
    if (!this.running) void this.drain();
  }

  /** A snapshot with no events (lobby change, presence, practice, resync). */
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
      // Watchdog: animations must never be able to stall the game.
      const budget = 5000 + msg.events.length * 2500;
      let timedOut = false;
      try {
        await Promise.race([
          this.play(msg.events),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              timedOut = true;
              resolve();
            }, budget),
          ),
        ]);
      } catch (e) {
        console.error('event playback failed', e);
      }
      if (timedOut) console.warn('event playback took too long; snapping to the latest state');
      this.reconcile(msg.room, timedOut);
    }
    this.gs.timeScale = 1;
    this.running = false;
    this.gs.refreshHighlights();
    this.gs.frameInteraction();
  }

  /** Put every piece and tile effect where the server says it is. */
  reconcile(room: RoomView, instant: boolean) {
    this.room = room;
    const match = room.match;
    if (!match) return;
    if (instant) this.gs.dice.root.setEnabled(false);
    this.gs.world.setTurnColor(match.phase === 'over' ? null : match.current);
    for (const [color, team] of Object.entries(match.teams) as [Color, (typeof match.teams)[string]][]) {
      team.pieces.forEach((progress, i) => {
        const actor = this.gs.actor(color, i);
        if (!actor) return;
        const lane = team.lanes[i] ?? 0;
        this.lanes.set(`${color}${i}`, lane);
        const at = this.spot(color, progress, i, lane);
        if ((instant || Vector3.DistanceSquared(actor.position, at) > 0.01) && !actor.busy) {
          actor.place(at, this.gs.layout.forward(color, progress, lane));
          actor.body.scaling.setAll(1);
        }
        const statuses = team.statuses[i] ?? [];
        actor.setStatus('shield', statuses.includes('shield'));
        actor.setStatus('rooted', statuses.includes('rooted'));
      });
    }
    // Tile effects: clear everything, then apply the current set.
    const current = new Set(Object.keys(match.tiles));
    for (const id of this.shownTiles) if (!current.has(id)) this.gs.world.setTileEffect(id, 'none');
    for (const [id, fx] of Object.entries(match.tiles)) {
      this.gs.world.setTileEffect(id, fx.effect, fx.effect !== 'trap' || fx.owner === this.gs.myColor);
    }
    this.shownTiles = current;
  }

  private shownTiles = new Set<string>();

  /** Where a piece stands, spreading out pieces that share a tile. */
  private spot(color: Color, progress: number, piece: number, lane: number): Vector3 {
    const base = this.gs.layout.position(color, progress, piece, lane);
    const node = this.gs.layout.nodeAt(color, progress, lane);
    if (!node || !this.room?.match) return base;
    const sharing: string[] = [];
    for (const [c, team] of Object.entries(this.room.match.teams) as [Color, { pieces: number[]; lanes: number[] }][]) {
      team.pieces.forEach((p, i) => {
        if (this.gs.layout.nodeAt(c, p, team.lanes[i] ?? 0)?.id === node.id) sharing.push(`${c}${i}`);
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

  private positions(color: Color, piece: number, path: number[], end: number, lane: number): Vector3[] {
    return path.map((p) => this.gs.layout.position(color, p, piece, this.gs.layout.laneAlong(color, path[0], end, lane, p)));
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
          this.gs.fx.text(this.focus(e.color), e.reason === 'threeSixes' ? 'THREE SIXES!' : 'NO MOVES', '#ffffff', 0.8);
          await this.gs.tween.wait(0.6);
          break;
        }
        case 'moved': {
          const attack = next?.type === 'captured' && next.byColor === e.color && next.byPiece === e.piece ? next : null;
          await this.moved(e, attack);
          if (attack) i++;
          break;
        }
        case 'captured':
          await this.captured(e.byColor, e.byPiece, e.color, e.piece);
          break;
        case 'abilityCast':
          await this.cast(e);
          break;
        case 'knockedBack':
          await this.knockedBack(e);
          break;
        case 'teleported':
          await this.teleported(e.color, e.piece, e.to, e.lane, 'blink');
          break;
        case 'portaled':
          this.gs.onCue('portal');
          await this.teleported(e.color, e.piece, e.to, e.lane, 'portal');
          break;
        case 'slid':
        case 'drifted':
          await this.slid(e);
          break;
        case 'swapped':
          await this.swapped(e);
          break;
        case 'fell':
          await this.fell(e);
          break;
        case 'tileChanged': {
          const n = this.gs.layout.nodes.get(e.tile);
          const visible = e.effect !== 'trap' || e.owner === this.gs.myColor;
          this.gs.world.setTileEffect(e.tile, e.effect, visible);
          if (e.effect === 'none') this.shownTiles.delete(e.tile);
          else this.shownTiles.add(e.tile);
          if (n && e.effect === 'broken') {
            this.gs.onCue('crumble');
            this.gs.fx.dust(Vector3.FromArray(n.pos), 30);
            this.gs.fx.text(Vector3.FromArray(n.pos), 'CRUMBLE!', '#ffb37a', 0.7);
            this.gs.director.addShake(0.25);
            await this.gs.tween.wait(0.3);
          }
          break;
        }
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
        case 'statusChanged': {
          const a = this.gs.actor(e.color, e.piece);
          a?.setStatus(e.status, e.active);
          if (a && e.active && e.status === 'rooted') this.gs.onCue('roots');
          break;
        }
        case 'manaChanged':
          if (e.delta > 0 && (e.reason === 'shrine' || e.reason === 'passive')) {
            const at = this.focus(e.color);
            this.gs.fx.manaGain(at);
            this.gs.fx.text(at, `+${e.delta} MANA`, '#7fc8ff', 0.6);
            this.gs.onCue('mana');
          } else if (e.reason === 'burned') {
            const at = this.focus(e.color);
            this.gs.onCue('fire');
            this.gs.fx.text(at, 'BURNED -1', '#ff9a5a', 0.6);
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

  private async moved(e: Ev<'moved'>, attack: { color: Color; piece: number } | null) {
    const actor = this.gs.actor(e.color, e.piece);
    if (!actor) return;
    this.gs.director.followTarget(() => actor.position, 12, 0.92);
    const vfx = this.gs.skinFor(e.color).vfx;
    if (e.from < 0) {
      this.gs.onCue('summon');
      const target = this.gs.layout.position(e.color, 0, e.piece, e.lane);
      this.gs.fx.blink(actor.position, vfx);
      await actor.leap(target, 2.2, 0.7, true);
      this.gs.fx.dust(target, 16);
      if (attack) await this.captured(e.color, e.piece, attack.color, attack.piece, true);
      return;
    }
    const steps = this.positions(e.color, e.piece, e.path, e.to, e.lane);
    const run = attack ? steps.slice(0, -1) : steps;
    const speed = e.via === 'dash' ? 0.12 : e.via === 'rally' ? 0.2 : 0.26;
    if (e.via === 'dash') this.gs.fx.blink(actor.position, vfx);
    if (run.length) {
      const stepCue = setInterval(() => this.gs.onCue('step'), (speed * 1000) / this.gs.timeScale);
      await actor.runAlong(run, speed);
      clearInterval(stepCue);
    }
    if (attack) await this.captured(e.color, e.piece, attack.color, attack.piece);
  }

  /** The attacker leaps onto the victim's tile and sends it flying home. */
  private async captured(byColor: Color, byPiece: number, color: Color, piece: number, alreadyThere = false) {
    const attacker = this.gs.actor(byColor, byPiece);
    const victim = this.gs.actor(color, piece);
    if (!attacker || !victim) return;
    const target = victim.position.clone();
    victim.faceTo(attacker.position);
    attacker.faceTo(target);
    this.gs.director.cinematic({ target, radius: 7, beta: 1.1 }, 6);
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
    this.gs.fx.impact(target, this.gs.skinFor(byColor).vfx, true);
    this.gs.fx.text(target, IMPACT_WORDS[Math.floor(Math.random() * IMPACT_WORDS.length)]);
    this.gs.director.addShake(0.5);
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

  private casterFor(e: Ev<'abilityCast'>): CharacterActor | undefined {
    if (e.piece != null) return this.gs.actor(e.color, e.piece);
    const target = e.targetColor && e.targetPiece != null ? this.gs.actor(e.targetColor, e.targetPiece) : undefined;
    const tile = e.tiles[0] ? this.gs.layout.nodes.get(e.tiles[0]) : undefined;
    const goal = target?.position ?? (tile ? Vector3.FromArray(tile.pos) : null);
    const team = this.room?.match?.teams[e.color];
    let best: CharacterActor | undefined;
    let bestD = Infinity;
    team?.pieces.forEach((p, i) => {
      const a = this.gs.actor(e.color, i);
      if (!a || p < 0 || p >= team.finish) return;
      const d = goal ? Vector3.Distance(a.position, goal) : -p;
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    });
    return best;
  }

  private async cast(e: Ev<'abilityCast'>) {
    const vfx = this.gs.skinFor(e.color).vfx;
    const caster = this.casterFor(e);
    const targetActor = e.targetColor && e.targetPiece != null ? this.gs.actor(e.targetColor, e.targetPiece) : undefined;
    const at = caster?.position.clone() ?? this.focus(e.color);
    const tiles = e.tiles.map((id) => this.gs.layout.nodes.get(id)).filter(Boolean).map((n) => Vector3.FromArray(n!.pos));
    const ult = ULTIMATES.has(e.ability);
    const title = ABILITY_TITLES[e.ability] ?? e.ability.toUpperCase();

    this.gs.director.cinematic({ target: at, radius: ult ? 9 : 6.5, beta: ult ? 0.95 : 1.05 }, 5);
    this.gs.focusDepth(at);
    this.gs.onCue('cast');
    this.gs.fx.text(at, title, ult ? '#ffd76a' : '#ffe9a8', ult ? 1.1 : 0.7);
    if (ult) {
      this.gs.fx.shockwave(at, vfx);
      this.gs.timeScale = 0.6;
    }

    switch (e.ability) {
      case 'quick_draw':
      case 'charge':
      case 'dive':
        if (caster) await caster.oneShot('cast', 1.6);
        break;
      case 'katana_slash':
      case 'cleave':
      case 'fire_breath':
      case 'piercing_arrow': {
        if (caster && tiles.length) caster.faceTo(tiles[tiles.length - 1]);
        if (caster) await caster.oneShot('cast', 1.25);
        this.gs.onCue(e.ability === 'fire_breath' ? 'fire' : 'slash');
        const dir = tiles.length ? tiles[tiles.length - 1].subtract(at).normalize() : Vector3.Forward();
        if (e.ability === 'fire_breath') for (const t of tiles) this.gs.fx.sparkle(t, [1, 0.45, 0.1], 40);
        else this.gs.fx.slash(at, dir, vfx, Math.max(1.5, Math.min(tiles.length, 3)));
        for (const t of tiles) this.gs.fx.impact(t, vfx, false);
        this.gs.director.addShake(0.25);
        await this.gs.tween.wait(0.2);
        break;
      }
      case 'zap':
      case 'entangling_roots':
      case 'shield_bash':
      case 'wild_growth': {
        const target = targetActor?.position ?? tiles[0] ?? at;
        caster?.faceTo(target);
        if (caster) void caster.play(e.ability === 'shield_bash' ? 'attack' : 'cast', { loop: false, speed: 1.3 });
        await this.gs.tween.wait(0.4);
        this.gs.director.cinematic({ target, radius: 7.5, beta: 1.0 }, 6);
        if (e.ability === 'zap') {
          this.gs.onCue('zap');
          this.gs.fx.lightning(target.add(new Vector3(0.5, 9, -0.3)), target.add(new Vector3(0, 0.6, 0)), vfx);
        } else if (e.ability === 'shield_bash') {
          this.gs.onCue('hit');
        } else {
          this.gs.onCue('roots');
          this.gs.fx.sparkle(target, [0.4, 0.9, 0.35], 60);
        }
        this.gs.fx.impact(target, vfx, e.ability !== 'wild_growth');
        this.gs.director.addShake(0.3);
        await this.gs.tween.wait(0.25);
        caster?.play('idle');
        break;
      }
      case 'meteor': {
        const target = tiles[0] ?? at;
        caster?.faceTo(target);
        if (caster) void caster.play('cast', { loop: false, speed: 1.1 });
        this.gs.director.cinematic({ target, radius: 10, beta: 0.9 }, 4);
        await this.gs.tween.wait(0.5);
        this.gs.onCue('meteor');
        this.gs.fx.lightning(target.add(new Vector3(6, 18, -4)), target, [1, 0.45, 0.1]);
        this.gs.fx.impact(target, [1, 0.45, 0.1], true);
        for (const t of tiles.slice(1)) this.gs.fx.impact(t, [1, 0.5, 0.15], false);
        this.gs.director.addShake(0.9);
        await this.gs.tween.wait(0.3);
        break;
      }
      case 'snare_trap': {
        if (caster) await caster.oneShot('cast', 1.4);
        this.gs.onCue('trap');
        break;
      }
      case 'blink':
        if (caster) await caster.oneShot('cast', 1.5);
        break;
      case 'shield_wall':
        if (caster) await caster.oneShot('block', 1.2);
        this.gs.fx.blink(at, [1, 0.9, 0.5]);
        break;
      case 'rally': {
        const team = this.room?.match?.teams[e.color];
        team?.pieces.forEach((p, i) => {
          const a = this.gs.actor(e.color, i);
          if (a && p >= 0 && p < team.finish) {
            void a.oneShot('victory', 1.5);
            this.gs.fx.sparkle(a.position, [1, 0.9, 0.5], 50);
          }
        });
        await this.gs.tween.wait(0.6);
        break;
      }
      case 'thousand_cuts':
      case 'berserker_rage':
      case 'rain_of_arrows':
      case 'inferno':
      case 'overgrowth': {
        if (caster) void caster.play('cast', { loop: false, speed: 1.2 });
        await this.gs.tween.wait(0.35);
        const color: [number, number, number] =
          e.ability === 'inferno' ? [1, 0.45, 0.1] : e.ability === 'overgrowth' ? [0.4, 0.95, 0.35] : vfx;
        this.gs.onCue(e.ability === 'inferno' ? 'fire' : e.ability === 'overgrowth' ? 'roots' : 'slash');
        for (const t of tiles) {
          if (e.ability === 'rain_of_arrows') this.gs.fx.lightning(t.add(new Vector3(1, 7, 0)), t.add(new Vector3(0, 0.4, 0)), [1, 0.9, 0.6]);
          else if (e.ability === 'thousand_cuts' || e.ability === 'berserker_rage') this.gs.fx.slash(t, Vector3.Right(), color, 1.2);
          this.gs.fx.impact(t, color, false);
        }
        this.gs.director.addShake(0.6);
        await this.gs.tween.wait(0.35);
        break;
      }
    }
    this.gs.timeScale = 1;
  }

  private async knockedBack(e: Ev<'knockedBack'>) {
    const actor = this.gs.actor(e.color, e.piece);
    if (!actor) return;
    const progresses: number[] = [];
    for (let p = e.from - 1; p >= e.to; p--) progresses.push(p);
    const pts = progresses.length
      ? progresses.map((p) => this.gs.layout.position(e.color, p, e.piece, this.gs.layout.laneAlong(e.color, e.from, e.to, e.lane, p)))
      : [this.gs.layout.position(e.color, e.to, e.piece, e.lane)];
    this.gs.onCue('hit');
    this.gs.fx.impact(actor.position, this.gs.skinFor(e.byColor).vfx, false);
    this.gs.fx.text(actor.position, `-${e.from - e.to}`, '#ff8a8a', 0.8);
    this.gs.director.followTarget(() => actor.position, 10, 0.95);
    await actor.knockedBack(pts, 0.35 + pts.length * 0.08);
    this.gs.fx.dust(actor.position, 12);
  }

  private async teleported(color: Color, piece: number, to: number, lane: number, kind: 'blink' | 'portal') {
    const actor = this.gs.actor(color, piece);
    if (!actor) return;
    const vfx: [number, number, number] = kind === 'portal' ? [0.7, 0.35, 1] : this.gs.skinFor(color).vfx;
    if (kind === 'blink') this.gs.onCue('blink');
    this.gs.fx.blink(actor.position, vfx);
    await this.gs.tween.tween(0.18, (t) => actor.body.scaling.setAll(1 - t));
    const dest = this.gs.layout.position(color, to, piece, lane);
    actor.place(dest, this.gs.layout.forward(color, to, lane));
    this.gs.director.followTarget(() => actor.position, 10, 0.95);
    this.gs.fx.blink(dest, vfx);
    await this.gs.tween.tween(0.22, (t) => actor.body.scaling.setAll(t));
    actor.body.scaling.setAll(1);
  }

  private async slid(e: Ev<'slid'> | Ev<'drifted'>) {
    const actor = this.gs.actor(e.color, e.piece);
    if (!actor) return;
    this.gs.onCue('slide');
    const dir = e.to >= e.from ? 1 : -1;
    const path: number[] = [];
    for (let p = e.from + dir; dir > 0 ? p <= e.to : p >= e.to; p += dir) path.push(p);
    const pts = this.positions(e.color, e.piece, path.length ? path : [e.to], e.to, e.lane);
    this.gs.director.followTarget(() => actor.position, 10, 0.95);
    void actor.play('dodge', { loop: false, speed: 0.8 });
    actor.busy = true;
    for (const to of pts) {
      const from = actor.position.clone();
      await this.gs.tween.tween(0.11, (t) => Vector3.LerpToRef(from, to, t, actor.root.position));
      this.gs.fx.dust(to, 4);
    }
    actor.busy = false;
    actor.play('idle');
    this.gs.fx.text(actor.position, dir > 0 ? `+${e.to - e.from}` : `${e.to - e.from}`, dir > 0 ? '#7dffb0' : '#ff8a8a', 0.6);
  }

  private async swapped(e: Ev<'swapped'>) {
    const a = this.gs.actor(e.color, e.piece);
    const b = this.gs.actor(e.otherColor, e.otherPiece);
    if (!a || !b) return;
    this.gs.onCue('blink');
    const green: [number, number, number] = [0.4, 0.95, 0.35];
    this.gs.fx.blink(a.position, green);
    this.gs.fx.blink(b.position, green);
    await this.gs.tween.tween(0.2, (t) => {
      a.body.scaling.setAll(1 - t);
      b.body.scaling.setAll(1 - t);
    });
    a.place(this.gs.layout.position(e.color, e.to, e.piece, e.lane), this.gs.layout.forward(e.color, e.to, e.lane));
    b.place(this.gs.layout.position(e.otherColor, e.otherTo, e.otherPiece, e.otherLane), this.gs.layout.forward(e.otherColor, e.otherTo, e.otherLane));
    await this.gs.tween.tween(0.25, (t) => {
      a.body.scaling.setAll(t);
      b.body.scaling.setAll(t);
    });
  }

  private async fell(e: Ev<'fell'>) {
    const actor = this.gs.actor(e.color, e.piece);
    if (!actor) return;
    const n = this.gs.layout.nodes.get(e.tile);
    const hole = n ? Vector3.FromArray(n.pos) : actor.position.clone();
    this.gs.director.cinematic({ target: hole, radius: 7, beta: 0.95 }, 6);
    this.gs.onCue('fall');
    this.gs.fx.text(hole, 'AAAH!', '#ff9a5a', 0.8);
    actor.busy = true;
    void actor.play('knockdown', { loop: false, speed: 1.3 });
    await this.gs.tween.tween(0.7, (t) => {
      actor.body.position.y = -t * t * 2.5;
      actor.body.rotation.y = t * Math.PI * 3;
      actor.body.scaling.setAll(1 - t * 0.9);
    });
    this.gs.fx.impact(hole, this.gs.layout.data.theme === 'forge' ? [1, 0.4, 0.05] : [0.5, 0.3, 0.9], false);
    const home = this.gs.layout.position(e.color, -1, e.piece);
    actor.place(home, this.gs.layout.forward(e.color, -1));
    actor.body.position.y = 0;
    actor.body.rotation.y = 0;
    await this.gs.tween.tween(0.3, (t) => actor.body.scaling.setAll(t));
    actor.body.scaling.setAll(1);
    actor.busy = false;
    void actor.oneShot('standUp', 1.5);
    this.gs.fx.dust(home, 14);
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
  }
}
