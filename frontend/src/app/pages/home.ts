import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { AutofocusDirective } from '../core/autofocus.directive';
import { RoomStore } from '../core/room-store.service';

type Mode = 'choose' | 'create' | 'join';

@Component({
  selector: 'app-home',
  imports: [FormsModule, AutofocusDirective],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomePage implements OnInit {
  protected store = inject(RoomStore);
  private route = inject(ActivatedRoute);

  protected mode = signal<Mode>('choose');
  protected name = this.store.savedName;
  protected code = '';

  ngOnInit() {
    const code = this.route.snapshot.queryParamMap.get('join');
    if (code) {
      this.code = code.toUpperCase();
      this.mode.set('join');
    }
  }

  protected pick(mode: Mode) {
    this.mode.set(mode);
  }

  protected onCodeInput(value: string) {
    this.code = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  }

  protected get nameOk() {
    return this.name.trim().length > 0 && this.name.trim().length <= 20;
  }

  protected get codeOk() {
    return this.code.length === 5;
  }

  protected submit() {
    if (!this.nameOk || this.store.busy()) return;
    if (this.mode() === 'create') {
      this.store.create(this.name.trim());
    } else if (this.mode() === 'join' && this.codeOk) {
      this.store.join(this.code, this.name.trim());
    }
  }
}
