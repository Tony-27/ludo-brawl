import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Color, RoomView, Session, SessionResponse } from './models';

/** Thin wrapper around the REST API. Every call resolves or throws an Error with a friendly message. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  createRoom(name: string) {
    return this.call<SessionResponse>('post', '/api/rooms', { name }).then(withCode);
  }

  joinRoom(code: string, name: string) {
    return this.call<SessionResponse>('post', `/api/rooms/${enc(code)}/join`, { name }).then(withCode);
  }

  getRoom(code: string) {
    return this.call<RoomView>('get', `/api/rooms/${enc(code)}`);
  }

  addBot(s: Session) {
    return this.call<RoomView>('post', `/api/rooms/${enc(s.code)}/bots`, {}, s);
  }

  kick(s: Session, playerId: string) {
    return this.call<RoomView>('delete', `/api/rooms/${enc(s.code)}/players/${enc(playerId)}`, undefined, s);
  }

  setColor(s: Session, color: Color) {
    return this.call<RoomView>('post', `/api/rooms/${enc(s.code)}/color`, { color }, s);
  }

  start(s: Session) {
    return this.call<RoomView>('post', `/api/rooms/${enc(s.code)}/start`, {}, s);
  }

  roll(s: Session) {
    return this.call<RoomView>('post', `/api/rooms/${enc(s.code)}/roll`, {}, s);
  }

  move(s: Session, piece: number) {
    return this.call<RoomView>('post', `/api/rooms/${enc(s.code)}/move`, { piece }, s);
  }

  rematch(s: Session) {
    return this.call<RoomView>('post', `/api/rooms/${enc(s.code)}/rematch`, {}, s);
  }

  leave(s: Session) {
    return this.call<void>('post', `/api/rooms/${enc(s.code)}/leave`, {}, s);
  }

  private async call<T>(method: 'get' | 'post' | 'delete', url: string, body?: unknown, s?: Session): Promise<T> {
    const headers = s ? new HttpHeaders({ 'X-Player-Token': s.token }) : undefined;
    try {
      return await firstValueFrom(this.http.request<T>(method, url, { body, headers }));
    } catch (e) {
      throw new ApiError(errorMessage(e), e instanceof HttpErrorResponse ? e.status : 0);
    }
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const enc = encodeURIComponent;

function withCode(r: SessionResponse): SessionResponse {
  return { ...r, code: r.room.code };
}

function errorMessage(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return "Can't reach the server. Is it running?";
    const err = e.error?.error ?? e.error?.detail;
    if (typeof err === 'string') return err;
    if (Array.isArray(err)) return 'Please check what you entered.';
    return `Something went wrong (${e.status}).`;
  }
  return 'Something went wrong.';
}
