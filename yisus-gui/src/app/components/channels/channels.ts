import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, ChannelsConfig } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

type Canal = 'telegram' | 'buzz' | 'api' | 'a2a';
type Sel = Record<Canal, string[]>;
interface Tool { name: string; titulo: string; descripcion: string; grupo: string; etiqueta: string; sensible: string | null; manifiesto: string[] | null; }
interface Grupo { id: string; etiqueta: string; tools: Tool[]; }

const CANALES: Array<{ id: Canal; nombre: string; sub: string; icono: string; externo: boolean }> = [
  { id: 'telegram', nombre: 'Telegram', sub: 'Tu canal privado', icono: 'ph-telegram-logo', externo: false },
  { id: 'buzz', nombre: 'Buzz', sub: 'Quien te escriba en la comunidad', icono: 'ph-broadcast', externo: true },
  { id: 'api', nombre: 'GUI y API', sub: 'Chat de la GUI y /run (con tu clave)', icono: 'ph-plugs-connected', externo: false },
  { id: 'a2a', nombre: 'A2A público', sub: 'Techo para agentes externos', icono: 'ph-globe-hemisphere-west', externo: true },
];
const ORDEN_GRUPOS = ['publico', 'knowledge', 'workspace', 'compromisos', 'triage', 'reminders', 'personalizados', 'builder', 'webhooks', 'usage', 'buzz', 'peers', 'otros'];
const vacio = (): Sel => ({ telegram: [], buzz: [], api: [], a2a: [] });

/**
 * Qué herramientas ve cada canal, en una sola matriz (herramientas × canales).
 * Es la cara visible de config/channels.json: lo desmarcado, el modelo de ese canal ni lo ve.
 */
