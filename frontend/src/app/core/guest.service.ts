import { Injectable, inject, signal } from '@angular/core';
import { ApiError, ApiService } from './api.service';
import type { GuestSession } from './protocol';

const KEY = 'ludo-brawl:guest';

/**
 * The player's identity. Today a guest (name + token kept in localStorage);
 * later the same record upgrades to a real account.
 */
@Injectable({ providedIn: 'root' })
export class GuestService {
  private api = inject(ApiService);
  readonly guest = signal<GuestSession | null>(this.load());

  constructor() {
    this.api.token = this.guest()?.token ?? null;
  }

  get name(): string {
    return this.guest()?.name ?? '';
  }

  /** Make sure we have a valid guest with this name (creating or renaming as needed). */
  async ensure(name: string): Promise<GuestSession> {
    name = name.trim();
    let g = this.guest();
    if (g) {
      try {
        if (g.name !== name) await this.api.rename(name);
        else await this.api.me();
        g = { ...g, name };
        this.store(g);
        return g;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) throw e;
        // Unknown token (e.g. database reset): fall through and create a new guest.
      }
    }
    g = await this.api.createGuest(name);
    this.store(g);
    return g;
  }

  private store(g: GuestSession) {
    localStorage.setItem(KEY, JSON.stringify(g));
    this.api.token = g.token;
    this.guest.set(g);
  }

  private load(): GuestSession | null {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      return null;
    }
  }
}
