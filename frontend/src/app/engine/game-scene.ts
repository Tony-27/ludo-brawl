import { Engine, PointerEventTypes, Scene, Vector3 } from '@babylonjs/core';
import type { Color, EventsMessage, PlayerView, RoomView } from '../core/protocol';
import { AssetLoader } from './assets/asset-loader';
import { SKINS, TEAM_RGB, skinArt } from './assets/catalog';
import { CharacterActor } from './actors/character';
import { WorldDice } from './actors/dice';
import { CameraDirector } from './camera/director';
import { Animator } from './core/tween';
import { PostFx } from './post/pipeline';
import { EventPlayer, SceneCue } from './presentation/event-player';
import { Effects } from './vfx/effects';
import { BoardLayout, MapData } from './world/map-data';
import { World, buildWorld } from './world/world';

export type Quality = 'high' | 'medium';

/** What the local player can click right now. */
export type Interaction =
  | { mode: 'none' }
  | { mode: 'move'; options: { piece: number; lane: number | null; to: number }[] }
  | { mode: 'target'; targets: { color: Color; piece: number }[] }
  | { mode: 'tile'; tiles: string[] };

export interface PieceTarget {
  color: Color;
  piece: number;
  lane?: number | null;
}

export interface GameSceneOptions {
  map: MapData;
  room: RoomView;
  myColor: Color | null;
  quality: Quality;
  onProgress?: (fraction: number) => void;
}

/**
 * The game's 3D presentation layer. Angular hands it server messages and
 * interaction modes; it renders, animates and reports clicks and cues back.
 * It never decides game outcomes: the server is the source of truth.
 */
export class GameScene {
  onPick: (target: PieceTarget) => void = () => {};
  onPickTile: (nodeId: string) => void = () => {};
  onCue: (cue: SceneCue) => void = () => {};

  readonly engine: Engine;
  readonly scene: Scene;
  readonly layout: BoardLayout;
  readonly tween = new Animator();
  readonly director: CameraDirector;
  readonly fx: Effects;
  readonly actors = new Map<string, CharacterActor>();
  world!: World;
  dice!: WorldDice;
  private post!: PostFx;
  private player!: EventPlayer;
  private assets: AssetLoader;
  private interaction: Interaction = { mode: 'none' };
  /** A piece picked at a fork, waiting for the player to choose its lane. */
  private laneChoice: { piece: number; tiles: [string, string] } | null = null;
  private hovered: CharacterActor | null = null;
  private resize = () => this.engine.resize();
  private disposed = false;
  timeScale = 1;
  /** Longest frame step simulated at once; keeps big hitches from teleporting things. */
  maxDt = 0.05;

