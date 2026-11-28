import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { SoundService } from '../audio/sound.service';
import { ApiService } from '../core/api.service';
import { AbilityInfo, COLOR_LABEL } from '../core/catalog';
import type { Color, EventsMessage, GameEvent, MoveOptionView, PlayerView } from '../core/protocol';
import { RoomStore } from '../core/room-store.service';
import { TEAM_CSS } from '../engine/assets/catalog';
import { GameScene, Interaction, Quality } from '../engine/game-scene';

const MEDALS = ['🥇', '🥈', '🥉', '4th'];
const QUALITY_KEY = 'ludo-brawl:quality';
const SPELL_KEYS = ['Q', 'W', 'E'];

export type SpellState = 'ready' | 'used' | 'noTarget' | 'noMana' | 'wait' | 'spent';

interface FeedLine {
  id: number;
  text: string;
  color: Color | null;
}

@Component({
  selector: 'app-game',
  templateUrl: './game-view.html',
  styleUrl: './game-view.scss',
})
export class GameView implements OnDestroy {
  protected store = inject(RoomStore);
  private api = inject(ApiService);
  private sound = inject(SoundService);
  protected readonly teamCss = TEAM_CSS;
  protected readonly label = COLOR_LABEL;
  protected readonly medals = MEDALS;
  protected readonly dice = [1, 2, 3, 4, 5, 6];
  protected readonly spellKeys = SPELL_KEYS;
  protected readonly pips: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };

  private canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private scene: GameScene | null = null;
  private subs: Subscription[] = [];
  private feedSeq = 0;
  private focusIndex = 0;

  protected loading = signal(0);
  protected ready = signal(false);
  protected sceneBusy = signal(false);
  protected quality = signal<Quality>((localStorage.getItem(QUALITY_KEY) as Quality) || 'high');
  protected targeting = signal<AbilityInfo | null>(null);
  protected feed = signal<FeedLine[]>([]);
  protected showResults = signal(false);
  protected showHelp = signal(false);
  protected showSettings = signal(false);
  protected forcedDice = signal<number | null>(null);
  /** Route cards shown when a hero reaches a fork. */
  protected routeChoice = signal<{ piece: number; options: MoveOptionView[] } | null>(null);

  protected room = computed(() => this.store.room()!);
  protected match = computed(() => this.room().match!);
  protected finished = computed(() => this.room().state === 'finished');
  protected myColor = computed(() => this.store.me()?.color ?? null);
  protected myTeam = computed(() => (this.myColor() ? this.match().teams[this.myColor()!] : null));
  protected myHero = computed(() => this.store.hero(this.store.me()?.hero));
  protected currentPlayer = computed(() => this.playerOf(this.match().current));
  protected orbs = computed(() => Array.from({ length: this.myTeam()?.maxMana ?? 6 }, (_, i) => i));

  protected plates = computed(() =>
    this.match().turnOrder.map((color) => {
      const team = this.match().teams[color];
      const rank = this.match().ranking.indexOf(color);
      return {
        color,
        player: this.playerOf(color),
        hero: this.store.hero(team.hero)?.name ?? team.hero,
        mana: team.mana,
        orbs: Array.from({ length: team.maxMana }, (_, i) => i),
        home: team.finished.filter(Boolean).length,
        empowered: team.empowered,
        pieces: team.pieces.length,
        rank: rank === -1 ? null : rank,
        active: !this.finished() && this.match().current === color,
      };
    }),
  );

  /** One card per hero the player owns: where it is and whether it can act. */
  protected cards = computed(() => {
    const team = this.myTeam();
    const me = this.myColor();
    if (!team || !me) return [];
    const i = this.interaction();
    return team.pieces.map((p, idx) => {
      const actionable =
        (i.mode === 'move' && i.options.some((o) => o.piece === idx)) ||
        (i.mode === 'target' && i.targets.some((t) => t.color === me && t.piece === idx));
      const done = team.finished[idx];
      const left = team.remaining[idx] ?? team.finish;
      return {
        piece: idx,
        state: p < 0 ? 'camp' : done ? 'home' : 'trail',
        progress: p < 0 ? 0 : done ? 1 : Math.max(0, Math.min(1, 1 - left / (team.finish + 1))),
        label: p < 0 ? 'In camp' : done ? 'Home!' : `${left} tiles to go`,
        statuses: team.statuses[idx] ?? [],
        actionable,
      };
    });
  });

  protected canAct = computed(() => this.store.myTurn() && !this.store.busy() && !this.sceneBusy() && !this.finished());
  protected canRoll = computed(() => this.canAct() && this.match().phase === 'roll' && !this.targeting());
  protected choosingMove = computed(() => this.canAct() && this.match().phase === 'move' && !this.targeting());
  /** After moving: a short window to cast a spell, or end the turn. */
  protected canEndTurn = computed(() => this.canAct() && this.match().phase === 'act' && !this.targeting());
  /** The die value for this turn, shown until the move is made. */
  protected shownRoll = computed(() => {
    const m = this.match();
    return m.lastRoll != null && (m.phase === 'move' || m.phase === 'act') ? m.lastRoll : null;
  });
  protected spellAvailable = computed(() => !this.match().castUsed);

  protected status = computed(() => {
    const m = this.match();
    if (this.finished()) return 'Victory belongs to ' + (this.playerOf(m.ranking[0])?.name ?? '…');
    if (this.targeting()) return `${this.targeting()!.name}: pick a target · Esc to cancel`;
    if (this.store.myTurn()) {
      if (m.phase === 'roll') return 'Your turn: cast a spell or roll the dice';
      if (m.phase === 'act') return 'Cast a spell now, or end your turn';
      const fork = m.moveOptions.some((o) => o.lane !== null);
      return `You rolled ${m.lastRoll}: choose a hero to move${fork ? ' (at a fork, pick a route)' : ''}`;
    }
    const who = this.currentPlayer();
    const doing = m.phase === 'roll' ? 'rolling' : m.phase === 'act' ? 'deciding on a spell' : `moving a ${m.lastRoll}`;
    return who ? `${who.name} is ${doing}…` : '';
  });

  // Turn timer
  private now = signal(Date.now());
  private clock = setInterval(() => {
    this.now.set(Date.now());
    this.sceneBusy.set(this.scene?.animating ?? false);
  }, 200);
  protected timeLeft = computed(() => {
    const d = this.store.turnDeadline();
    if (d === null || this.finished()) return null;
    return Math.max(0, Math.ceil((d - this.now()) / 1000));
  });

  constructor() {
    afterNextRender(() => void this.boot());
    effect(() => {
      const interaction = this.interaction();
      untracked(() => this.scene?.setInteraction(interaction));
    });
    effect(() => {
      if (this.store.myTurn() && this.match().phase === 'roll') untracked(() => this.sound.play('yourTurn'));
    });
    effect(() => {
      if (this.finished() && !this.sceneBusy()) untracked(() => setTimeout(() => this.showResults.set(true), 1200));
    });
    // A spell that's no longer castable (turn ended, mana spent) can't stay armed.
    effect(() => {
      const a = this.targeting();
      if (a && !this.match().castTargets[a.id]) untracked(() => this.targeting.set(null));
    });
  }

  private interaction = computed<Interaction>(() => {
    const m = this.match();
    const me = this.myColor();
    const ability = this.targeting();
    if (!me || !this.canAct()) return { mode: 'none' };
    if (ability) {
      const targets = m.castTargets[ability.id] ?? [];
      if (ability.targeting === 'tile') return { mode: 'tile', tiles: targets.map((t) => String(t['node'])) };
      if (ability.targeting === 'enemyPiece') {
        return { mode: 'target', targets: targets.map((t) => ({ color: t['color'] as Color, piece: Number(t['piece']) })) };
      }
      const pieces = [...new Set(targets.map((t) => Number(t['piece'])))];
      return { mode: 'target', targets: pieces.map((piece) => ({ color: me, piece })) };
    }
    if (m.phase === 'move') return { mode: 'move', options: m.moveOptions };
    return { mode: 'none' };
  });

  private async boot() {
    const room = this.room();
    try {
      const map = await this.api.map(room.mapId);
      await this.store.loadCatalog();
      this.scene = await GameScene.create(this.canvasRef().nativeElement, {
        map,
        room: this.store.room()!,
        myColor: this.myColor(),
        quality: this.quality(),
        onProgress: (f) => this.loading.set(f),
      });
    } catch (e) {
      console.error(e);
      return;
    }
    const scene = this.scene;
    scene.onPick = (t) => this.onPick(t);
    scene.onPickTile = (id) => this.onPickTile(id);
    scene.onCue = (cue) => this.sound.play(cue);
    scene.onRouteChoice = (c) => this.routeChoice.set(c);
    scene.snapshot(this.store.room()!);
    scene.setInteraction(this.interaction());
    this.subs.push(
      this.store.events$.subscribe((msg) => {
        this.addFeed(msg);
        scene.enqueue(msg);
      }),
      this.store.snapshots$.subscribe((r) => scene.snapshot(r)),
    );
    this.ready.set(true);
  }

  private onPick(t: { color: Color; piece: number; lane?: number | null }) {
    const ability = this.targeting();
    if (ability) {
      this.targeting.set(null);
      this.scene?.preview([]);
      const targets = this.match().castTargets[ability.id] ?? [];
      if (ability.targeting === 'enemyPiece') {
        this.store.cast(ability.id, { color: t.color, piece: t.piece });
      } else if (ability.targeting === 'ownPieceSteps') {
        // Furthest valid blink for that piece.
        const best = targets.filter((x) => x['piece'] === t.piece).sort((a, b) => Number(b['steps']) - Number(a['steps']))[0];
        if (best) this.store.cast(ability.id, best);
      } else {
        this.store.cast(ability.id, { piece: t.piece });
      }
      return;
    }
    if (this.choosingMove() && t.color === this.myColor()) this.store.move(t.piece, t.lane ?? null);
  }

  private onPickTile(nodeId: string) {
    const ability = this.targeting();
    if (!ability) return;
    this.targeting.set(null);
    this.store.cast(ability.id, { node: nodeId });
  }

  protected abilityState(a: AbilityInfo): SpellState {
    const team = this.myTeam();
    if (a.slot === 'ultimate' && team?.ultUsed) return 'used';
    if (!this.canAct() || this.match().phase === 'over') return 'wait';
    if (this.match().castUsed) return 'spent';
    if ((team?.mana ?? 0) < a.cost) return 'noMana';
    return this.match().castTargets[a.id] ? 'ready' : 'noTarget';
  }

  /** Why a spell can't be cast right now (shown on the button). */
  protected abilityReason(a: AbilityInfo): string {
    const team = this.myTeam();
    const p = a.params;
    switch (this.abilityState(a)) {
      case 'ready':
        return a.slot === 'ultimate' ? 'Ready · once per match' : 'Ready';
      case 'used':
        return 'Ultimate used (once per match)';
      case 'wait':
        return this.store.myTurn() ? 'Wait for the animation' : 'Wait for your turn';
      case 'spent':
        return 'Already cast a spell this turn';
      case 'noMana':
        return `Need ${a.cost} mana (you have ${team?.mana ?? 0})`;
      case 'noTarget':
        switch (a.effect) {
          case 'line':
            return `No enemy in the ${p['reach']} tiles ahead`;
          case 'strike':
          case 'swap':
            return `No enemy within ${p['range']} tiles`;
          case 'radius':
            return `No enemy within ${p['radius']} tiles${p['aheadOnly'] ? ' ahead' : ''}`;
          case 'dash':
          case 'blink':
            return 'No hero can move that far';
          case 'meteor':
          case 'trap':
            return `No open tile within ${p['range']} tiles`;
          default:
            return 'Needs a hero out on the board';
        }
    }
  }

  /** Hovering a spell (or arming it) shows the tiles it would hit. */
  protected previewAbility(a: AbilityInfo | null) {
    const armed = this.targeting();
    const show = a ?? armed;
    if (!show || a?.targeting === 'tile') {
      this.scene?.preview([]);
      return;
    }
    const tiles = (this.match().castTargets[show.id] ?? []).flatMap((t) => (t['preview'] as string[] | undefined) ?? []);
    this.scene?.preview(tiles);
  }

  protected endTurn() {
    if (this.canEndTurn()) this.store.endTurn();
  }

  protected pickRoute(o: MoveOptionView) {
    this.scene?.chooseRoute(o.piece, o.lane ?? null);
  }

  protected routeExtra(o: MoveOptionView): string {
    if (!o.route) return '';
    const d = o.route.length - o.route.shortest;
    return d === 0 ? 'shortest' : `+${d} tiles`;
  }

  protected toggleAbility(a: AbilityInfo) {
    if (this.targeting()?.id === a.id) {
      this.targeting.set(null);
      return;
    }
    if (this.abilityState(a) !== 'ready') return;
    this.sound.play('click');
    if (a.targeting === 'none') {
      this.store.cast(a.id, {});
      return;
    }
    this.targeting.set(a);
    this.previewAbility(a);
  }

  protected roll() {
    if (this.canRoll()) this.store.roll();
  }

  protected cardClick(piece: number) {
    const me = this.myColor();
    if (!me || !this.scene) return;
    const card = this.cards().find((c) => c.piece === piece);
    if (card?.actionable) this.scene.pickPiece(me, piece);
    else this.scene.focusPiece(me, piece);
  }

  /** Switch graphics quality by rebuilding the 3D scene in place (no page reload). */
  protected async setQuality(q: Quality) {
    if (q === this.quality() || !this.ready()) return;
    localStorage.setItem(QUALITY_KEY, q);
    this.quality.set(q);
    this.targeting.set(null);
    this.subs.forEach((s) => s.unsubscribe());
    this.subs = [];
    this.scene?.dispose();
    this.scene = null;
    this.ready.set(false);
    this.loading.set(0);
    await this.boot();
  }

  protected forceDice(v: number) {
    this.forcedDice.set(v);
    this.store.practice({ dice: v });
  }

  protected maxMana() {
    this.store.practice({ mana: this.myTeam()?.maxMana ?? 6 });
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    if (el?.closest?.('input, textarea')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const me = this.myColor();
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const route = this.routeChoice();
    switch (key) {
      case 'Escape':
        this.targeting.set(null);
        this.scene?.preview([]);
        this.showHelp.set(false);
        this.showSettings.set(false);
        return;
      case ' ':
        e.preventDefault();
        if (this.canRoll()) this.roll();
        else if (this.canEndTurn()) this.endTurn();
        return;
      case 'Enter':
        if (this.canEndTurn()) {
          e.preventDefault();
          this.endTurn();
        } else if (this.canRoll()) {
          e.preventDefault();
          this.roll();
        }
        return;
      case 'Tab': {
        e.preventDefault();
        const team = this.myTeam();
        if (!me || !team) return;
        const onBoard = team.tiles.map((t, i) => ({ t, i })).filter(({ t, i }) => t && !team.finished[i]);
        if (!onBoard.length) {
          this.scene?.focusCamp(me);
          return;
        }
        this.focusIndex = (this.focusIndex + 1) % onBoard.length;
        this.scene?.focusPiece(me, onBoard[this.focusIndex].i);
        return;
      }
      case '1':
      case '2':
      case '3': {
        const n = Number(key) - 1;
        // With route cards open, number keys pick a route; otherwise they jump to that hero.
        if (route) {
          const o = route.options[n];
          if (o) this.pickRoute(o);
          return;
        }
        if (me && n < (this.myTeam()?.pieces.length ?? 0)) this.scene?.focusPiece(me, n);
        return;
      }
      case '4':
        if (me) this.scene?.focusCamp(me);
        return;
      case '5':
        this.scene?.overview();
        return;
      case 'Q':
      case 'W':
      case 'E': {
        const abilities = this.myHero()?.abilities ?? [];
        const a = abilities[SPELL_KEYS.indexOf(key)];
        if (a) this.toggleAbility(a);
        return;
      }
      case '?':
        this.showHelp.update((v) => !v);
        return;
    }
  }

  protected playerOf(color: Color | undefined): PlayerView | null {
    return this.room().players.find((p) => p.color === color) ?? null;
  }

  private name(color: Color) {
    return this.playerOf(color)?.name ?? COLOR_LABEL[color];
  }

  private addFeed(msg: EventsMessage) {
    const lines: FeedLine[] = [];
    const push = (text: string, color: Color | null) => {
      if (lines.some((l) => l.text === text)) return; // e.g. several lakes thawing at once
      lines.push({ id: ++this.feedSeq, text, color });
    };
    for (const e of msg.events as GameEvent[]) {
      switch (e.type) {
        case 'rolled':
          push(`${this.name(e.color)} rolled a ${e.value}`, e.color);
          break;
        case 'captured':
          push(`💥 ${this.name(e.byColor)} smashed ${this.name(e.color)} back to camp!`, e.byColor);
          break;
        case 'abilityCast': {
          const ability = this.store.heroes().flatMap((h) => h.abilities).find((a) => a.id === e.ability);
          push(`${ability?.slot === 'ultimate' ? '🌟' : '✨'} ${this.name(e.color)} cast ${ability?.name ?? e.ability}`, e.color);
          break;
        }
        case 'knockedBack':
          push(`${this.name(e.color)} was knocked back ${e.from - e.to}`, e.color);
          break;
        case 'fell':
          push(`🕳 ${this.name(e.color)} fell into a pit!`, e.color);
          break;
        case 'portaled':
          push(`🌀 ${this.name(e.color)} took a portal`, e.color);
          break;
        case 'tileChanged':
          if (e.effect === 'broken') push('🌉 A bridge collapsed!', null);
          break;
        case 'blocked':
          push(`🛡 ${this.name(e.color)} blocked it!`, e.color);
          break;
        case 'pieceFinished':
          push(`🏁 ${this.name(e.color)} brought a hero home`, e.color);
          break;
        case 'playerFinished':
          push(`🏆 ${this.name(e.color)} finished #${e.place}`, e.color);
          break;
        case 'turnPassed':
          if (e.reason === 'threeSixes') push(`${this.name(e.color)} rolled three 6s and lost the turn`, e.color);
          break;
        case 'empowered':
          if (e.active) push(`⚒ ${this.name(e.color)} is empowered: next spell hits harder`, e.color);
          break;
        case 'mapEvent': {
          const text: Record<string, string> = {
            'eruption:warning': '🌋 The volcano rumbles: eruption next round!',
            'eruption:strike': '🌋 ERUPTION! The lava bridges are blasted',
            'avalanche:warning': '🏔 Snow is shifting: avalanche next round!',
            'avalanche:strike': '🏔 AVALANCHE on the cliff path!',
            'thaw:warning': '🧊 The frozen lakes are cracking…',
            'thaw:strike': '💧 The lakes thaw: shortcut closed',
            'freeze:strike': '❄ The lakes freeze over: shortcut open',
          };
          const line = text[`${e.event}:${e.stage}`];
          if (line) push(line, null);
          else if (e.event === 'conveyor' && e.tiles.length) push(e.value && e.value < 0 ? '⚙ Conveyors run backwards!' : '⚙ Conveyors run forwards', null);
          break;
        }
      }
    }
    if (lines.length) this.feed.update((f) => [...f, ...lines].slice(-7));
  }

  ngOnDestroy() {
    clearInterval(this.clock);
    this.subs.forEach((s) => s.unsubscribe());
    this.scene?.dispose();
    this.scene = null;
  }
}
