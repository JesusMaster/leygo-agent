import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { AuthService } from '../../services/auth.service';

/** Conexión de la GUI con el backend. Todo vive en localStorage de este navegador. */
@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Ajustes</h2>
          <p class="sub">Dónde está el backend y cómo se administra. La sesión vive en este navegador.</p>
        </div>
      </div>

      <div class="card">
        <h3>Sesión</h3>
        @if (auth.logueado()) {
          <p class="card-sub">Conectado como <strong>{{ auth.usuario() }}</strong>. Con la sesión, la GUI no necesita la clave de administración.</p>
          <button class="btn-secondary" (click)="auth.logout()"><i class="ph ph-sign-out"></i> Cerrar sesión</button>
        } @else {
          <p class="card-sub">Sin sesión. <a routerLink="/login">Inicia sesión</a> para administrar el agente.</p>
        }
      </div>

      <div class="card">
        <h3>Clave de administración (API directo)</h3>
        <p class="card-sub">
          Para llamar al API sin pasar por la GUI: cabecera <code>X-Admin-Key: &lt;clave&gt;</code> (o <code>Authorization: Bearer &lt;clave&gt;</code>).
          Es la <code>ADMIN_API_KEY</code> del <code>.env</code>; la GUI no la guarda, la pide al backend con tu sesión.
        </p>
        @if (adminKeyRemota() === undefined) {
          <div class="empty">Inicia sesión para verla.</div>
        } @else if (adminKeyRemota() === null) {
          <span class="badge warn">el backend no tiene ADMIN_API_KEY definida</span>
        } @else {
          <div class="row" style="flex-wrap:wrap">
            <code class="clave" [class.oculta]="!mostrar()">{{ mostrar() ? adminKeyRemota() : '•'.repeat(24) + adminKeyRemota()!.slice(-4) }}</code>
            <button class="btn-secondary" (click)="mostrar.set(!mostrar())"><i class="ph" [class.ph-eye]="!mostrar()" [class.ph-eye-slash]="mostrar()"></i> {{ mostrar() ? 'Ocultar' : 'Mostrar' }}</button>
            <button class="btn-secondary" (click)="copiar()"><i class="ph ph-copy"></i> Copiar</button>
          </div>
          <pre class="ejemplo">curl -H "X-Admin-Key: {{ mostrar() ? adminKeyRemota() : '…' }}" {{ url }}/api/usage</pre>
        }
      </div>

      <div class="card">
        <h3>Conexión</h3>
        <p class="card-sub">Por defecto apunta al mismo host en el puerto 4000.</p>
        <label class="field">
          <span>URL del backend</span>
          <input type="text" [(ngModel)]="url" placeholder="http://localhost:4000" />
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
                @if (info()!.protegido) { <span class="badge ok">protegidos: sesión o clave</span> }
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
  styles: [`
    .clave { padding: 10px 12px; background: var(--bg-input); border: 1px solid var(--border-light); border-radius: 8px; font-size: 13px; word-break: break-all; flex: 1 1 320px; }
    .ejemplo { margin-top: 12px; padding: 10px 12px; background: var(--bg-input); border-radius: 8px; font-size: 12px; overflow: auto; color: var(--text-dim); }
  `],
})
export class SettingsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  auth = inject(AuthService);

  url = this.api.baseUrl;
  estado = signal<'ok' | 'error' | null>(null);
  info = signal<{ agente: string; protegido: boolean } | null>(null);
  /** undefined = sin sesión / no consultada; null = el backend no tiene clave */
  adminKeyRemota = signal<string | null | undefined>(undefined);
  mostrar = signal(false);

  constructor() { this.probar(); this.cargarClave(); }

  private cargarClave() {
    if (!this.auth.logueado() && !localStorage.getItem('yisus_admin_key')) return;
    this.api.getAdminKey().subscribe({ next: (r) => this.adminKeyRemota.set(r.key), error: () => this.adminKeyRemota.set(undefined) });
  }

  copiar() {
    const k = this.adminKeyRemota();
    if (!k) return;
    navigator.clipboard.writeText(k).then(() => this.toast.ok('Clave copiada'), () => this.toast.error('No se pudo copiar'));
  }

  guardar() {
    this.api.setBaseUrl(this.url);
    this.toast.ok('Ajustes guardados');
    this.probar();
    this.cargarClave();
  }

  probar() {
    this.api.getStatus().subscribe({
      next: (r) => { this.estado.set('ok'); this.info.set({ agente: r.agente, protegido: r.protegido }); },
      error: () => { this.estado.set('error'); this.info.set(null); },
    });
  }
}
