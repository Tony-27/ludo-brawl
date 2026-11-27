import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SoundService } from './audio/sound.service';
import { ToastService } from './core/toast.service';

@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected toast = inject(ToastService);
  protected sound = inject(SoundService);
}
