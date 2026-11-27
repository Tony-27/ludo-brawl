import { Component, computed, inject, signal } from '@angular/core';
import { COLOR_LABEL, Color, PlayerView } from '../core/models';
import { RoomStore } from '../core/room-store.service';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'app-lobby',
  templateUrl: './lobby.html',
  styleUrl: './lobby.scss',
})
export class LobbyView {
  protected store = inject(RoomStore);
  private toast = inject(ToastService);
  protected readonly label = COLOR_LABEL;
  protected copied = signal(false);

  protected room = computed(() => this.store.room()!);
  protected seats = computed(() => {
    const room = this.room();
    return room.colors.map((color) => ({
      color,
      player: room.players.find((p) => p.color === color) ?? null,
    }));
  });
  protected canStart = computed(() => this.store.isHost() && this.room().players.length >= 2);
  protected full = computed(() => this.room().players.length >= 4);
  protected link = computed(() => `${location.origin}/room/${this.room().code}`);

  protected async copy() {
    const text = this.link();
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: 'Join my Ludo Brawl game', text: `Room code: ${this.room().code}`, url: text });
        return;
      }
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1800);
    } catch {
      this.toast.info(`Share this code: ${this.room().code}`);
    }
  }

  protected seatClick(color: Color, player: PlayerView | null) {
    if (!player) this.store.setColor(color);
  }
}
