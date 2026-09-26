import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, LlmSettings } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { AuthService } from '../../services/auth.service';
import { LlmProvidersComponent } from './llm-providers';
import { AgentModelsComponent } from './agent-models';
import { EnvVarsComponent } from './env-vars';

type Tab = 'llm' | 'agentes' | 'env' | 'conexion';
const TAB_KEY = 'yisus_settings_tab';

/**
 * Ajustes: proveedores de LLM, modelo por agente, claves del .env y conexión
 * de la GUI. Al estilo de Leygo: pestañas arriba, tarjetas abajo.
 */
@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink, LlmProvidersComponent, AgentModelsComponent, EnvVarsComponent],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Ajustes</h2>
          <p class="sub">Modelos, claves y conexión del agente. Los proveedores y el .env se guardan en el backend; la sesión vive en este navegador.</p>
        </div>
      </div>

      <div class="tabs">
        <button class="tab" [class.on]="tab() === 'llm'" (click)="ir('llm')"><i class="ph ph-cpu"></i> Proveedores LLM</button>
        <button class="tab" [class.on]="tab() === 'agentes'" (click)="ir('agentes')"><i class="ph ph-robot"></i> Modelos por agente</button>
        <button class="tab" [class.on]="tab() === 'env'" (click)="ir('env')"><i class="ph ph-key"></i> Claves y variables</button>
        <button class="tab" [class.on]="tab() === 'conexion'" (click)="ir('conexion')"><i class="ph ph-plugs"></i> Conexión</button>
      </div>

      @if (tab() === 'llm' || tab() === 'agentes') {
        @if (!auth.logueado()) {
          <div class="card"><div class="empty">Inicia sesión para administrar los modelos.</div></div>
        } @else if (llm(); as l) {
          @if (tab() === 'llm') {
            <app-llm-providers [providers]="l.providers" [presets]="l.presets" [usosPorProveedor]="usos()" (cambio)="cargarLlm()" />
          } @else {
            <app-agent-models [providers]="l.providers" [agentes]="l.agentes" (cambio)="cargarLlm()" />
          }
        } @else if (errorLlm()) {
          <div class="card"><div class="empty">{{ errorLlm() }}</div></div>
        } @else {
          <div class="card"><div class="empty">Cargando…</div></div>
        }
      }

      @if (tab() === 'env') {
        @if (auth.logueado()) { <app-env-vars /> }
        @else { <div class="card"><div class="empty">Inicia sesión para ver las variables.</div></div> }
      }

      @if (tab() === 'conexion') {
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
        <p class="card-sub">Vacío = automático: el mismo dominio en producción, o el puerto 4000 en desarrollo (localhost).</p>
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
          Los cambios de herramientas en Telegram, Buzz, API y A2A se guardan en <code>config/channels.json</code>
          y se aplican de inmediato a los agentes en ejecución, sin reiniciar. Lo mismo vale para el alcance
          o la revocación de un token A2A.
        </p>
      </div>
      }
    </div>
  `,
  styles: [`
    .tabs { display: flex; gap: 6px; margin-bottom: 20px; border-bottom: 1px solid var(--border-light); overflow-x: auto; }
    .tab { display: inline-flex; align-items: center; gap: 8px; padding: 10px 14px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--text-dim); font-size: 14px; cursor: pointer; white-space: nowrap; margin-bottom: -1px; }
    .tab i { font-size: 17px; }
    .tab:hover { color: var(--text-main); }
    .tab.on { color: var(--accent-primary); border-bottom-color: var(--accent-primary); }
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

  tab = signal<Tab>(((localStorage.getItem(TAB_KEY) as Tab) || 'llm'));
  llm = signal<LlmSettings | null>(null);
  errorLlm = signal<string | null>(null);
  usos = computed(() => {
    const out: Record<string, number> = {};
    for (const a of this.llm()?.agentes || []) if (a.assignment) out[a.assignment.provider] = (out[a.assignment.provider] || 0) + 1;
    return out;
  });

  constructor() { this.probar(); this.cargarClave(); if (this.auth.logueado()) this.cargarLlm(); }

  ir(t: Tab) { this.tab.set(t); try { localStorage.setItem(TAB_KEY, t); } catch {} }

  cargarLlm() {
    this.api.getLlmSettings().subscribe({
      next: (r) => { this.llm.set(r); this.errorLlm.set(null); },
      error: (e) => this.errorLlm.set(e?.error?.error || 'No se pudo cargar la configuración de modelos (¿backend actualizado?)'),
    });
  }

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
