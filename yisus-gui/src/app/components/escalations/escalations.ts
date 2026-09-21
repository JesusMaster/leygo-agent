import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Escalation } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';

/** Lo que el triage capturó y espera tu decisión. */
@Component({
  selector: 'app-escalations',
  imports: [FormsModule, FriendlyDatePipe],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Escalamientos</h2>
          <p class="sub">
            Temas que el clon no responde por diseño — sueldos, contrataciones, compromisos legales, credenciales —
            capturados con su contexto para que decidas tú.
          </p>
        </div>
        <div class="row">
          <select [(ngModel)]="estado" (change)="load()" style="width:auto">
            <option value="pendiente">Pendientes</option>
            <option value="resuelto">Resueltos</option>
            <option value="descartado">Descartados</option>
          </select>
          <button class="btn-secondary" (click)="load()"><i class="ph ph-arrows-clockwise"></i></button>
        </div>
      </div>

      @if (items().length === 0) {
        <div class="card"><div class="empty">Nada {{ estado === 'pendiente' ? 'pendiente de tu decisión' : 'en este estado' }}.</div></div>
      } @else {
        @for (e of items(); track e.id) {
          <div class="card">
            <div class="row" style="margin-bottom:10px">
              <span class="badge" [class.danger]="e.urgency === 'alta'" [class.warn]="e.urgency === 'media'" [class.ok]="e.urgency === 'baja'">{{ e.urgency }}</span>
              <strong>{{ e.topic }}</strong>
              <span class="badge dim">{{ e.channel }}</span>
              <span class="spacer"></span>
              <code style="color:var(--text-dim)">{{ e.id }}</code>
              <span style="color:var(--text-dim);font-size:12.5px">{{ e.created_at | friendlyDate }}</span>
            </div>

            <p style="font-size:14px;margin-bottom:12px;white-space:pre-wrap">{{ e.summary }}</p>
            <p style="font-size:13px;color:var(--text-dim)">Lo pidió: {{ e.requester }}</p>

            @if (e.status === 'pendiente') {
              <div style="margin-top:14px">
                <label class="field">
                  <span>Tu decisión (queda registrada como antecedente)</span>
                  <textarea rows="2" [(ngModel)]="decision[e.id]" placeholder="Qué resolviste y por qué"></textarea>
                </label>
                <div class="row">
                  <span class="spacer"></span>
                  <button class="btn-secondary" (click)="resolver(e, 'descartado')">Descartar</button>
                  <button class="btn-primary" (click)="resolver(e, 'resuelto')">Marcar resuelto</button>
                </div>
              </div>
            } @else if (e.resolution) {
              <div style="margin-top:12px;padding:12px;background:var(--bg-main);border-radius:8px">
                <span style="font-size:12px;color:var(--text-dim)">Resolución · {{ e.resolved_at | friendlyDate }}</span>
                <p style="font-size:14px;margin-top:4px">{{ e.resolution }}</p>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
})
export class EscalationsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  items = signal<Escalation[]>([]);
  estado = 'pendiente';
  decision: Record<string, string> = {};

  constructor() { this.load(); }

  load() {
    this.api.getEscalations(this.estado).subscribe({
      next: (r) => this.items.set(r.escalations || []),
      error: () => this.toast.error('No se pudieron cargar los escalamientos'),
    });
  }

  resolver(e: Escalation, status: 'resuelto' | 'descartado') {
    const texto = this.decision[e.id] || '';
    if (status === 'resuelto' && !texto.trim()) {
      this.toast.error('Escribe qué decidiste: sin eso el registro no sirve de antecedente');
      return;
    }
    this.api.resolveEscalation(e.id, texto, status).subscribe({
      next: () => { this.toast.ok(`Escalamiento ${e.id} ${status}`); this.load(); },
      error: () => this.toast.error('No se pudo registrar la resolución'),
    });
  }
}
