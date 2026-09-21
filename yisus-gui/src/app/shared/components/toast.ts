import { Component, inject } from '@angular/core';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-toast',
  template: `
    <div class="toast-stack">
      @for (t of toastService.toasts(); track t.id) {
        <div class="toast" [class.ok]="t.kind === 'ok'" [class.error]="t.kind === 'error'" (click)="toastService.dismiss(t.id)">
          <i class="ph" [class.ph-check-circle]="t.kind === 'ok'" [class.ph-warning-circle]="t.kind === 'error'" [class.ph-info]="t.kind === 'info'"></i>
          <span>{{ t.text }}</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .toast-stack { position: fixed; bottom: 24px; right: 24px; display: flex; flex-direction: column; gap: 10px; z-index: 1000; }
    .toast {
      display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 10px;
      background: var(--bg-card); border: 1px solid var(--border-light); color: var(--text-main);
      font-size: 14px; box-shadow: 0 8px 20px rgba(0,0,0,.12); cursor: pointer; max-width: 380px;
    }
    .toast.ok { border-color: rgba(16,185,129,.4); }
    .toast.error { border-color: rgba(239,68,68,.4); }
    .toast i { font-size: 18px; }
    .toast.ok i { color: var(--ok); }
    .toast.error i { color: var(--danger); }
  `],
})
export class ToastComponent {
  toastService = inject(ToastService);
}
