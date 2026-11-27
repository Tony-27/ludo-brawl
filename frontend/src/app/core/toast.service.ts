import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;

  error(text: string) {
    this.push(text, 'error');
  }

  info(text: string) {
    this.push(text, 'info');
  }

  dismiss(id: number) {
    this.toasts.update((ts) => ts.filter((t) => t.id !== id));
  }

  private push(text: string, kind: Toast['kind']) {
    const id = ++this.seq;
    this.toasts.update((ts) => [...ts.slice(-2), { id, text, kind }]);
    setTimeout(() => this.dismiss(id), 4000);
  }
}
