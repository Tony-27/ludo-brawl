import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiError, ApiService } from './api.service';
import { Color, RoomView, Session } from './models';
import { ToastService } from './toast.service';

const SESSION_KEY = (code: string) => `ludo-brawl:session:${code.toUpperCase()}`;
const NAME_KEY = 'ludo-brawl:name';

/**
 * Holds the room the user is in, keeps it live over a WebSocket and exposes
 * the actions they can take. Components read signals and call methods.
 */
@Injectable({ providedIn: 'root' })
export class RoomStore {
  private api = inject(ApiService);
  private router = inject(Router);
  private toast = inject(ToastService);

  readonly session = signal<Session | null>(null);
  readonly room = signal<RoomView | null>(null);
  readonly connected = signal(false);
  readonly busy = signal(false);
  /** Local clock deadline (ms since epoch) for the current human turn. */
  readonly turnDeadline = signal<number | null>(null);

  readonly me = computed(() => {
    const room = this.room();
    const s = this.session();
    return room && s ? room.players.find((p) => p.id === s.playerId) ?? null : null;
  });
  readonly isHost = computed(() => !!this.me() && this.room()?.hostId === this.me()!.id);
  readonly myTurn = computed(() => {
    const room = this.room();
    return room?.state === 'playing' && room.game?.current === this.me()?.color;
  });

  private ws: WebSocket | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------- name
  get savedName(): string {
    return localStorage.getItem(NAME_KEY) ?? '';
  }

  private saveName(name: string) {
    localStorage.setItem(NAME_KEY, name.trim());
  }

  // ---------------------------------------------------------------- entering
  hasSession(code: string): boolean {
    return !!localStorage.getItem(SESSION_KEY(code));
  }

  async create(name: string) {
    return this.enter(() => this.api.createRoom(name), name);
  }

  async join(code: string, name: string) {
    return this.enter(() => this.api.joinRoom(code, name), name);
  }

  private async enter(fn: () => Promise<{ room: RoomView } & Session>, name: string) {
    this.busy.set(true);
    try {
      const r = await fn();
      this.saveName(name);
      const s: Session = { code: r.code, playerId: r.playerId, token: r.token };
      localStorage.setItem(SESSION_KEY(s.code), JSON.stringify(s));
      this.attach(s, r.room);
      await this.router.navigate(['/room', s.code]);
      return true;
    } catch (e) {
      this.toast.error((e as Error).message);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** Called by the room page: resume a stored session for this code, if any. */
  resume(code: string): boolean {
    code = code.toUpperCase();
    if (this.session()?.code === code) return true;
    const raw = localStorage.getItem(SESSION_KEY(code));
    if (!raw) return false;
    try {
      this.attach(JSON.parse(raw) as Session, null);
      return true;
    } catch {
      localStorage.removeItem(SESSION_KEY(code));
      return false;
    }
  }

  private attach(s: Session, room: RoomView | null) {
    this.disconnect();
    this.session.set(s);
    this.room.set(room);
    this.retry = 0;
    this.connect();
  }

  // ---------------------------------------------------------------- socket
  private connect() {
    const s = this.session();
    if (!s) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${s.code}/ws?token=${encodeURIComponent(s.token)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.connected.set(true);
      this.retry = 0;
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 20000);
    };
    ws.onmessage = (ev) => this.apply(JSON.parse(ev.data) as RoomView);
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // replaced or intentionally closed
      this.connected.set(false);
      this.clearPing();
      if (ev.code === 4403 || ev.code === 4404) {
        this.forget(ev.reason || 'That room is no longer available.');
        return;
      }
      const delay = Math.min(1000 * 2 ** this.retry++, 8000);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private apply(room: RoomView) {
    const current = this.room();
    if (current && current.code === room.code && room.version < current.version) return;
    this.room.set(room);
    const ms = room.game?.turnTimeLeftMs;
    this.turnDeadline.set(ms == null ? null : Date.now() + ms);
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

  /** Drop the session (room gone / we were removed) and go back home. */
  forget(message?: string) {
    const s = this.session();
    if (s) localStorage.removeItem(SESSION_KEY(s.code));
    this.disconnect();
    this.session.set(null);
    this.room.set(null);
    if (message) this.toast.info(message);
    this.router.navigate(['/']);
  }

  // ---------------------------------------------------------------- actions
  private async act(fn: (s: Session) => Promise<RoomView | void>) {
    const s = this.session();
    if (!s || this.busy()) return;
    this.busy.set(true);
    try {
      const room = await fn(s);
      if (room) this.apply(room);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        this.forget(e.message);
      } else {
        this.toast.error((e as Error).message);
      }
    } finally {
      this.busy.set(false);
    }
  }

  addBot = () => this.act((s) => this.api.addBot(s));
  kick = (playerId: string) => this.act((s) => this.api.kick(s, playerId));
  setColor = (color: Color) => this.act((s) => this.api.setColor(s, color));
  start = () => this.act((s) => this.api.start(s));
  roll = () => this.act((s) => this.api.roll(s));
  move = (piece: number) => this.act((s) => this.api.move(s, piece));
  rematch = () => this.act((s) => this.api.rematch(s));

  async leave() {
    const s = this.session();
    if (!s) return;
    try {
      await this.api.leave(s);
    } catch {
      // Leaving should always succeed from the user's point of view.
    }
    this.forget();
  }

  /** Stop listening without leaving the room (e.g. navigating away). */
  detach() {
    this.disconnect();
    this.session.set(null);
    this.room.set(null);
  }
}
