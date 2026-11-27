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
  protected readonly orbs = [0, 1, 2, 3, 4];

  private canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private scene: GameScene | null = null;
  private subs: Subscription[] = [];
  private feedSeq = 0;

  protected loading = signal(0);
  protected ready = signal(false);
  protected sceneBusy = signal(false);
  protected quality = signal<Quality>((localStorage.getItem(QUALITY_KEY) as Quality) || 'high');
  protected targeting = signal<AbilityInfo | null>(null);
  protected feed = signal<FeedLine[]>([]);
  protected showResults = signal(false);

  protected room = computed(() => this.store.room()!);
  protected match = computed(() => this.room().match!);
  protected finished = computed(() => this.room().state === 'finished');
  protected myColor = computed(() => this.store.me()?.color ?? null);
  protected myTeam = computed(() => (this.myColor() ? this.match().teams[this.myColor()!] : null));
  protected myHero = computed(() => this.store.hero(this.store.me()?.hero));
  protected currentPlayer = computed(() => this.playerOf(this.match().current));

  protected plates = computed(() =>
    this.match().turnOrder.map((color) => {
      const team = this.match().teams[color];
      const rank = this.match().ranking.indexOf(color);
      return {
        color,
        player: this.playerOf(color),
        hero: this.store.hero(team.hero)?.name ?? team.hero,
        mana: team.mana,
        maxMana: team.maxMana,
        home: team.pieces.filter((p) => p >= team.finish).length,
        pieces: team.pieces.length,
        rank: rank === -1 ? null : rank,
        active: !this.finished() && this.match().current === color,
      };
    }),
  );

  protected canAct = computed(() => this.store.myTurn() && !this.store.busy() && !this.sceneBusy() && !this.finished());
  protected canRoll = computed(() => this.canAct() && this.match().phase === 'roll' && !this.targeting());
  protected choosingMove = computed(() => this.canAct() && this.match().phase === 'move' && !this.targeting());

  protected status = computed(() => {
    const m = this.match();
    if (this.finished()) return 'Victory belongs to ' + (this.playerOf(m.ranking[0])?.name ?? '…');
    if (this.targeting()) return `${this.targeting()!.name}: pick a target · Esc to cancel`;
    if (this.store.myTurn()) return m.phase === 'roll' ? 'Your turn: cast a spell or roll the dice' : 'Choose a hero to move';
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

    // Keep the 3D scene's clickable pieces in sync with the HUD state.
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
  }

  /** Pieces a spell could be aimed at right now (the server still validates range etc.). */
  private targetsFor(ability: AbilityInfo): { color: Color; piece: number }[] {
    const m = this.match();
    const me = this.myColor();
    const scene = this.scene;
    if (!me || !scene || !this.ready()) return [];
    const team = m.teams[me];
    if (ability.targeting === 'enemyPiece') {
        const targets: { color: Color; piece: number }[] = [];
        for (const [color, t] of Object.entries(m.teams) as [Color, (typeof m.teams)[string]][]) {
          if (color === me) continue;
          t.pieces.forEach((p, i) => {
            const node = scene.layout.nodeAt(color, p);
            if (node && (node.kind === 'normal' || node.kind === 'shrine')) targets.push({ color, piece: i });
          });
        }
        return targets;
      }
      return team.pieces
        .map((p, i) => ({ p, i, node: scene.layout.nodeAt(me, p) }))
        .filter(({ p, node }) => p >= 0 && p < team.finish && node && (ability.targeting === 'ownPieceSteps' || node.kind !== 'home'))
        .map(({ i }) => ({ color: me, piece: i }));
  }

  private interaction = computed<Interaction>(() => {
    const m = this.match();
    const ability = this.targeting();
    if (!this.myColor() || !this.canAct()) return { mode: 'none' };
    if (ability) return { mode: 'target', targets: this.targetsFor(ability) };
    if (m.phase === 'move') return { mode: 'move', pieces: m.legalPieces };
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

  private onPick(t: { color: Color; piece: number }) {
    const ability = this.targeting();
    const me = this.myColor();
    if (ability && me) {
      this.targeting.set(null);
      if (ability.targeting === 'enemyPiece') {
        this.store.cast(ability.id, { color: t.color, piece: t.piece });
      } else if (ability.targeting === 'ownPieceSteps') {
        const team = this.match().teams[me];
        const steps = Math.max(1, Math.min(Number(ability.params['maxSteps'] ?? 3), team.finish - team.pieces[t.piece]));
        this.store.cast(ability.id, { piece: t.piece, steps });
      } else {
        this.store.cast(ability.id, { piece: t.piece });
      }
      return;
    }
    if (this.choosingMove() && t.color === me) this.store.move(t.piece);
  }

  protected canCast(a: AbilityInfo): boolean {
    const team = this.myTeam();
    const phase = this.match().phase;
    return (
      this.canAct() &&
      !!team &&
      !this.match().castUsed &&
      team.mana >= a.cost &&
      (phase === 'roll' || phase === 'move') &&
      this.targetsFor(a).length > 0
    );
  }

  protected toggleAbility(a: AbilityInfo) {
    if (this.targeting()?.id === a.id) {
      this.targeting.set(null);
      return;
    }
    if (!this.canCast(a)) return;
    this.targeting.set(a);
    this.sound.play('click');
  }

  protected roll() {
    if (this.canRoll()) this.store.roll();
  }

  protected setQuality(q: Quality) {
    if (q === this.quality()) return;
    localStorage.setItem(QUALITY_KEY, q);
    location.reload();
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    if (el?.closest?.('input, textarea')) return;
    if (e.key === 'Escape') this.targeting.set(null);
    if ((e.key === ' ' || e.key === 'Enter') && this.canRoll()) {
      e.preventDefault();
      this.roll();
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
          push(`✨ ${this.name(e.color)} cast ${ability?.name ?? e.ability}`, e.color);
          break;
        }
        case 'knockedBack':
          push(`${this.name(e.color)} was knocked back ${e.from - e.to}`, e.color);
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
