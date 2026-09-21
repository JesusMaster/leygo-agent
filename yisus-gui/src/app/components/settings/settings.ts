import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

/** Conexión de la GUI con el backend. Todo vive en localStorage de este navegador. */
@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Ajustes</h2>
          <p class="sub">Dónde está el backend y con qué clave se administra. Nada de esto sale de este navegador.</p>
        </div>
      </div>

      <div class="card">
        <h3>Conexión</h3>
        <p class="card-sub">Por defecto apunta al mismo host en el puerto 4000.</p>
        <label class="field">
          <span>URL del backend</span>
          <input type="text" [(ngModel)]="url" placeholder="http://localhost:4000" />
        </label>
        <label class="field">
          <span>Clave de administración (X-Admin-Key)</span>
          <input type="password" [(ngModel)]="adminKey" placeholder="la misma de ADMIN_API_KEY en el .env" />
        </label>
        <div class="row">
          <button class="btn-primary" (click)="guardar()">Guardar</button>
          <button class="btn-secondary" (click)="probar()">Probar conexión</button>
          <span class="spacer"></span>
          @if (estado() === 'ok') { <span class="badge ok">conectado</span> }
          @if (estado() === 'error') { <span class="badge danger">sin conexión</span> }
        </div>
      </div>

      <div class="card">
        <h3>Estado del backend</h3>
        @if (info()) {
          <table>
            <tr><td>Agente</td><td><strong>{{ info()!.agente }}</strong></td></tr>
            <tr>
              <td>Endpoints de administración</td>
              <td>
                @if (info()!.protegido) { <span class="badge ok">protegidos con clave</span> }
                @else { <span class="badge warn">sin autenticación — define ADMIN_API_KEY antes de exponer el puerto</span> }
              </td>
            </tr>
          </table>
        } @else {
          <div class="empty">Sin datos. Prueba la conexión.</div>
        }
      </div>

      <div class="card">
        <h3>Sobre los canales</h3>
        <p class="card-sub" style="margin-bottom:0">
          Los cambios de herramientas en Telegram, Buzz y API se guardan en <code>config/channels.json</code>,
          pero esos agentes se construyen al arrancar: aplican al reiniciar el servicio.
          Los tokens de A2A son la excepción — su agente se arma por token, así que un cambio de alcance
          o una revocación surten efecto de inmediato.
        </p>
      </div>
    </div>
  `,
})
export class SettingsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  url = this.api.baseUrl;
  adminKey = localStorage.getItem('yisus_admin_key') || '';
  estado = signal<'ok' | 'error' | null>(null);
  info = signal<{ agente: string; protegido: boolean } | null>(null);

  constructor() { this.probar(); }

  guardar() {
    this.api.setBaseUrl(this.url);
    if (this.adminKey.trim()) localStorage.setItem('yisus_admin_key', this.adminKey.trim());
    else localStorage.removeItem('yisus_admin_key');
    this.toast.ok('Ajustes guardados');
    this.probar();
  }

  probar() {
    this.api.getStatus().subscribe({
      next: (r) => { this.estado.set('ok'); this.info.set({ agente: r.agente, protegido: r.protegido }); },
      error: () => { this.estado.set('error'); this.info.set(null); },
    });
  }
}
