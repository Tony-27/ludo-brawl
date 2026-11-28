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
import type { Color, EventsMessage, GameEvent, PlayerView } from '../core/protocol';
import { RoomStore } from '../core/room-store.service';
import { TEAM_CSS } from '../engine/assets/catalog';
import { GameScene, Interaction, Quality } from '../engine/game-scene';

const MEDALS = ['🥇', '🥈', '🥉', '4th'];
const QUALITY_KEY = 'ludo-brawl:quality';

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
  protected forcedDice = signal<number | null>(null);

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
        home: team.pieces.filter((p) => p >= team.finish).length,
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
      return {
        piece: idx,
        state: p < 0 ? 'camp' : p >= team.finish ? 'home' : 'trail',
        progress: Math.max(0, Math.min(1, p / team.finish)),
        label: p < 0 ? 'In camp' : p >= team.finish ? 'Home!' : `${Math.round((p / team.finish) * 100)}% of the way`,
        statuses: team.statuses[idx] ?? [],
        actionable,
      };
    });
  });

  protected canAct = computed(() => this.store.myTurn() && !this.store.busy() && !this.sceneBusy() && !this.finished());
  protected canRoll = computed(() => this.canAct() && this.match().phase === 'roll' && !this.targeting());
  protected choosingMove = computed(() => this.canAct() && this.match().phase === 'move' && !this.targeting());

  protected status = computed(() => {
    const m = this.match();
    if (this.finished()) return 'Victory belongs to ' + (this.playerOf(m.ranking[0])?.name ?? '…');
    if (this.targeting()) return `${this.targeting()!.name}: pick a target · Esc to cancel`;
    if (this.store.myTurn()) {
      if (m.phase === 'roll') return 'Your turn: cast a spell or roll the dice';
      return m.moveOptions.some((o) => o.lane !== null) ? 'Choose a hero to move (forks: pick a lane)' : 'Choose a hero to move';
    }
    const who = this.currentPlayer();
    return who ? `${who.name} is ${m.phase === 'roll' ? 'rolling' : 'choosing a move'}…` : '';
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

  protected abilityState(a: AbilityInfo): 'ready' | 'used' | 'noTarget' | 'noMana' | 'wait' {
    const team = this.myTeam();
    if (a.slot === 'ultimate' && team?.ultUsed) return 'used';
    if (!this.canAct() || this.match().castUsed || !(this.match().phase === 'roll' || this.match().phase === 'move')) return 'wait';
    if ((team?.mana ?? 0) < a.cost) return 'noMana';
    return this.match().castTargets[a.id] ? 'ready' : 'noTarget';
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

  protected setQuality(q: Quality) {
    if (q === this.quality()) return;
    localStorage.setItem(QUALITY_KEY, q);
    location.reload();
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
    const me = this.myColor();
    switch (e.key) {
      case 'Escape':
        this.targeting.set(null);
        this.showHelp.set(false);
        return;
      case ' ':
      case 'Enter':
        if (this.canRoll()) {
          e.preventDefault();
          this.roll();
        }
        return;
      case 'Tab': {
        e.preventDefault();
        const team = this.myTeam();
        if (!me || !team) return;
        const onBoard = team.pieces.map((p, i) => ({ p, i })).filter(({ p }) => p >= 0 && p < team.finish);
        if (!onBoard.length) {
          this.scene?.focusCamp(me);
          return;
        }
        this.focusIndex = (this.focusIndex + 1) % onBoard.length;
        this.scene?.focusPiece(me, onBoard[this.focusIndex].i);
        return;
      }
      case 'h':
      case 'H':
        if (me) this.scene?.focusCamp(me);
        return;
      case 'q':
      case 'Q':
        this.scene?.overview();
        return;
      case '?':
        this.showHelp.update((v) => !v);
        return;
    }
    const n = Number(e.key);
    const abilities = this.myHero()?.abilities ?? [];
    if (n >= 1 && n <= abilities.length) this.toggleAbility(abilities[n - 1]);
  }

  protected playerOf(color: Color | undefined): PlayerView | null {
    return this.room().players.find((p) => p.color === color) ?? null;
  }

  private name(color: Color) {
    return this.playerOf(color)?.name ?? COLOR_LABEL[color];
  }

  private addFeed(msg: EventsMessage) {
    const lines: FeedLine[] = [];
    const push = (text: string, color: Color | null) => lines.push({ id: ++this.feedSeq, text, color });
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
