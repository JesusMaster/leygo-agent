import { ChangeDetectorRef, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, CanalAgente, CustomAgent, CustomToolDef, EnvVar } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { ModelPickerComponent } from '../model-picker/model-picker';
import { MarkdownPipe } from '../../pipes/markdown.pipe';

const CANALES: Array<{ id: CanalAgente; nombre: string }> = [
  { id: 'telegram', nombre: 'Telegram' }, { id: 'api', nombre: 'API / GUI' }, { id: 'buzz', nombre: 'Buzz' }, { id: 'a2a', nombre: 'A2A' },
];

/**
 * Agentes personalizados: los que Jesús crea (por chat con el agente programador
 * o desde acá). Se editan en línea: soul, herramientas con su código, variables,
 * memoria, modelo y canales. Los del sistema (Coordinator, Conocimiento…) no aparecen.
 */
@Component({
  selector: 'app-agents',
  imports: [FormsModule, RouterLink, ModelPickerComponent, MarkdownPipe],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Agentes</h2>
          <p class="sub">Tus agentes especialistas. Descríbelos en lenguaje natural y el agente programador los construye con sus herramientas; después los editas acá. Los agentes del sistema se configuran en <a routerLink="/settings">Ajustes</a>.</p>
        </div>
        <div class="row">
          <button class="btn-secondary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> A mano</button>
          <button class="btn-primary" (click)="modalIA.set(true)"><i class="ph ph-sparkle"></i> Crear con IA</button>
        </div>
      </div>

      @if (!cargado()) {
        <div class="card"><div class="empty">Cargando…</div></div>
      } @else if (agents().length === 0) {
        <div class="card empty-state">
          <i class="ph ph-robot"></i>
          <h3>Todavía no hay agentes personalizados</h3>
          <p>Prueba "Crear con IA" con algo como: <em>"Crea un agente que me ayude en los estudios de vuelo: convierte km a millas y pies a metros y calcula el top of descent. Se llama Nami y tiene la personalidad de un instructor de vuelo."</em></p>
          <button class="btn-primary" (click)="modalIA.set(true)"><i class="ph ph-sparkle"></i> Crear con IA</button>
        </div>
      } @else {
        @for (a of agents(); track a.name) {
          <div class="ag" [class.off]="!a.enabled">
            <div class="ag-head">
              <div class="ag-title">
                <i class="ph ph-robot"></i>
                <div>
                  <h3>{{ a.displayName }} <code class="slug">{{ a.name }}</code></h3>
                  <p>{{ a.description }}</p>
                </div>
              </div>
              <div class="ag-actions">
                <span class="tb" [class.ok]="a.enabled">{{ a.enabled ? 'activo' : 'desactivado' }}</span>
                @for (c of a.channels; track c) { <span class="tb chan">{{ nombreCanal(c) }}</span> }
                @if (a.memory) { <span class="tb mem"><i class="ph ph-brain"></i> memoria</span> }
                <span class="tb dim">v{{ a.version }} · {{ a.createdBy === 'ia' ? 'creado por IA' : 'a mano' }}</span>
                <button class="ta" [class.on]="abierto() === a.name" title="Editar" (click)="toggle(a)"><i class="ph ph-pencil-simple"></i></button>
                <button class="ta" title="Probar en chat" (click)="abrirPrueba(a)"><i class="ph ph-chat-circle-dots"></i></button>
                <button class="ta" [title]="a.enabled ? 'Desactivar' : 'Activar'" (click)="alternar(a)"><i class="ph" [class.ph-pause]="a.enabled" [class.ph-play]="!a.enabled"></i></button>
                <button class="ta del" title="Eliminar" (click)="eliminar(a)"><i class="ph ph-trash"></i></button>
              </div>
            </div>

            <div class="ag-tools">
              @for (t of a.tools; track t.name) { <span class="tool-chip" [title]="t.description"><i class="ph ph-function"></i> {{ t.name }}@if (t.network) { <i class="ph ph-globe" title="usa red"></i> }</span> }
              @if (!a.tools.length) { <span class="dim">sin herramientas</span> }
            </div>

            @if (abierto() === a.name && form) {
              <div class="editor">
                <div class="grid2">
                  <label class="field"><span>Nombre visible</span><input type="text" [(ngModel)]="form.displayName" /></label>
                  <label class="field"><span>Cuándo usarlo (ruteo del Coordinator)</span><input type="text" [(ngModel)]="form.description" /></label>
                </div>
                <label class="field">
                  <span>Soul — personalidad e instrucciones</span>
                  <textarea rows="6" [(ngModel)]="form.soul"></textarea>
                </label>
                <div class="grid2">
                  <div class="field">
                    <span>Canales</span>
                    <div class="chips">
                      @for (c of canales; track c.id) {
                        <button type="button" class="chip" [class.on]="form.channels.includes(c.id)" (click)="toggleCanal(c.id)">{{ c.nombre }}</button>
                      }
                    </div>
                  </div>
                  <label class="check" style="margin-top:22px">
                    <input type="checkbox" [(ngModel)]="form.memory" />
                    <span><strong>Memoria propia</strong> (recuerda entre conversaciones; requiere Qdrant)</span>
                  </label>
                </div>
                <div class="field"><span>Modelo</span></div>
                <app-model-picker [value]="form.model || ''" (valueChange)="form.model = $event || null" etiquetaDefecto="Por defecto (Ajustes → Modelos por agente)" />

                <h4 style="margin-top:18px">Herramientas <small class="dim">código JS en sandbox: cuerpo de <code>async (args, ctx) => {{ '{' }} … return … {{ '}' }}</code></small></h4>
                @for (t of form.tools; track $index; let i = $index) {
                  <details class="tool" [open]="form.tools.length <= 3">
                    <summary>
                      <code>{{ t.name || '(sin nombre)' }}</code>
                      <span class="dim">{{ t.description.slice(0, 80) }}</span>
                      <span class="spacer"></span>
                      <button type="button" class="btn-secondary sm" (click)="$event.preventDefault(); probarTool(a, t)"><i class="ph ph-play"></i> Probar</button>
                      <button type="button" class="btn-icon danger" (click)="$event.preventDefault(); form.tools.splice(i, 1)"><i class="ph ph-trash"></i></button>
                    </summary>
                    <div class="grid2">
                      <label class="field"><span>Nombre (snake_case)</span><input type="text" [(ngModel)]="t.name" /></label>
                      <label class="field"><span>Descripción</span><input type="text" [(ngModel)]="t.description" /></label>
                    </div>
                    <label class="field"><span>Parámetros (JSON Schema)</span><textarea rows="4" class="mono" [ngModel]="paramsTxt[i] ?? json(t.parameters)" (ngModelChange)="paramsTxt[i] = $event"></textarea></label>
                    <label class="field"><span>Código</span><textarea rows="8" class="mono" [(ngModel)]="t.code"></textarea></label>
                    <div class="row" style="gap:16px;flex-wrap:wrap">
                      <label class="check"><input type="checkbox" [(ngModel)]="t.network" /><span>Puede usar red (<code>ctx.fetch</code>, solo https)</span></label>
                      <label class="field" style="flex:1;min-width:220px;margin:0"><span>Args de prueba (JSON)</span><input type="text" class="mono" [(ngModel)]="testArgs[t.name]" placeholder='{"km": 100}' /></label>
                    </div>
                    @if (testOut[t.name]; as r) {
                      <pre class="out" [class.bad]="!r.ok">{{ r.ok ? json(r.result) : r.error }}@if (r.logs?.length) {{{ '\n' }}logs: {{ r.logs.join(' | ') }}}</pre>
                    }
                  </details>
                }
                <button type="button" class="btn-secondary sm" (click)="agregarTool()"><i class="ph ph-plus"></i> Agregar herramienta</button>

                <h4 style="margin-top:18px">Variables de entorno <small class="dim">se guardan en el .env como <code>AGENT_{{ a.name.toUpperCase() }}_&lt;NOMBRE&gt;</code></small></h4>
                @for (e of form.env; track $index; let i = $index) {
                  <div class="env-row">
                    <input type="text" class="mono" [(ngModel)]="e.name" placeholder="NOMBRE" style="max-width:220px" />
                    <input type="text" [(ngModel)]="e.description" placeholder="Para qué es" />
                    <input [type]="e.secret ? 'password' : 'text'" [(ngModel)]="envValores[e.name]" [placeholder]="envActual[a.name + ':' + e.name] ? 'actual: ' + envActual[a.name + ':' + e.name] + ' (vacío = sin cambio)' : 'sin valor'" />
                    <label class="check" style="margin:0"><input type="checkbox" [(ngModel)]="e.secret" /><span>secreto</span></label>
                    <button type="button" class="btn-icon danger" (click)="form.env.splice(i, 1)"><i class="ph ph-trash"></i></button>
                  </div>
                }
                <button type="button" class="btn-secondary sm" (click)="form.env.push({ name: '', description: '', secret: true })"><i class="ph ph-plus"></i> Agregar variable</button>

                <div class="row" style="margin-top:18px">
                  <span class="spacer"></span>
                  <button class="btn-secondary" (click)="abierto.set(null)">Cancelar</button>
                  <button class="btn-primary" [disabled]="guardando()" (click)="guardar(a)"><i class="ph ph-floppy-disk"></i> Guardar y remontar</button>
                </div>
              </div>
            }
          </div>
        }
      }
    </div>

    @if (modalIA()) {
      <div class="modal-backdrop" (click)="cerrarIA()">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head"><h3><i class="ph ph-sparkle"></i> Crear agente con IA</h3><button class="btn-icon" (click)="cerrarIA()"><i class="ph ph-x"></i></button></div>
          <div class="modal-body">
            <label class="field">
              <span>Describe el agente: nombre, personalidad y qué debe saber hacer</span>
              <textarea rows="6" [(ngModel)]="promptIA" placeholder="Crea un agente que me ayude en los estudios de vuelo. Debe convertir km a millas náuticas, pies a metros y calcular el top of descent (regla 3:1). Se llama Nami y tiene la personalidad de un instructor de vuelo: preciso y didáctico."></textarea>
            </label>
            @if (generando()) { <div class="empty"><span class="spinner"></span> El agente programador está escribiendo las herramientas y corriendo sus tests… (30–90 s)</div> }
            @if (resultadoIA(); as r) {
              <div class="md-out md" [innerHTML]="r.respuesta | markdown"></div>
              @if (r.pasos.length) { <details style="margin-top:10px"><summary class="dim">Pasos ({{ r.pasos.length }})</summary><pre class="out">{{ r.pasos.join('\n') }}</pre></details> }
            }
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="cerrarIA()">Cerrar</button>
            <button class="btn-primary" [disabled]="!promptIA.trim() || generando()" (click)="generar()"><i class="ph ph-sparkle"></i> Crear</button>
          </div>
        </div>
      </div>
    }

    @if (prueba(); as p) {
      <div class="modal-backdrop" (click)="prueba.set(null)">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head"><h3>Probar a {{ p.agent.displayName }}</h3><button class="btn-icon" (click)="prueba.set(null)"><i class="ph ph-x"></i></button></div>
          <div class="modal-body">
            <p class="card-sub">Conversación directa con el agente, sin pasar por el Coordinator. Cada mensaje es un turno aislado.</p>
            @for (m of p.mensajes; track $index) {
              <div class="msg" [class.yo]="m.rol === 'yo'">
                @if (m.rol === 'yo') { <div class="burbuja">{{ m.texto }}</div> } @else { <div class="burbuja md" [innerHTML]="m.texto | markdown"></div> }
                @if (m.pasos?.length) { <details><summary class="dim">{{ m.pasos!.length }} paso(s)</summary><pre class="out">{{ m.pasos!.join('\n') }}</pre></details> }
              </div>
            }
            <div class="row" style="margin-top:10px">
              <input type="text" [(ngModel)]="textoPrueba" placeholder="Ej: ¿cuántas millas náuticas son 120 km?" (keydown.enter)="enviarPrueba()" [disabled]="probando()" />
              <button class="btn-primary" (click)="enviarPrueba()" [disabled]="!textoPrueba.trim() || probando()"><i class="ph ph-paper-plane-tilt"></i></button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .ag { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
    .ag.off { opacity: .65; }
    .ag-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
    .ag-title { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
    .ag-title > i { font-size: 28px; color: var(--accent-primary); }
    .ag-title h3 { font-size: 17px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .ag-title p { color: var(--text-dim); font-size: 13.5px; margin-top: 2px; max-width: 70ch; }
    .slug { font-size: 12px; color: var(--text-dim); font-weight: 400; }
    .ag-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .tb { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; background: var(--bg-main); color: var(--text-dim); }
    .tb.ok { background: rgba(16,185,129,.16); color: var(--ok); }
    .tb.chan { background: rgba(251,146,60,.14); color: #fdba74; }
    .tb.mem { background: rgba(168,85,247,.16); color: #c084fc; }
    .tb.dim { text-transform: none; letter-spacing: 0; font-weight: 500; }
    .ta { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border-light); background: var(--bg-main); color: var(--text-dim); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; }
    .ta:hover, .ta.on { border-color: var(--accent-primary); color: var(--accent-primary); }
    .ta.del:hover { border-color: var(--danger); color: var(--danger); }
    .ag-tools { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .tool-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: var(--bg-input); border: 1px solid var(--border-light); font-size: 12.5px; font-family: monospace; }
    .tool-chip i { color: var(--accent-primary); }
    .editor { margin-top: 16px; padding-top: 16px; border-top: 1px dashed var(--border-light); }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
    @media (max-width: 700px) { .grid2 { grid-template-columns: 1fr; } }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
    .tool { border: 1px solid var(--border-light); border-radius: 10px; margin-bottom: 10px; background: var(--bg-main); padding: 0 14px; }
    .tool summary { display: flex; align-items: center; gap: 10px; padding: 10px 0; cursor: pointer; }
    .tool summary code { font-size: 13px; }
    .tool > .grid2, .tool > .field, .tool > .row { margin-top: 6px; }
    .btn-secondary.sm { padding: 6px 10px; font-size: 12px; }
    .btn-icon.danger:hover { color: var(--danger); }
    .out { margin: 8px 0 12px; padding: 10px 12px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border-light); font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
    .out.bad { border-color: rgba(239,68,68,.5); color: var(--danger); }
    .env-row { display: grid; grid-template-columns: 220px 1fr 1fr auto auto; gap: 8px; align-items: center; margin-bottom: 8px; }
    @media (max-width: 900px) { .env-row { grid-template-columns: 1fr; } }
    .check { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; font-size: 13.5px; margin: 6px 0 12px; }
    .check input { margin-top: 3px; width: 15px; height: 15px; accent-color: var(--accent-primary); }
    .dim { color: var(--text-dim); font-size: 12.5px; font-weight: 400; }
    .md-out { font-size: 14px; padding: 12px 14px; border-radius: 10px; background: var(--bg-main); border: 1px solid var(--border-light); }
    .msg { display: flex; flex-direction: column; align-items: flex-start; margin-bottom: 10px; }
    .msg.yo { align-items: flex-end; }
    .burbuja { max-width: 90%; padding: 10px 14px; border-radius: 12px; background: var(--bg-main); white-space: pre-wrap; font-size: 14px; }
    .msg.yo .burbuja { background: var(--accent-primary); color: #fff; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border-light); border-top-color: var(--accent-primary); border-radius: 50%; animation: sp .8s linear infinite; margin-right: 8px; vertical-align: middle; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .empty-state { text-align: center; padding: 40px 20px; }
    .empty-state i { font-size: 40px; color: var(--accent-primary); }
    .empty-state p { color: var(--text-dim); max-width: 60ch; margin: 8px auto 16px; }
  `],
})
export class AgentsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  agents = signal<CustomAgent[]>([]);
  cargado = signal(false);
  abierto = signal<string | null>(null);
  guardando = signal(false);
  modalIA = signal(false);
  generando = signal(false);
  resultadoIA = signal<{ respuesta: string; pasos: string[] } | null>(null);
  prueba = signal<{ agent: CustomAgent; mensajes: Array<{ rol: 'yo' | 'agente'; texto: string; pasos?: string[] }> } | null>(null);
  probando = signal(false);
  canales = CANALES;
  form: CustomAgent | null = null;
  paramsTxt: Record<number, string> = {};
  testArgs: Record<string, string> = {};
  testOut: Record<string, any> = {};
  envValores: Record<string, string> = {};
  envActual: Record<string, string> = {};
  promptIA = '';
  textoPrueba = '';

  constructor() { this.load(); this.cargarEnv(); }

  load() {
    this.api.getAgents().subscribe({
      next: (r) => { this.agents.set(r.agents); this.cargado.set(true); this.cdr.markForCheck(); },
      error: (e) => { this.cargado.set(true); this.toast.error(e?.error?.error || 'No se pudieron cargar los agentes'); },
    });
  }
  private cargarEnv() {
    this.api.getEnv().subscribe({ next: (r) => {
      for (const v of r.vars as EnvVar[]) {
        const m = v.key.match(/^AGENT_([A-Z0-9_]+?)_([A-Z][A-Z0-9_]*)$/);
        if (m && v.valor) {
          // AGENT_<NAME>_<VAR>: el nombre puede llevar _, así que se prueba contra los agentes conocidos
          for (const a of this.agents()) if (v.key.startsWith(`AGENT_${a.name.toUpperCase()}_`)) this.envActual[`${a.name}:${v.key.slice(`AGENT_${a.name.toUpperCase()}_`.length)}`] = v.valor;
        }
      }
      this.cdr.markForCheck();
    }, error: () => {} });
  }

  nombreCanal(c: CanalAgente) { return CANALES.find((x) => x.id === c)?.nombre || c; }
  json(x: any) { try { return JSON.stringify(x, null, 2); } catch { return String(x); } }

  toggle(a: CustomAgent) {
    if (this.abierto() === a.name) { this.abierto.set(null); return; }
    this.form = JSON.parse(JSON.stringify(a));
    this.paramsTxt = {}; this.testOut = {}; this.envValores = {};
    this.abierto.set(a.name);
    this.cargarEnv();
  }
  toggleCanal(c: CanalAgente) {
    if (!this.form) return;
    this.form.channels = this.form.channels.includes(c) ? this.form.channels.filter((x) => x !== c) : [...this.form.channels, c];
  }
  agregarTool() {
    this.form?.tools.push({ name: '', description: '', parameters: { type: 'object', properties: {}, required: [] }, code: '// args.x …\nreturn { ok: true };', network: false, tests: [] });
  }

  guardar(a: CustomAgent) {
    if (!this.form) return;
    // Parámetros editados como texto → objeto
    for (const [i, txt] of Object.entries(this.paramsTxt)) {
      try { this.form.tools[Number(i)].parameters = JSON.parse(txt); }
      catch { this.toast.error(`Parámetros de la herramienta #${Number(i) + 1}: JSON inválido`); return; }
    }
    this.guardando.set(true);
    const { name, createdAt, createdBy, updatedAt, version, ...cambios } = this.form;
    this.api.updateAgent(a.name, cambios).subscribe({
      next: () => {
        // Valores de variables (solo los que se escribieron)
        const patch: Record<string, string> = {};
        for (const e of this.form!.env) { const v = (this.envValores[e.name] || '').trim(); if (v) patch[`AGENT_${a.name.toUpperCase()}_${e.name}`] = v; }
        const fin = () => { this.guardando.set(false); this.abierto.set(null); this.toast.ok('Agente guardado y remontado'); this.load(); this.cargarEnv(); };
        if (Object.keys(patch).length) this.api.saveEnv(patch).subscribe({ next: fin, error: () => { this.toast.error('Agente guardado, pero no se pudieron escribir las variables'); fin(); } });
        else fin();
      },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); },
    });
  }
  alternar(a: CustomAgent) {
    this.api.updateAgent(a.name, { enabled: !a.enabled }).subscribe({ next: () => this.load(), error: (e) => this.toast.error(e?.error?.error || 'No se pudo') });
  }
  eliminar(a: CustomAgent) {
    if (!confirm(`¿Eliminar a ${a.displayName}? Se borra su definición, herramientas y memoria.`)) return;
    this.api.deleteAgent(a.name).subscribe({ next: () => { this.toast.ok('Eliminado'); this.load(); }, error: () => this.toast.error('No se pudo eliminar') });
  }
  probarTool(a: CustomAgent, t: CustomToolDef) {
    let args: any = {};
    try { args = JSON.parse(this.testArgs[t.name] || '{}'); } catch { this.toast.error('Args de prueba: JSON inválido'); return; }
    // Prueba lo guardado (si editaste el código, guarda primero)
    this.api.testAgentTool(a.name, t.name, args).subscribe({
      next: (r) => { this.testOut[t.name] = r; this.cdr.markForCheck(); },
      error: (e) => { this.testOut[t.name] = { ok: false, error: e?.error?.error || 'Error' }; this.cdr.markForCheck(); },
    });
  }

  abrirNuevo() {
    const name = prompt('Nombre corto del agente (minúsculas, sin espacios), p. ej. nami:');
    if (!name) return;
    this.api.createAgent({ name: name.trim().toLowerCase(), displayName: name.trim(), description: 'Describe cuándo debe usarlo el Coordinator.', soul: 'Eres un asistente especializado. Describe aquí tu personalidad y cómo trabajas.', tools: [], env: [], memory: false, channels: ['telegram', 'api'], model: null } as any).subscribe({
      next: (r) => { this.load(); setTimeout(() => this.toggle(r.agent), 300); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo crear'),
    });
  }

  cerrarIA() { if (!this.generando()) { this.modalIA.set(false); this.resultadoIA.set(null); } }
  generar() {
    this.generando.set(true); this.resultadoIA.set(null);
    this.api.generateAgent(this.promptIA.trim()).subscribe({
      next: (r) => { this.generando.set(false); this.resultadoIA.set({ respuesta: r.respuesta, pasos: r.pasos }); this.agents.set(r.agents); if (r.nuevos.length) this.toast.ok(`Agente creado: ${r.nuevos.join(', ')}`); this.cdr.markForCheck(); },
      error: (e) => { this.generando.set(false); this.toast.error(e?.error?.error || 'No se pudo crear'); },
    });
  }

  abrirPrueba(a: CustomAgent) { this.prueba.set({ agent: a, mensajes: [] }); this.textoPrueba = ''; }
  enviarPrueba() {
    const p = this.prueba(); const t = this.textoPrueba.trim();
    if (!p || !t) return;
    this.textoPrueba = ''; this.probando.set(true);
    this.prueba.set({ ...p, mensajes: [...p.mensajes, { rol: 'yo', texto: t }] });
    this.api.chatAgent(p.agent.name, t).subscribe({
      next: (r) => { const z = this.prueba()!; this.prueba.set({ ...z, mensajes: [...z.mensajes, { rol: 'agente', texto: r.respuesta || '(sin respuesta)', pasos: r.pasos }] }); this.probando.set(false); },
      error: (e) => { const z = this.prueba()!; this.prueba.set({ ...z, mensajes: [...z.mensajes, { rol: 'agente', texto: `Error: ${e?.error?.error || 'falló'}` }] }); this.probando.set(false); },
    });
  }
}