@Component({
  selector: 'app-channels',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Canales y herramientas</h2>
          <p class="sub">Cada canal arma su propio agente con lo que marques. Lo desmarcado no es un permiso que se pida después: para ese canal la herramienta no existe.</p>
        </div>
        <button class="btn-secondary" (click)="load()" [disabled]="loading()"><i class="ph ph-arrows-clockwise"></i> Recargar</button>
      </div>

      @if (loading() && !config()) {
        <div class="card"><div class="empty">Cargando configuración…</div></div>
      } @else if (!config()) {
        <div class="card"><div class="empty">No se pudo leer la configuración. Revisa la URL del backend en Ajustes.</div></div>
      } @else {
        @if (reiniciar()) {
          <div class="aviso-reinicio">
            <i class="ph ph-info"></i>
            <span>Guardado. Los agentes se arman al arrancar: los cambios aplican cuando reinicies el servicio.</span>
            <span class="spacer"></span>
            <button class="btn-primary sm" [disabled]="reiniciando()" (click)="reiniciarAhora()"><i class="ph" [class.ph-power]="!reiniciando()" [class.ph-spinner]="reiniciando()"></i> Reiniciar ahora</button>
            <button class="btn-icon" title="Cerrar" (click)="reiniciar.set(false)"><i class="ph ph-x"></i></button>
          </div>
        }

        <div class="toolbar">
          <input type="text" class="buscar" [ngModel]="q()" (ngModelChange)="q.set($event)" placeholder="Buscar herramienta…" />
          <label class="check"><input type="checkbox" [checked]="soloActivas()" (change)="soloActivas.set($any($event.target).checked)" /> Solo las activas en algún canal</label>
          <span class="spacer"></span>
          <span class="leyenda">
            <span><i class="ph ph-lock-simple"></i> activo desde Agentes</span>
            <span><i class="ph ph-warning" style="color:var(--warn)"></i> sensible en canal externo</span>
          </span>
        </div>

        <!-- Móvil: un canal a la vez -->
        <div class="seg canal-pick">
          @for (k of canales; track k.id) {
            <button [class.on]="canalMovil() === k.id" (click)="canalMovil.set(k.id)"><i class="ph" [class]="'ph ' + k.icono"></i> {{ k.nombre }} <small>{{ sel()[k.id].length }}</small></button>
          }
        </div>

        <div class="card matriz">
          <table>
            <thead>
              <tr>
                <th class="c-tool">Herramienta</th>
                @for (k of canales; track k.id) {
                  <th class="c-canal" [class.movil-on]="canalMovil() === k.id">
                    <div class="h-canal"><i class="ph" [class]="'ph ' + k.icono"></i> {{ k.nombre }}</div>
                    <div class="h-sub">{{ k.sub }}</div>
                    <div class="h-cnt">
                      <span class="badge dim">{{ sel()[k.id].length }}/{{ tools().length }}</span>
                      @if (sucio(k.id)) { <span class="dot-sucio" title="Cambios sin guardar"></span> }
                    </div>
                    @if (k.id === 'a2a') { <a routerLink="/tokens" class="h-link">Tokens →</a> }
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (g of grupos(); track g.id) {
                <!-- Grupo de una sola herramienta con el mismo nombre: la cabecera sería ruido -->
                @if (!(g.tools.length === 1 && g.tools[0].titulo.toLowerCase() === g.etiqueta.toLowerCase())) {
                <tr class="g-row">
                  <td class="c-tool"><span class="g-nom">{{ g.etiqueta }}</span>@if (g.tools.length > 1) { <small class="dim"> · {{ g.tools.length }}</small> }</td>
                  @for (k of canales; track k.id) {
                    <td class="c-canal" [class.movil-on]="canalMovil() === k.id">
                      @if (g.tools.length > 1) {
                      <input type="checkbox" class="cb" [title]="'Todo el grupo en ' + k.nombre"
                        [checked]="estadoGrupo(g, k.id) === 'todo'" [indeterminate]="estadoGrupo(g, k.id) === 'parcial'"
                        (change)="toggleGrupo(g, k.id)" />
                      }
                    </td>
                  }
                </tr>
                }
                @for (t of g.tools; track t.name) {
                  <tr class="t-row">
                    <td class="c-tool">
                      <div class="t-tit">
                        {{ t.titulo }}
                        @if (t.sensible) { <i class="ph ph-shield-warning sens" [title]="'Sensible: ' + t.sensible"></i> }
                      </div>
                      <div class="t-desc">{{ t.descripcion }}</div>
                      <code class="t-name">{{ t.name }}</code>
                    </td>
                    @for (k of canales; track k.id) {
                      <td class="c-canal" [class.movil-on]="canalMovil() === k.id" [class.riesgo]="k.externo && !!t.sensible && on(k.id, t.name)">
                        @if (porManifiesto(t, k.id) && !on(k.id, t.name)) {
                          <a routerLink="/agents" class="lock" title="Activo por la configuración del agente (Agentes → canales)"><i class="ph ph-lock-simple"></i></a>
                        } @else {
                          <label class="celda" [title]="(on(k.id, t.name) ? 'Quitar de ' : 'Dar a ') + k.nombre + (k.externo && t.sensible ? ' — ojo: ' + t.sensible : '')">
                            <input type="checkbox" class="cb" [checked]="on(k.id, t.name)" (change)="toggle(k.id, t.name)" />
                            @if (k.externo && t.sensible && on(k.id, t.name)) { <i class="ph ph-warning warn"></i> }
                          </label>
                        }
                      </td>
                    }
                  </tr>
                }
              } @empty {
                <tr><td [attr.colspan]="canales.length + 1"><div class="empty">Ninguna herramienta coincide.</div></td></tr>
              }
            </tbody>
          </table>
        </div>

        <details class="card avanzado">
          <summary>Editar <code>config/channels.json</code> a mano: grupos disponibles</summary>
          <p class="card-sub">En el archivo puedes usar el nombre de un grupo (se expande a sus herramientas), el de una herramienta o <code>*</code>.</p>
          <table>
            <tr><th>Grupo</th><th>Incluye</th></tr>
            @for (g of gruposArchivo(); track g.nombre) {
              <tr><td><code>{{ g.nombre }}</code></td><td class="mono dim">{{ g.tools.join(', ') || '—' }}</td></tr>
            }
          </table>
        </details>

        @if (cambios() > 0) {
          <div class="barra">
            <span><b>{{ cambios() }}</b> cambio{{ cambios() === 1 ? '' : 's' }} sin guardar @if (riesgos().length) { · <span class="warn"><i class="ph ph-warning"></i> {{ riesgos().length }} herramienta{{ riesgos().length === 1 ? '' : 's' }} sensible{{ riesgos().length === 1 ? '' : 's' }} en canales externos</span> }</span>
            <span class="spacer"></span>
            <button class="btn-secondary" (click)="descartar()">Descartar</button>
            <button class="btn-primary" [disabled]="guardando()" (click)="guardar()"><i class="ph" [class.ph-floppy-disk]="!guardando()" [class.ph-spinner]="guardando()"></i> Guardar</button>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .toolbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 12px; }
    .buscar { max-width: 320px; }
    .check { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--text-dim); cursor: pointer; }
    .check input { width: 15px; height: 15px; accent-color: var(--accent-primary); }
    .leyenda { display: inline-flex; gap: 14px; font-size: 12px; color: var(--text-dim); }
    .leyenda span { display: inline-flex; gap: 5px; align-items: center; }
    .aviso-reinicio { display: flex; align-items: center; gap: 10px; padding: 10px 14px; margin-bottom: 12px; border-radius: 10px; border: 1px solid rgba(129,140,248,.45); background: rgba(129,140,248,.08); font-size: 13.5px; }
    .aviso-reinicio > i { color: var(--accent-primary); font-size: 18px; }
    .btn-primary.sm { padding: 6px 11px; font-size: 12.5px; }
    .matriz { padding: 0; overflow: auto; max-height: calc(100vh - 250px); }
    .matriz table { width: 100%; min-width: 0; border-collapse: separate; border-spacing: 0; }
    .matriz th, .matriz td { border-bottom: 1px solid var(--border-light); padding: 10px 12px; vertical-align: middle; }
    .matriz thead th { position: sticky; top: 0; z-index: 2; background: var(--bg-card); text-align: center; font-weight: 600; text-transform: none; letter-spacing: normal; color: var(--text-main); }
    .matriz th.c-tool { text-align: left !important; min-width: 280px; color: var(--text-dim); font-size: 12px; }
    .c-canal { text-align: center; width: 128px; }
    .h-canal { display: inline-flex; gap: 6px; align-items: center; font-size: 13.5px; }
    .h-canal i { color: var(--accent-primary); }
    .h-sub { font-size: 11px; font-weight: 400; color: var(--text-dim); margin-top: 2px; }
    .h-cnt { margin-top: 6px; display: inline-flex; gap: 6px; align-items: center; }
    .h-link { display: block; font-size: 11.5px; font-weight: 500; margin-top: 4px; color: var(--accent-primary); text-decoration: none; }
    .dot-sucio { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }
    .g-row td { background: var(--bg-main); padding-top: 8px; padding-bottom: 8px; }
    .g-nom { font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--text-dim); }
    .t-row:hover td { background: rgba(129,140,248,.04); }
    .t-tit { font-size: 13.5px; font-weight: 600; display: flex; gap: 6px; align-items: center; }
    .sens { color: var(--warn); font-size: 15px; }
    .t-desc { font-size: 12.5px; color: var(--text-dim); margin-top: 2px; max-width: 560px; }
    .t-name { font-size: 11px; color: var(--text-dim); opacity: .75; }
    .cb { width: 17px; height: 17px; accent-color: var(--accent-primary); cursor: pointer; }
    .celda { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; padding: 6px; }
    td.riesgo { background: rgba(245,158,11,.07); }
    .warn { color: var(--warn); }
    .lock { color: var(--text-dim); font-size: 16px; }
    .lock:hover { color: var(--accent-primary); }
    .dim { color: var(--text-dim); }
    .avanzado { margin-top: 14px; }
    .avanzado summary { cursor: pointer; font-size: 13.5px; color: var(--text-dim); }
    .avanzado { overflow: hidden; }
    .avanzado table { margin-top: 10px; width: 100%; min-width: 0; table-layout: fixed; }
    .avanzado td { word-break: break-word; }
    .avanzado td:first-child { width: 130px; }
    .barra { position: sticky; bottom: 12px; z-index: 5; margin-top: 14px; display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; background: var(--bg-card); border: 1px solid var(--accent-primary); box-shadow: 0 10px 30px rgba(0,0,0,.35); font-size: 13.5px; flex-wrap: wrap; }
    .seg { display: inline-flex; border: 1px solid var(--border-light); border-radius: 8px; overflow: hidden; }
    .seg button { padding: 8px 12px; border: none; background: var(--bg-card); color: var(--text-dim); cursor: pointer; font-size: 13px; }
    .seg button.on { background: var(--accent-primary); color: #fff; }
    .canal-pick { display: none; margin-bottom: 10px; width: 100%; }
    .canal-pick button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
    .canal-pick small { opacity: .7; }
    .ph-spinner { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 760px) {
      .canal-pick { display: flex; flex-wrap: wrap; }
      .canal-pick button { flex: 1 1 45%; font-size: 12.5px; padding: 7px 6px; }
      .buscar { max-width: none; width: 100%; }
      .matriz td.c-tool { padding-right: 6px; }
      .leyenda { display: none; }
      .matriz { max-height: none; overflow: visible; }
      .matriz thead { display: none; }
      .c-canal { display: none; }
      .c-canal.movil-on { display: table-cell; width: 64px; }
      .matriz th.c-tool { min-width: 0; }
      .t-desc { font-size: 12px; }
    }
  `],
})
export class ChannelsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  canales = CANALES;
  config = signal<ChannelsConfig | null>(null);
  sel = signal<Sel>(vacio());
  original = signal<Sel>(vacio());
  loading = signal(true);
  guardando = signal(false);
  reiniciar = signal(false);
  reiniciando = signal(false);
  q = signal('');
  soloActivas = signal(false);
  canalMovil = signal<Canal>('telegram');

  tools = computed<Tool[]>(() => {
    const c = this.config();
    if (!c) return [];
    return c.detalle?.length
      ? (c.detalle as Tool[])
      : c.catalogo.map((name) => ({ name, titulo: name.replace(/_/g, ' '), descripcion: '', grupo: 'otros', etiqueta: 'Otros', sensible: null, manifiesto: null }));
  });

  grupos = computed<Grupo[]>(() => {
    const f = this.q().trim().toLowerCase();
    const s = this.sel();
    const out = new Map<string, Grupo>();
    for (const t of this.tools()) {
      if (f && ![t.name, t.titulo, t.descripcion, t.etiqueta].some((x) => (x || '').toLowerCase().includes(f))) continue;
      if (this.soloActivas() && !this.canales.some((k) => s[k.id].includes(t.name) || this.porManifiesto(t, k.id))) continue;
      if (!out.has(t.grupo)) out.set(t.grupo, { id: t.grupo, etiqueta: t.etiqueta, tools: [] });
      out.get(t.grupo)!.tools.push(t);
    }
    const pos = (g: string) => { const i = ORDEN_GRUPOS.indexOf(g); return i < 0 ? 99 : i; };
    return [...out.values()].sort((a, b) => pos(a.id) - pos(b.id));
  });

  cambios = computed(() => {
    const s = this.sel(), o = this.original();
    let n = 0;
    for (const k of this.canales) {
      const a = new Set(s[k.id]), b = new Set(o[k.id]);
      for (const x of a) if (!b.has(x)) n++;
      for (const x of b) if (!a.has(x)) n++;
    }
    return n;
  });

  /** Herramientas sensibles activas en canales externos (para el aviso de la barra). */
  riesgos = computed(() => {
    const s = this.sel();
    return this.tools().filter((t) => t.sensible && this.canales.some((k) => k.externo && s[k.id].includes(t.name)));
  });

  gruposArchivo() {
    return Object.entries(this.config()?.grupos || {}).map(([nombre, tools]) => ({ nombre, tools }));
  }

  constructor() { this.load(); }

  load() {
    this.loading.set(true);
    this.api.getChannels().subscribe({
      next: (c) => {
        this.config.set(c);
        const s: Sel = { telegram: [...c.canales.telegram], buzz: [...c.canales.buzz], api: [...c.canales.api], a2a: [...(c.a2a || [])] };
        this.sel.set(s);
        this.original.set(JSON.parse(JSON.stringify(s)));
        this.loading.set(false);
        // Compatibilidad con un backend anterior que no manda a2a en /api/channels
        if (!c.a2a) this.api.getDisponiblesA2A().subscribe({ next: (r) => { this.sel.update((x) => ({ ...x, a2a: [...r.disponibles] })); this.original.update((x) => ({ ...x, a2a: [...r.disponibles] })); } });
      },
      error: () => { this.loading.set(false); this.toast.error('No se pudo cargar la configuración de canales'); },
    });
  }

  on(k: Canal, tool: string) { return this.sel()[k].includes(tool); }
  porManifiesto(t: Tool, k: Canal) { return !!t.manifiesto?.includes(k); }
  sucio(k: Canal) { return [...this.sel()[k]].sort().join(',') !== [...this.original()[k]].sort().join(','); }

  toggle(k: Canal, tool: string) {
    this.sel.update((s) => ({ ...s, [k]: s[k].includes(tool) ? s[k].filter((t) => t !== tool) : [...s[k], tool] }));
  }

  estadoGrupo(g: Grupo, k: Canal): 'todo' | 'parcial' | 'nada' {
    const n = g.tools.filter((t) => this.on(k, t.name)).length;
    return n === 0 ? 'nada' : n === g.tools.length ? 'todo' : 'parcial';
  }
  toggleGrupo(g: Grupo, k: Canal) {
    const marcar = this.estadoGrupo(g, k) !== 'todo';
    const nombres = g.tools.map((t) => t.name);
    this.sel.update((s) => {
      const set = new Set(s[k]);
      for (const n of nombres) marcar ? set.add(n) : set.delete(n);
      return { ...s, [k]: [...set] };
    });
  }

  descartar() { this.sel.set(JSON.parse(JSON.stringify(this.original()))); }

  async guardar() {
    this.guardando.set(true);
    const s = this.sel();
    const hechos: string[] = [];
    try {
      for (const k of this.canales) {
        if (!this.sucio(k.id)) continue;
        if (k.id === 'a2a') await firstValueFrom(this.api.saveDisponiblesA2A(s.a2a));
        else await firstValueFrom(this.api.saveChannelTools(k.id, s[k.id]));
        this.original.update((o) => ({ ...o, [k.id]: [...s[k.id]] }));
        hechos.push(k.nombre);
      }
      this.toast.ok(`Guardado: ${hechos.join(', ')}`);
      this.reiniciar.set(true);
    } catch (e: any) {
      this.toast.error(`${hechos.length ? `Guardado ${hechos.join(', ')}; ` : ''}falló el resto: ${e?.error?.error || e?.message || 'error'}`);
    } finally {
      this.guardando.set(false);
    }
  }

  reiniciarAhora() {
    this.reiniciando.set(true);
    this.api.restartBackend().subscribe({
      next: () => {
        this.toast.ok('Reiniciando el servicio…');
        // Espera a que vuelva y recarga la configuración efectiva.
        let intentos = 0;
        const t = setInterval(() => {
          intentos++;
          this.api.getStatus().subscribe({
            next: () => { if (intentos < 3) return; clearInterval(t); this.reiniciando.set(false); this.reiniciar.set(false); this.toast.ok('Servicio reiniciado: los canales ya usan la nueva configuración'); this.load(); },
            error: () => { if (intentos > 30) { clearInterval(t); this.reiniciando.set(false); this.toast.error('El servicio no respondió tras reiniciar'); } },
          });
        }, 2000);
      },
      error: (e) => { this.reiniciando.set(false); this.toast.error(e?.error?.error || 'No se pudo reiniciar'); },
    });
  }
}
