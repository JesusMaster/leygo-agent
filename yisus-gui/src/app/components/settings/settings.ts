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

interface Estado {
  ok: boolean; status?: 'ok' | 'degradado'; agente?: string; protegido?: boolean;
  servicios?: Record<string, string>; ms?: number; revisado: number;
}

const NOMBRE_SERVICIO: Record<string, { titulo: string; icono: string; para: string }> = {
  redis: { titulo: 'Redis', icono: 'ph-lightning', para: 'sesiones del chat' },
  mongo: { titulo: 'MongoDB', icono: 'ph-database', para: 'datos de micro-generate' },
};

/**
 * Ajustes: proveedores de LLM, modelo por agente, claves del .env y conexión
 * de la GUI. Pestañas arriba, tarjetas abajo.
 */
@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink, LlmProvidersComponent, AgentModelsComponent, EnvVarsComponent],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Ajustes</h2>
          <p class="sub">Modelos, claves y conexión del agente.</p>
        </div>
      </div>

      <div class="tabs">
        <button class="tab" [class.on]="tab() === 'llm'" (click)="ir('llm')">
          <i class="ph ph-cpu"></i> Proveedores
          @if (llm(); as l) { <span class="cnt">{{ activos() }}</span> }
        </button>
        <button class="tab" [class.on]="tab() === 'agentes'" (click)="ir('agentes')">
          <i class="ph ph-robot"></i> <span class="largo">Modelo por agente</span><span class="corto">Por agente</span>
          @if (llm(); as l) { <span class="cnt" [title]="personalizados() + ' con modelo propio'">{{ personalizados() }}/{{ l.agentes.length }}</span> }
        </button>
        <button class="tab" [class.on]="tab() === 'env'" (click)="ir('env')"><i class="ph ph-key"></i> <span class="largo">Claves y variables</span><span class="corto">Claves</span></button>
        <button class="tab" [class.on]="tab() === 'conexion'" (click)="ir('conexion')">
          <i class="ph ph-plugs"></i> Conexión
          @if (estado(); as e) { <span class="dot" [class.ok]="e.ok && e.status !== 'degradado'" [class.warn]="e.ok && e.status === 'degradado'" [class.bad]="!e.ok"></span> }
        </button>
      </div>

      @if (tab() === 'llm' || tab() === 'agentes') {
        @if (!auth.logueado()) {
          <div class="card"><div class="empty">Inicia sesión para administrar los modelos.</div></div>
        } @else if (llm(); as l) {
          @if (tab() === 'llm') {
            <app-llm-providers [providers]="l.providers" [presets]="l.presets" [usosPorProveedor]="usos()" [porDefecto]="l.agentes.length - personalizados()" (cambio)="cargarLlm()" />
          } @else {
            <app-agent-models [providers]="l.providers" [agentes]="l.agentes" (cambio)="cargarLlm()" (irProveedores)="ir('llm')" />
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
        <!-- Estado -->
        <div class="card">
          <div class="card-top">
            <div>
              <h3>Estado</h3>
              <p class="card-sub">
                {{ estado() ? resumenRevision() : 'Consultando al backend…' }}
              </p>
            </div>
            <button class="btn-secondary sm" (click)="probar()" [disabled]="probando()"><i class="ph" [class.ph-arrows-clockwise]="!probando()" [class.ph-spinner]="probando()"></i> Revisar</button>
          </div>

          <div class="salud">
            <div class="srv" [class.ok]="estado()?.ok" [class.bad]="estado() && !estado()!.ok">
              <i class="ph ph-hard-drives"></i>
              <div>
                <strong>Backend</strong>
                <small>{{ estado()?.ok ? (estado()!.agente || 'en línea') : estado() ? 'sin conexión' : '…' }} · {{ host(api.baseUrl) }}</small>
              </div>
              <span class="est">{{ estado()?.ok ? 'OK' : estado() ? 'Caído' : '…' }}</span>
            </div>
            @for (s of servicios(); track s.key) {
              <div class="srv" [class.ok]="s.nivel === 'ok'" [class.bad]="s.nivel === 'bad'" [class.warn]="s.nivel === 'warn'">
                <i class="ph {{ s.icono }}"></i>
                <div><strong>{{ s.titulo }}</strong><small [title]="s.para + ' · ' + s.valor">{{ s.para }} · {{ s.valor }}</small></div>
                <span class="est">{{ s.etiqueta }}</span>
              </div>
            }
            @if (estado()?.ok) {
              <div class="srv" [class.ok]="estado()!.protegido" [class.warn]="!estado()!.protegido">
                <i class="ph ph-shield-check"></i>
                <div>
                  <strong>Administración</strong>
                  <small>{{ estado()!.protegido ? 'endpoints protegidos: sesión o clave' : 'sin autenticación: define ADMIN_API_KEY' }}</small>
                </div>
                <span class="est">{{ estado()!.protegido ? 'OK' : 'Abierta' }}</span>
              </div>
            }
          </div>
          @if (estado()?.status === 'degradado') {
            <p class="nota warn"><i class="ph ph-warning"></i> El agente responde, pero sin {{ caidos() }} algunas funciones fallan. Revisa la conexión en <a (click)="ir('env')">Claves y variables → Datos</a>.</p>
          }
        </div>

        <!-- Sesión y acceso -->
        <div class="card">
          <h3>Sesión y acceso</h3>
          @if (auth.logueado()) {
            <div class="sesion">
              <span class="avatar">{{ inicial() }}</span>
              <div class="quien"><strong>{{ auth.usuario() }}</strong><small>Sesión activa en este navegador</small></div>
              <button class="btn-secondary sm" (click)="auth.logout()"><i class="ph ph-sign-out"></i> Cerrar sesión</button>
            </div>
          } @else {
            <p class="card-sub">Sin sesión. <a routerLink="/login">Inicia sesión</a> para administrar el agente.</p>
          }

          <div class="sep"></div>
          <div class="sub-h">
            <strong>Clave de administración</strong>
            <small>Para llamar al API sin la GUI (scripts, curl). Es la <code>ADMIN_API_KEY</code> del .env: la GUI no la guarda, la pide con tu sesión.</small>
          </div>
          @if (adminKeyRemota() === undefined) {
            <div class="empty chico">Inicia sesión para verla.</div>
          } @else if (adminKeyRemota() === null) {
            <p class="nota warn"><i class="ph ph-warning"></i> El backend no tiene <code>ADMIN_API_KEY</code>. Defínela en <a (click)="ir('env')">Claves y variables</a> si vas a llamar al API directo.</p>
          } @else {
            <div class="clave-row">
              <code class="clave">{{ mostrar() ? adminKeyRemota() : '•'.repeat(20) + adminKeyRemota()!.slice(-4) }}</code>
              <button class="btn-icon" [title]="mostrar() ? 'Ocultar' : 'Mostrar'" (click)="mostrar.set(!mostrar())"><i class="ph" [class.ph-eye]="!mostrar()" [class.ph-eye-slash]="mostrar()"></i></button>
              <button class="btn-secondary sm" (click)="copiar(adminKeyRemota()!, 'Clave copiada')"><i class="ph ph-copy"></i> Copiar</button>
            </div>
            <div class="ejemplo">
              <code>curl -H "X-Admin-Key: $YISUS_ADMIN_KEY" {{ api.baseUrl }}/api/usage</code>
              <button class="btn-icon" title="Copiar ejemplo" (click)="copiar('curl -H &quot;X-Admin-Key: $YISUS_ADMIN_KEY&quot; ' + api.baseUrl + '/api/usage', 'Ejemplo copiado')"><i class="ph ph-copy"></i></button>
            </div>
            <small class="hint">También sirve <code>Authorization: Bearer &lt;clave&gt;</code>. No la pegues en chats ni la subas al repo.</small>
          }
        </div>

        <!-- URL del backend -->
        <div class="card">
          <div class="card-top">
            <div>
              <h3>Backend al que se conecta esta GUI</h3>
              <p class="card-sub">
                @if (urlGuardada()) { Fijada a mano en este navegador. }
                @else { Automática: mismo dominio en producción, puerto 4000 en desarrollo. }
              </p>
            </div>
            @if (!editandoUrl()) { <button class="btn-secondary sm" (click)="editandoUrl.set(true)"><i class="ph ph-pencil-simple"></i> Cambiar</button> }
          </div>
          @if (!editandoUrl()) {
            <div class="url-actual"><i class="ph ph-link"></i> <code>{{ api.baseUrl }}</code></div>
          } @else {
            <div class="url-edit">
              <input type="text" [(ngModel)]="url" placeholder="Vacío = automático" (keydown.enter)="guardar()" />
              <button class="btn-secondary" (click)="probarUrl()" [disabled]="probando()">Probar</button>
              <button class="btn-primary" (click)="guardar()">Guardar</button>
              <button class="btn-icon" title="Cancelar" (click)="cancelarUrl()"><i class="ph ph-x"></i></button>
            </div>
            @if (pruebaUrl(); as p) {
              <div class="prueba" [class.ok]="p.ok" [class.bad]="!p.ok"><i class="ph" [class.ph-check-circle]="p.ok" [class.ph-x-circle]="!p.ok"></i> {{ p.texto }}</div>
            }
            @if (urlGuardada()) { <button class="link" (click)="volverAuto()">Volver a automático</button> }
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .tabs { display: flex; gap: 4px; margin-bottom: 18px; border-bottom: 1px solid var(--border-light); overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
    .tabs::-webkit-scrollbar { display: none; }
    .tab { display: inline-flex; align-items: center; gap: 8px; padding: 10px 14px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--text-dim); font-size: 14px; cursor: pointer; white-space: nowrap; margin-bottom: -1px; }
    .tab i { font-size: 17px; }
    .tab:hover { color: var(--text-main); }
    .tab.on { color: var(--accent-primary); border-bottom-color: var(--accent-primary); }
    .cnt { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--bg-input); color: var(--text-dim); border: 1px solid var(--border-light); }
    .tab.on .cnt { color: var(--accent-primary); border-color: rgba(129,140,248,.4); }
    .corto { display: none; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim); }
    .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--danger); }

    .card-top { display: flex; align-items: flex-start; gap: 12px; }
    .card-top > div { flex: 1; min-width: 0; }
    .btn-secondary.sm { padding: 6px 11px; font-size: 12.5px; display: inline-flex; gap: 6px; align-items: center; }

    .salud { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; margin-top: 4px; }
    .srv { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border-light); background: var(--bg-main); }
    .srv > i { font-size: 22px; color: var(--text-dim); }
    .srv > div { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .srv small { color: var(--text-dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .srv .est { font-size: 12px; font-weight: 600; color: var(--text-dim); }
    .srv.ok > i, .srv.ok .est { color: var(--ok); }
    .srv.bad { border-color: rgba(239,68,68,.45); } .srv.bad > i, .srv.bad .est { color: var(--danger); }
    .srv.warn { border-color: rgba(245,158,11,.45); } .srv.warn > i, .srv.warn .est { color: var(--warn); }

    .nota { margin: 12px 0 0; font-size: 13px; color: var(--text-dim); line-height: 1.5; }
    .nota i { margin-right: 4px; }
    .nota.warn { color: var(--warn); }
    .nota a { color: var(--accent-primary); cursor: pointer; text-decoration: underline; }

    .sesion { display: flex; align-items: center; gap: 12px; }
    .avatar { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: rgba(129,140,248,.18); color: var(--accent-primary); font-weight: 700; text-transform: uppercase; }
    .quien { flex: 1; display: flex; flex-direction: column; }
    .quien small { color: var(--text-dim); font-size: 12px; }
    .sep { height: 1px; background: var(--border-light); margin: 16px 0; }
    .sub-h { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
    .sub-h small { color: var(--text-dim); font-size: 12.5px; }
    .clave-row { display: flex; align-items: center; gap: 8px; }
    .clave { flex: 1; min-width: 0; padding: 9px 12px; background: var(--bg-input); border: 1px solid var(--border-light); border-radius: 8px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ejemplo { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 8px 8px 8px 12px; background: var(--bg-input); border-radius: 8px; }
    .ejemplo code { flex: 1; min-width: 0; font-size: 12px; color: var(--text-dim); overflow-x: auto; white-space: nowrap; }
    .hint { display: block; margin-top: 8px; color: var(--text-dim); font-size: 12px; }
    .empty.chico { padding: 10px 0; }

    .url-actual { display: flex; align-items: center; gap: 8px; color: var(--text-dim); }
    .url-actual code { color: var(--text-main); font-size: 13px; word-break: break-all; }
    .url-edit { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .url-edit input { flex: 1 1 260px; }
    .prueba { margin-top: 10px; font-size: 13px; }
    .prueba.ok { color: var(--ok); } .prueba.bad { color: var(--danger); }
    .link { margin-top: 10px; background: none; border: none; padding: 0; color: var(--accent-primary); font-size: 13px; cursor: pointer; }

    @media (max-width: 640px) {
      .tabs { gap: 0; }
      .tab { padding: 10px 8px; font-size: 13px; gap: 6px; }
      .tab i { display: none; }
      .largo { display: none; } .corto { display: inline; }
      .card-top { flex-wrap: wrap; }
    }
  `],
})
export class SettingsComponent {
  api = inject(ApiService);
  private toast = inject(ToastService);
  auth = inject(AuthService);

  url = this.urlGuardadaLeer();
  estado = signal<Estado | null>(null);
  probando = signal(false);
  editandoUrl = signal(false);
  pruebaUrl = signal<{ ok: boolean; texto: string } | null>(null);
  urlGuardada = signal(!!this.urlGuardadaLeer());
  /** undefined = sin sesión / no consultada; null = el backend no tiene clave */
  adminKeyRemota = signal<string | null | undefined>(undefined);
  mostrar = signal(false);

  tab = signal<Tab>(((): Tab => { try { return (localStorage.getItem(TAB_KEY) as Tab) || 'llm'; } catch { return 'llm'; } })());
  llm = signal<LlmSettings | null>(null);
  errorLlm = signal<string | null>(null);
  usos = computed(() => {
    const out: Record<string, number> = {};
    for (const a of this.llm()?.agentes || []) if (a.assignment) out[a.assignment.provider] = (out[a.assignment.provider] || 0) + 1;
    return out;
  });
  activos = computed(() => (this.llm()?.providers || []).filter((p) => p.enabled).length);
  personalizados = computed(() => (this.llm()?.agentes || []).filter((a) => a.assignment).length);
  inicial = computed(() => (this.auth.usuario() || '?').slice(0, 1));
  servicios = computed(() => Object.entries(this.estado()?.servicios || {}).map(([key, valor]) => ({
    key, valor: valor.replace(/-/g, ' '),
    ...(valor === 'conectado' ? { nivel: 'ok', etiqueta: 'OK' }
      : valor === 'reconectando' ? { nivel: 'warn', etiqueta: 'Reintentando' }
      : valor === 'no-configurado' ? { nivel: 'off', etiqueta: 'No usado' }
      : { nivel: 'bad', etiqueta: 'Caído' }),
    ...(NOMBRE_SERVICIO[key] || { titulo: key, icono: 'ph-circle', para: '' }),
  })));

  constructor() { this.probar(); this.cargarClave(); if (this.auth.logueado()) this.cargarLlm(); }

  ir(t: Tab) { this.tab.set(t); try { localStorage.setItem(TAB_KEY, t); } catch {} }

  cargarLlm() {
    this.api.getLlmSettings().subscribe({
      next: (r) => { this.llm.set(r); this.errorLlm.set(null); },
      error: (e) => this.errorLlm.set(e?.error?.error || 'No se pudo cargar la configuración de modelos (¿backend actualizado?)'),
    });
  }

  private urlGuardadaLeer(): string { try { return localStorage.getItem('yisus_api_url') || ''; } catch { return ''; } }

  private cargarClave() {
    if (!this.auth.logueado() && !localStorage.getItem('yisus_admin_key')) return;
    this.api.getAdminKey().subscribe({ next: (r) => this.adminKeyRemota.set(r.key), error: () => this.adminKeyRemota.set(undefined) });
  }

  copiar(texto: string, ok: string) {
    navigator.clipboard.writeText(texto).then(() => this.toast.ok(ok), () => this.toast.error('No se pudo copiar'));
  }

  host(u: string) { try { return new URL(u).host; } catch { return u; } }

  resumenRevision() {
    const e = this.estado()!;
    return `Revisado ${this.haceCuanto(e.revisado)}${e.ms ? ` · respondió en ${e.ms} ms` : ''}.`;
  }

  caidos() {
    const l = this.servicios().filter((s) => s.nivel === 'bad' || s.nivel === 'warn').map((s) => s.titulo);
    return l.length ? l.join(' y ') : 'algunos servicios';
  }

  haceCuanto(t: number) {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 10 ? 'recién' : s < 60 ? `hace ${s} s` : `hace ${Math.round(s / 60)} min`;
  }

  probar() {
    this.probando.set(true);
    const t0 = performance.now();
    this.api.getStatus().subscribe({
      next: (r) => { this.probando.set(false); this.estado.set({ ok: true, status: r.status, agente: r.agente, protegido: r.protegido, servicios: r.servicios, ms: Math.round(performance.now() - t0), revisado: Date.now() }); },
      error: () => { this.probando.set(false); this.estado.set({ ok: false, revisado: Date.now() }); },
    });
  }

  /** Prueba la URL escrita sin guardarla. */
  probarUrl() {
    const base = (this.url || '').trim().replace(/\/+$/, '') || this.api.baseUrl;
    this.probando.set(true);
    this.pruebaUrl.set(null);
    const t0 = performance.now();
    fetch(`${base}/api/status`).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j) => this.pruebaUrl.set({ ok: true, texto: `Responde "${j?.agente || 'agente'}" en ${Math.round(performance.now() - t0)} ms` }))
      .catch((e) => this.pruebaUrl.set({ ok: false, texto: `No responde: ${e?.message || 'error de red'} (¿URL o CORS?)` }))
      .finally(() => this.probando.set(false));
  }

  guardar() {
    this.api.setBaseUrl(this.url);
    this.urlGuardada.set(!!this.urlGuardadaLeer());
    this.editandoUrl.set(false);
    this.pruebaUrl.set(null);
    this.toast.ok('Backend actualizado');
    this.probar();
    this.cargarClave();
  }

  volverAuto() { this.url = ''; this.guardar(); }
  cancelarUrl() { this.url = this.urlGuardadaLeer(); this.editandoUrl.set(false); this.pruebaUrl.set(null); }
}
