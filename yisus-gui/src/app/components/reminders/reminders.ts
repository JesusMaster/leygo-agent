import { Component, inject, signal } from '@angular/core';
import { ApiService, Reminder } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';

@Component({
  selector: 'app-reminders',
  imports: [FriendlyDatePipe],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Recordatorios</h2>
          <p class="sub">Los que agendaste por conversación. Sobreviven a un reinicio: se recuperan desde SQLite al arrancar.</p>
        </div>
        <button class="btn-secondary" (click)="load()"><i class="ph ph-arrows-clockwise"></i> Actualizar</button>
      </div>

      <div class="card">
        @if (items().length === 0) {
          <div class="empty">Sin recordatorios pendientes.</div>
        } @else {
          <table>
            <tr><th>Cuándo</th><th>Mensaje</th><th>Creado</th></tr>
            @for (r of items(); track r.id) {
              <tr>
                <td style="white-space:nowrap"><strong>{{ fecha(r.target_time) }}</strong><br><span style="font-size:12px;color:var(--text-dim)">{{ restante(r.target_time) }}</span></td>
                <td>{{ r.message }}</td>
                <td style="color:var(--text-dim)">{{ r.created_at | friendlyDate }}</td>
              </tr>
            }
          </table>
        }
      </div>
    </div>
  `,
})
export class RemindersComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  items = signal<Reminder[]>([]);

  constructor() { this.load(); }

  load() {
    this.api.getReminders().subscribe({
      next: (r) => this.items.set(r.reminders || []),
      error: () => this.toast.error('No se pudieron cargar los recordatorios'),
    });
  }

  fecha(ms: number) {
    return new Date(ms).toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  restante(ms: number) {
    const min = Math.round((ms - Date.now()) / 60000);
    if (min < 0) return 'vencido';
    if (min < 60) return `en ${min} min`;
    if (min < 1440) return `en ${Math.round(min / 60)} h`;
    return `en ${Math.round(min / 1440)} días`;
  }
}
