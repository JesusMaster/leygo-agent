import { Injectable, signal } from '@angular/core';

export interface Toast { id: number; text: string; kind: 'ok' | 'error' | 'info'; }

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;

  private push(text: string, kind: Toast['kind']) {
    const id = ++this.seq;
    this.toasts.update((t) => [...t, { id, text, kind }]);
    setTimeout(() => this.dismiss(id), 5000);
  }

  ok(text: string) { this.push(text, 'ok'); }
  error(text: string) { this.push(text, 'error'); }
  info(text: string) { this.push(text, 'info'); }

  dismiss(id: number) { this.toasts.update((t) => t.filter((x) => x.id !== id)); }
}
