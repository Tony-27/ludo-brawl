import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { ApiError, ApiService } from './api.service';
import { HeroInfo, MapSummary } from './catalog';
import { GuestService } from './guest.service';
import type { ClientMessage, Color, EventsMessage, RoomView, ServerMessage } from './protocol';
import { ToastService } from './toast.service';

const LAST_ROOM = 'ludo-brawl:lastRoom';

/**
 * The room the player is in: live over a WebSocket, with REST for lobby
 * actions and WebSocket commands for in-game actions. Game events are
 * re-emitted on `events$` for the 3D scene to animate.
 */
@Injectable({ providedIn: 'root' })
export class RoomStore {
  private api = inject(ApiService);
  private guests = inject(GuestService);
  private router = inject(Router);
  private toast = inject(ToastService);

  readonly room = signal<RoomView | null>(null);
  readonly connected = signal(false);
  readonly busy = signal(false);
  readonly turnDeadline = signal<number | null>(null);
  readonly heroes = signal<HeroInfo[]>([]);
  readonly maps = signal<MapSummary[]>([]);
  readonly events$ = new Subject<EventsMessage>();
  readonly snapshots$ = new Subject<RoomView>();

  readonly myId = computed(() => this.guests.guest()?.id ?? null);
  readonly me = computed(() => this.room()?.players.find((p) => p.id === this.myId()) ?? null);
  readonly isHost = computed(() => !!this.me() && this.room()?.hostId === this.myId());
  readonly myTurn = computed(() => {
    const r = this.room();
    return r?.state === 'playing' && !!r.match && r.match.current === this.me()?.color;
  });

  private ws: WebSocket | null = null;
  private code: string | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  async loadCatalog() {
    if (this.heroes().length && this.maps().length) return;
    try {
      const [heroes, maps] = await Promise.all([this.api.heroes(), this.api.maps()]);
      this.heroes.set(heroes);
      this.maps.set(maps);
    } catch (e) {
      this.toast.error((e as Error).message);
    }
  }

  hero(id: string | undefined): HeroInfo | undefined {
    return this.heroes().find((h) => h.id === id);
  }

  get lastRoom(): string | null {
    return localStorage.getItem(LAST_ROOM);
  }

  // ---------------------------------------------------------------- entering
  async create(name: string, mapId?: string) {
    return this.enter(name, () => this.api.createRoom(mapId));
  }

  async join(name: string, code: string) {
    return this.enter(name, () => this.api.join(code));
  }

  private async enter(name: string, fn: () => Promise<RoomView>) {
    this.busy.set(true);
    try {
      await this.guests.ensure(name);
      const room = await fn();
      localStorage.setItem(LAST_ROOM, room.code);
      this.attach(room.code, room);
      await this.router.navigate(['/room', room.code]);
      return true;
    } catch (e) {
      this.toast.error((e as Error).message);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** Called by the room page for a direct link / refresh. */
  async resume(code: string): Promise<boolean> {
    code = code.toUpperCase();
    if (this.code === code && this.ws) return true;
    if (!this.guests.guest()) return false;
    try {
      const room = await this.api.room(code);
      if (!room.players.some((p) => p.id === this.myId())) return false;
      this.attach(code, room);
      return true;
    } catch {
      return false;
    }
  }

  private attach(code: string, room: RoomView | null) {
    this.disconnect();
    this.code = code;
    this.room.set(room);
    this.retry = 0;
    void this.loadCatalog();
    this.connect();
  }

  // ---------------------------------------------------------------- socket
  private connect() {
    const token = this.guests.guest()?.token;
    if (!this.code || !token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${this.code}/ws?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected.set(true);
      this.retry = 0;
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 20000);
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data) as ServerMessage);
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.connected.set(false);
      this.clearPing();
      if (ev.code >= 4400 && ev.code < 4500) {
        this.forget(ev.reason || 'That room is no longer available.');
        return;
      }
      const delay = Math.min(1000 * 2 ** this.retry++, 8000);
      this.retryTimer = setTimeout(() => void this.reconnect(), delay);
    };
  }

  /** After a few failed attempts, check the room still exists (e.g. the server restarted). */
  private async reconnect() {
    const code = this.code;
    if (!code) return;
    if (this.retry >= 3) {
      try {
        const room = await this.api.room(code);
        if (!room.players.some((p) => p.id === this.myId())) {
          this.forget('You are no longer in that room.');
          return;
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          this.forget('That room has closed.');
          return;
        }
      }
    }
    if (this.code === code) this.connect();
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'hello':
      case 'snapshot':
        this.adopt(msg.room);
        this.snapshots$.next(msg.room);
        break;
      case 'events':
        this.adopt(msg.room);
        this.busy.set(false);
        this.events$.next(msg);
        break;
      case 'error':
        this.busy.set(false);
        this.toast.error(msg.message);
        break;
    }
  }

  private adopt(room: RoomView) {
    const cur = this.room();
    if (cur && cur.code === room.code && room.version < cur.version) return;
    this.room.set(room);
    const ms = room.match?.turnTimeLeftMs;
    this.turnDeadline.set(ms == null ? null : Date.now() + ms);
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private clearPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private disconnect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearPing();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.connected.set(false);
  }

  forget(message?: string) {
    localStorage.removeItem(LAST_ROOM);
    this.disconnect();
    this.code = null;
    this.room.set(null);
    if (message) this.toast.info(message);
    void this.router.navigate(['/']);
  }

  detach() {
    this.disconnect();
    this.code = null;
    this.room.set(null);
  }

  // ---------------------------------------------------------------- in-game (WebSocket)
  private command(msg: ClientMessage) {
    if (this.busy()) return;
    this.busy.set(true);
    this.send(msg);
    // Never stay stuck if the server doesn't answer.
    setTimeout(() => this.busy.set(false), 4000);
  }

  roll = () => this.command({ type: 'roll' });
  move = (piece: number, lane: number | null = null) => this.command({ type: 'move', piece, lane });
  practice = (body: { dice?: number | null; mana?: number | null }) =>
    this.send({ type: 'practice', dice: body.dice ?? null, mana: body.mana ?? null });
  cast = (ability: string, target: Record<string, unknown>) => this.command({ type: 'cast', ability, target });

  // ---------------------------------------------------------------- lobby (REST)
  private async act(fn: (code: string) => Promise<RoomView | void>) {
    const code = this.code;
    if (!code || this.busy()) return;
    this.busy.set(true);
    try {
      const room = await fn(code);
      if (room) this.adopt(room);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) this.forget(e.message);
      else this.toast.error((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  addBot = (hero?: string) => this.act((c) => this.api.addBot(c, hero));
  kick = (playerId: string) => this.act((c) => this.api.kick(c, playerId));
  loadout = (body: { color?: Color; hero?: string; skin?: string }) => this.act((c) => this.api.loadout(c, body));
  setMap = (mapId: string) => this.act((c) => this.api.setMap(c, mapId));
  setPractice = (enabled: boolean) => this.act((c) => this.api.setPractice(c, enabled));
  start = () => this.act((c) => this.api.start(c));
  rematch = () => this.act((c) => this.api.rematch(c));

  async leave() {
    const code = this.code;
    if (code) {
      try {
        await this.api.leave(code);
      } catch {
        // Leaving always succeeds from the player's point of view.
      }
    }
    this.forget();
  }
}
