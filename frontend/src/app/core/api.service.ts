import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { MapData } from '../engine/world/map-data';
import { HeroInfo, MapSummary } from './catalog';
import type { Color, GuestSession, RoomView } from './protocol';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** REST client. Every call resolves or throws an ApiError with a friendly message. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  /** Set by GuestService once the player has an identity. */
  token: string | null = null;

  createGuest(name: string) {
    return this.call<GuestSession>('post', '/api/guests', { name });
  }
  me() {
    return this.call<{ id: string; name: string }>('get', '/api/me');
  }
  rename(name: string) {
    return this.call<{ id: string; name: string }>('patch', '/api/me', { name });
  }

  heroes() {
    return this.call<HeroInfo[]>('get', '/api/heroes');
  }
  maps() {
    return this.call<MapSummary[]>('get', '/api/maps');
  }
  map(id: string) {
    return this.call<MapData>('get', `/api/maps/${enc(id)}`);
  }

  createRoom(mapId?: string) {
    return this.call<RoomView>('post', '/api/rooms', mapId ? { mapId } : {});
  }
  room(code: string) {
    return this.call<RoomView>('get', `/api/rooms/${enc(code)}`);
  }
  join(code: string) {
    return this.call<RoomView>('post', `/api/rooms/${enc(code)}/join`, {});
  }
  addBot(code: string, hero?: string) {
    return this.call<RoomView>('post', `/api/rooms/${enc(code)}/bots`, hero ? { hero } : {});
  }
  kick(code: string, playerId: string) {
    return this.call<RoomView>('delete', `/api/rooms/${enc(code)}/players/${enc(playerId)}`);
  }
  loadout(code: string, body: { color?: Color; hero?: string; skin?: string }) {
    return this.call<RoomView>('post', `/api/rooms/${enc(code)}/loadout`, body);
  }
  setMap(code: string, mapId: string) {
    return this.call<RoomView>('post', `/api/rooms/${enc(code)}/map`, { mapId });
  }
  start(code: string) {
    return this.call<RoomView>('post', `/api/rooms/${enc(code)}/start`, {});
  }
  rematch(code: string) {
    return this.call<RoomView>('post', `/api/rooms/${enc(code)}/rematch`, {});
  }
  leave(code: string) {
    return this.call<void>('post', `/api/rooms/${enc(code)}/leave`, {});
  }

  private async call<T>(method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: unknown): Promise<T> {
    const headers = this.token ? new HttpHeaders({ Authorization: `Bearer ${this.token}` }) : undefined;
    try {
      return await firstValueFrom(this.http.request<T>(method, url, { body, headers }));
    } catch (e) {
      throw new ApiError(errorMessage(e), e instanceof HttpErrorResponse ? e.status : 0);
    }
  }
}

const enc = encodeURIComponent;

function errorMessage(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return "Can't reach the server. Is it running?";
    const err = e.error?.error ?? e.error?.detail;
    if (typeof err === 'string') return err;
    return `Something went wrong (${e.status}).`;
  }
  return 'Something went wrong.';
}
