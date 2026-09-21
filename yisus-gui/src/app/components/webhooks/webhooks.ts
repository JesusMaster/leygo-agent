import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, CustomWebhook } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-webhooks',
  imports: [FormsModule],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Webhooks con IA</h2>
          <p class="sub">
            Endpoints que reciben un payload cualquiera y te lo resumen a Telegram siguiendo las instrucciones que le des.
          </p>
        </div>
        <button class="btn-primary" (click)="creando.set(!creando())"><i class="ph ph-plus"></i> Nuevo webhook</button>
      </div>

      @if (creando()) {
        <div class="card">
          <h3>Nuevo webhook</h3>
          <label class="field">
            <span>Título</span>
            <input type="text" [(ngModel)]="titulo" placeholder="ej: Alertas de despliegue" />
          </label>
          <label class="field">
            <span>Instrucciones para la IA</span>
            <textarea rows="4" [(ngModel)]="instrucciones" placeholder="Qué debe hacer con el payload que llegue: qué resaltar, qué ignorar, cómo avisarte"></textarea>
          </label>
          <label class="field">
            <span>Modelo</span>
            <input type="text" [(ngModel)]="modelo" placeholder="gemini-2.5-flash" />
          </label>
          <div class="row">
            <span class="spacer"></span>
            <button class="btn-secondary" (click)="creando.set(false)">Cancelar</button>
            <button class="btn-primary" [disabled]="!titulo.trim()" (click)="crear()">Crear</button>
          </div>
        </div>
      }

      <div class="card">
        @if (items().length === 0) {
          <div class="empty">Sin webhooks creados.</div>
        } @else {
          <table>
            <tr><th>Título</th><th>URL</th><th>Modelo</th><th>Estado</th><th></th></tr>
            @for (w of items(); track w.id) {
              <tr>
                <td><strong>{{ w.title }}</strong><br><span style="font-size:12.5px;color:var(--text-dim)">{{ w.instructions }}</span></td>
                <td><code style="word-break:break-all">{{ url(w) }}</code></td>
                <td style="color:var(--text-dim)">{{ w.model }}</td>
                <td>
                  @if (activo(w)) { <span class="badge ok">activo</span> } @else { <span class="badge dim">pausado</span> }
                </td>
                <td>
                  <div class="row">
                    <button class="btn-icon" title="Copiar URL" (click)="copiar(url(w))"><i class="ph ph-copy"></i></button>
                    <button class="btn-icon" title="Pausar / reanudar" (click)="alternar(w)"><i class="ph ph-pause"></i></button>
                    <button class="btn-icon" title="Eliminar" (click)="eliminar(w)"><i class="ph ph-trash"></i></button>
                  </div>
                </td>
              </tr>
            }
          </table>
        }
      </div>
    </div>
  `,
})
export class WebhooksComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  items = signal<CustomWebhook[]>([]);
  creando = signal(false);
  titulo = '';
  instrucciones = '';
  modelo = 'gemini-2.5-flash';

  constructor() { this.load(); }

  load() {
    this.api.getWebhooks().subscribe({
      next: (r: any) => this.items.set(r?.webhooks || r || []),
      error: () => this.toast.error('No se pudieron cargar los webhooks'),
    });
  }

  url(w: CustomWebhook) { return w.url || `${this.api.baseUrl}/api/webhook/${w.id}`; }
  activo(w: CustomWebhook) { return w.enabled ?? w.active ?? true; }

  crear() {
    this.api.createWebhook({ title: this.titulo.trim(), instructions: this.instrucciones.trim(), model: this.modelo.trim() }).subscribe({
      next: () => { this.creando.set(false); this.titulo = ''; this.instrucciones = ''; this.load(); this.toast.ok('Webhook creado'); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo crear'),
    });
  }

  alternar(w: CustomWebhook) {
    this.api.toggleWebhook(w.id).subscribe({
      next: () => { this.load(); this.toast.ok('Estado actualizado'); },
      error: () => this.toast.error('No se pudo cambiar el estado'),
    });
  }

  eliminar(w: CustomWebhook) {
    if (!confirm(`¿Eliminar "${w.title}"?`)) return;
    this.api.deleteWebhook(w.id).subscribe({
      next: () => { this.load(); this.toast.ok('Webhook eliminado'); },
      error: () => this.toast.error('No se pudo eliminar'),
    });
  }

  copiar(v: string) {
    navigator.clipboard.writeText(v).then(() => this.toast.ok('URL copiada'), () => this.toast.error('No se pudo copiar'));
  }
}
