import { Component, computed, inject, signal } from '@angular/core';
import { COLOR_LABEL, HeroInfo } from '../core/catalog';
import type { Color, PlayerView } from '../core/protocol';
import { RoomStore } from '../core/room-store.service';
import { ToastService } from '../core/toast.service';
import { TEAM_CSS } from '../engine/assets/catalog';

const COLORS: Color[] = ['red', 'green', 'yellow', 'blue'];

@Component({
  selector: 'app-lobby',
  templateUrl: './lobby.html',
  styleUrl: './lobby.scss',
})
export class LobbyView {
  protected store = inject(RoomStore);
  private toast = inject(ToastService);
  protected readonly label = COLOR_LABEL;
  protected readonly teamCss = TEAM_CSS;
  protected copied = signal(false);

  protected room = computed(() => this.store.room()!);
  protected me = computed(() => this.store.me());
  protected seats = computed(() =>
    COLORS.map((color) => ({ color, player: this.room().players.find((p) => p.color === color) ?? null })),
  );
  protected selectable = computed(() => this.store.heroes().filter((h) => h.selectable));
  protected upcoming = computed(() => this.store.heroes().filter((h) => !h.selectable));
  protected myHero = computed(() => this.store.hero(this.me()?.hero));
  protected currentMap = computed(() => this.store.maps().find((m) => m.id === this.room().mapId));
  protected canStart = computed(() => this.store.isHost() && this.room().players.length >= 2);
  protected full = computed(() => this.room().players.length >= 4);
  protected link = computed(() => `${location.origin}/room/${this.room().code}`);

  protected heroName(p: PlayerView) {
    return this.store.hero(p.hero)?.name ?? p.hero;
  }

  protected skinName(p: PlayerView) {
    return this.store.hero(p.hero)?.skins.find((s) => s.id === p.skin)?.name ?? '';
  }

  protected pickHero(h: HeroInfo) {
    if (h.selectable && h.id !== this.me()?.hero) this.store.loadout({ hero: h.id });
  }

  protected pickSkin(id: string) {
    if (id !== this.me()?.skin) this.store.loadout({ skin: id });
  }

  protected takeSeat(color: Color) {
    this.store.loadout({ color });
  }

  protected async copy() {
    try {
      await navigator.clipboard.writeText(this.link());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1800);
    } catch {
      this.toast.info(`Share this code: ${this.room().code}`);
    }
  }
}