  private constructor(
    private canvas: HTMLCanvasElement,
    private opts: GameSceneOptions,
  ) {
    this.engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' }, true);
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, opts.quality === 'high' ? 1.5 : 1));
    this.scene = new Scene(this.engine);
    this.scene.skipPointerMovePicking = false;
    this.layout = new BoardLayout(opts.map);
    this.assets = new AssetLoader(this.scene);
    this.director = new CameraDirector(this.scene, canvas, opts.map.bounds);
    this.fx = new Effects(this.scene, this.tween);
  }

  static async create(canvas: HTMLCanvasElement, opts: GameSceneOptions): Promise<GameScene> {
    const gs = new GameScene(canvas, opts);
    await gs.init();
    return gs;
  }

  private async init() {
    const { room, quality, myColor } = this.opts;
    const skins = new Set(room.players.map((p) => skinArt(p.skin, p.hero).model));
    let progress = 0;
    this.assets.onProgress = (f) => {
      progress = f;
      this.opts.onProgress?.(Math.min(0.99, f));
    };
    await this.assets.preload([...skins]);
    this.world = await buildWorld(this.scene, this.layout, this.assets, quality);
    this.post = new PostFx(this.scene, this.director.camera, quality, this.tween);
    this.dice = new WorldDice(this.scene, this.world.shadows, this.tween);

    await this.spawnActors(room.players);
    const home = myColor ?? room.match?.turnOrder[0] ?? 'red';
    const camp = Vector3.FromArray(this.opts.map.camps[home].center);
    this.director.setHomeAngle(camp);
    // Open on your own heroes, then the event player takes over the camera.
    this.director.followTarget(() => camp, 14, 0.95);
    this.director.snap();
    this.player = new EventPlayer(this);
    if (room.match) this.player.reconcile(room, true);

    this.scene.onPointerObservable.add((info) => {
      const meta = info.pickInfo?.pickedMesh?.metadata;
      if (info.type === PointerEventTypes.POINTERTAP) {
        if (meta?.highlight) this.handleTile(meta.nodeId);
        else this.handlePick(meta?.actor);
      }
      if (info.type === PointerEventTypes.POINTERMOVE) this.handleHover(meta?.actor, !!meta?.highlight);
    });
    const clickable = (m: { isPickable: boolean; metadata?: { actor?: unknown; highlight?: boolean } }) =>
      m.isPickable && (!!m.metadata?.actor || !!m.metadata?.highlight);
    this.scene.pointerMovePredicate = clickable;
    this.scene.pointerDownPredicate = clickable;

    let last = performance.now();
    this.engine.runRenderLoop(() => {
      const now = performance.now();
      const dt = Math.min(this.maxDt, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      this.tween.update(dt * this.timeScale);
      this.director.update(dt);
      this.world.update(dt, t);
      for (const a of this.actors.values()) a.update(dt, t);
      this.scene.render();
    });
    window.addEventListener('resize', this.resize);
    if (localStorage.getItem('ludo-brawl:debug')) {
      // Dev aid: inspect from the console, e.g. ludoDebug.scene.debugLayer.show()
      (window as unknown as Record<string, unknown>)['ludoDebug'] = this;
      this.maxDt = Number(localStorage.getItem('ludo-brawl:maxDt')) || this.maxDt;
    }
    void progress;
    this.opts.onProgress?.(1);
  }

  private async spawnActors(players: PlayerView[]) {
    const pieces = this.opts.map.piecesPerTeam;
    await Promise.all(
      players.map(async (p) => {
        const art = skinArt(p.skin, p.hero);
        const container = await this.assets.load(art.model);
        for (let i = 0; i < pieces; i++) {
          const actor = new CharacterActor(this.scene, container, art, p.color, i, this.world.shadows, this.tween);
          // Heroes scale with the board so they fit their tiles on every map.
          actor.root.scaling.setAll(Math.max(0.62, Math.min(1, this.world.spacing / 1.45)));
          actor.place(this.layout.position(p.color, -1, i), this.layout.forward(p.color, -1));
          this.actors.set(`${p.color}${i}`, actor);
        }
      }),
    );
  }

  get myColor(): Color | null {
    return this.opts.myColor;
  }

  actor(color: Color, piece: number): CharacterActor | undefined {
    return this.actors.get(`${color}${piece}`);
  }

  teamRgb(color: Color): [number, number, number] {
    return TEAM_RGB[color];
  }

  skinFor(color: Color) {
    const p = this.player?.room?.players.find((x) => x.color === color) ?? this.opts.room.players.find((x) => x.color === color);
    return p ? skinArt(p.skin, p.hero) : SKINS['samurai_default'];
  }

  // ------------------------------------------------------------------ input from Angular
  enqueue(msg: EventsMessage) {
    this.player.enqueue(msg);
  }

  snapshot(room: RoomView) {
    this.player.snapshot(room);
  }

  get animating(): boolean {
    return this.player.busy;
  }

  setInteraction(i: Interaction) {
    const changed = JSON.stringify(i) !== JSON.stringify(this.interaction);
    this.interaction = i;
    this.laneChoice = null;
    this.refreshHighlights();
    if (changed && !this.player?.busy) this.frameInteraction();
  }

  refreshHighlights() {
    const busy = !!this.player?.busy;
    const allowed = this.allowed();
    for (const a of this.actors.values()) a.setHighlighted(!busy && allowed.has(a));
    const i = this.interaction;
    const me = this.opts.myColor;
    if (busy) this.world?.highlightTiles([], [1, 1, 1]);
    else if (this.laneChoice) this.world?.highlightTiles(this.laneChoice.tiles, [0.55, 1, 0.75]);
    else if (i.mode === 'tile') this.world?.highlightTiles(i.tiles, me ? this.teamRgb(me) : [1, 0.85, 0.3]);
    else this.world?.highlightTiles([], [1, 1, 1]);
  }

  /** Point the camera at everything the player is choosing between. */
  frameInteraction() {
    const i = this.interaction;
    const me = this.opts.myColor;
    if (!me || i.mode === 'none') return;
    const pts: Vector3[] = [];
    if (i.mode === 'move') {
      const room = this.player.room;
      for (const o of i.options) {
        const a = this.actor(me, o.piece);
        if (a) pts.push(a.position.clone());
        pts.push(this.layout.position(me, o.to, o.piece, o.lane ?? room?.match?.teams[me]?.lanes[o.piece] ?? 0));
      }
    } else if (i.mode === 'target') {
      for (const t of i.targets) {
        const a = this.actor(t.color, t.piece);
        if (a) pts.push(a.position.clone());
      }
    } else if (i.mode === 'tile') {
      for (const id of i.tiles) {
        const n = this.layout.nodes.get(id);
        if (n) pts.push(Vector3.FromArray(n.pos));
      }
    }
    this.director.frame(pts);
  }

  /** Hotkeys and hero cards: look at one piece, a camp, or the whole map. */
  focusPiece(color: Color, piece: number) {
    const a = this.actor(color, piece);
    if (a) this.director.followTarget(() => a.position, 10, 0.92);
  }

  focusCamp(color: Color) {
    const c = Vector3.FromArray(this.opts.map.camps[color].center);
    this.director.followTarget(() => c, 12, 0.9);
  }

  overview() {
    this.director.overview();
  }

  private allowed(): Set<CharacterActor> {
    const i = this.interaction;
    const set = new Set<CharacterActor>();
    const me = this.opts.myColor;
    if (i.mode === 'move' && me) i.options.forEach((o) => this.actor(me, o.piece) && set.add(this.actor(me, o.piece)!));
    if (i.mode === 'target') i.targets.forEach((t) => this.actor(t.color, t.piece) && set.add(this.actor(t.color, t.piece)!));
    return set;
  }

  /** Called by hero cards and 3D clicks alike. */
  pickPiece(color: Color, piece: number) {
    const i = this.interaction;
    if (this.player.busy) return;
    if (i.mode === 'move' && color === this.opts.myColor) {
      const opts = i.options.filter((o) => o.piece === piece);
      if (!opts.length) return;
      if (opts.length > 1) {
        // A fork: show both landing tiles and wait for a choice.
        const tiles = opts.map((o) => this.layout.nodeAt(color, o.to, o.lane ?? 0)!.id) as [string, string];
        this.laneChoice = { piece, tiles };
        this.refreshHighlights();
        this.director.frame(tiles.map((id) => Vector3.FromArray(this.layout.nodes.get(id)!.pos)).concat([this.actor(color, piece)!.position.clone()]));
        this.onCue('step');
        return;
      }
      this.onPick({ color, piece, lane: opts[0].lane });
      return;
    }
    if (i.mode === 'target' && i.targets.some((t) => t.color === color && t.piece === piece)) {
      this.onPick({ color, piece });
    }
  }

  private handlePick(actor: CharacterActor | undefined) {
    if (!actor || this.player.busy || !this.allowed().has(actor)) return;
    this.pickPiece(actor.team, actor.piece);
  }

  private handleTile(nodeId: string) {
    if (this.player.busy) return;
    if (this.laneChoice) {
      const lane = this.laneChoice.tiles.indexOf(nodeId);
      const piece = this.laneChoice.piece;
      this.laneChoice = null;
      this.refreshHighlights();
      if (lane >= 0 && this.opts.myColor) this.onPick({ color: this.opts.myColor, piece, lane });
      return;
    }
    if (this.interaction.mode === 'tile' && this.interaction.tiles.includes(nodeId)) this.onPickTile(nodeId);
  }

  private handleHover(actor: CharacterActor | undefined, overTile: boolean) {
    const ok = actor && !this.player.busy && this.allowed().has(actor) ? actor : null;
    this.hovered = ok;
    this.canvas.style.cursor = ok || overTile ? 'pointer' : '';
  }

  focusDepth(at: Vector3) {
    this.post.focus(Vector3.Distance(this.director.camera.position, at));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.resize);
    this.engine.stopRenderLoop();
    this.player?.dispose();
    for (const a of this.actors.values()) a.dispose();
    this.post?.dispose();
    this.fx.dispose();
    this.dice?.dispose();
    this.world?.dispose();
    this.assets.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}

export type { SceneCue };
