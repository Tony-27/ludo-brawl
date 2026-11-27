import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { RoomStore } from '../core/room-store.service';
import { GameView } from '../game/game-view';
import { LobbyView } from './lobby';

@Component({
  selector: 'app-room',
  imports: [LobbyView, GameView],
  template: `
    @if (store.room(); as room) {
      @if (room.state === 'lobby') {
        <app-lobby />
      } @else {
        <app-game />
      }
    } @else {
      <div class="loading">
        <div class="spinner"></div>
        <p>Connecting to room…</p>
      </div>
    }
  `,
  styles: `
    .loading {
      min-height: 100dvh;
      display: grid;
      place-content: center;
      justify-items: center;
      gap: 16px;
      color: var(--muted);
    }
    .spinner {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      border: 4px solid var(--line);
      border-top-color: var(--yellow);
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `,
})
export class RoomPage implements OnInit, OnDestroy {
  protected store = inject(RoomStore);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  ngOnInit() {
    const code = (this.route.snapshot.paramMap.get('code') ?? '').toUpperCase();
    if (!this.store.resume(code)) {
      // Opened a shared link without being in the room yet: offer to join.
      this.router.navigate(['/'], { queryParams: { join: code } });
    }
  }

  ngOnDestroy() {
    // Navigating away keeps the seat; the session can be resumed from the link.
    if (this.store.session()) this.store.detach();
  }
}
