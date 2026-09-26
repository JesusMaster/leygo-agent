import { ChangeDetectorRef, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AgenteLlm, ApiService, LlmProvider } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { ModelPickerComponent } from '../model-picker/model-picker';

type Prueba = { ok: boolean; ms: number; respuesta?: string; error?: string };
interface Borrador { provider: string; model: string; respaldo: string; }
type Filtro = 'todos' | 'propios';

/** Lista agente → modelo principal + respaldo. Aplica en la siguiente llamada, sin reiniciar. */
@Component({
  selector: 'app-agent-models',
  imports: [FormsModule, ModelPickerComponent],
  template: `
    <div class="card">
      <div class="head">
        <div>
          <h3>Modelo por agente</h3>
          <p class="card-sub">Cada agente puede usar otro proveedor y tener su propio respaldo. Los cambios aplican en la siguiente llamada, sin reiniciar.</p>
        </div>
        <div class="filtros">
          <button class="chip" [class.on]="filtro() === 'todos'" (click)="filtro.set('todos')">Todos <span class="n">{{ agentes().length }}</span></button>
          <button class="chip" [class.on]="filtro() === 'propios'" (click)="filtro.set('propios')">Con modelo propio <span class="n">{{ propios() }}</span></button>
        </div>
      </div>

      @if (providers().length === 0) {
        <div class="aviso"><i class="ph ph-info"></i> Todos usan el Gemini del <code>.env</code>. Para asignar otro modelo o un respaldo, primero <a (click)="irProveedores.emit()">agrega un proveedor</a>.</div>
      }

      <!-- Respaldo global -->
      <div class="global" [class.editando]="editGlobal()">
        <span class="gi"><i class="ph ph-lifebuoy"></i></span>
        <div class="gtxt">
          <strong>Respaldo global</strong>
          <small>Si el modelo de un agente falla (cuota, 429, 503, sobrecarga), se reintenta con este. Conviene que sea de otro proveedor.</small>
        </div>
        @if (!editGlobal()) {
          @if (globalFallback(); as g) { <span class="mchip"><b>{{ nombreProv(partir(g)!.provider) }}</b><code>{{ partir(g)!.model }}</code></span> }
          @else { <span class="mchip vacio">sin respaldo</span> }
          <button class="btn-secondary sm" (click)="abrirGlobal()" [disabled]="providers().length === 0"><i class="ph ph-pencil-simple"></i> Cambiar</button>
        } @else {
          <div class="gedit">
            <app-model-picker [value]="borradorGlobal()" etiquetaDefecto="Sin respaldo" (valueChange)="borradorGlobal.set($event)" />
            <div class="acc">
              <button class="btn-secondary sm" (click)="editGlobal.set(false)">Cancelar</button>
              <button class="btn-primary sm" (click)="guardarGlobal()" [disabled]="!globalValido()">Guardar</button>
            </div>
          </div>
        }
      </div>

      <!-- Agentes -->
      <div class="lista">
        <div class="cab">
          <span>Agente</span><span>Modelo principal</span><span>Respaldo</span><span></span>
        </div>
        @for (a of visibles(); track a.name) {
          @let abierto = abiertoEn() === a.name;
          <div class="fila" [class.abierta]="abierto">
            <div class="ag">
              <strong>{{ a.titulo }}</strong>
              <small [title]="a.descripcion">{{ a.descripcion }}</small>
              @if (a.advertencia) { <span class="warn-tag"><i class="ph ph-warning"></i> {{ a.advertencia }}</span> }
            </div>
            <div class="celda" data-lbl="Principal">
              @if (a.assignment) {
                <span class="mchip propio" [class.caido]="caido(a)" [title]="caido(a) ? 'El proveedor está apagado o ya no existe: usa ' + a.efectivo.model : ''">
                  <b>{{ nombreProv(a.assignment.provider) }}</b><code>{{ a.assignment.model }}</code>
                  @if (caido(a)) { <i class="ph ph-warning"></i> }
                </span>
              } @else {
                <span class="mchip"><b>Gemini</b><code>{{ a.defaultModel }}</code><em>por defecto</em></span>
              }
            </div>
            <div class="celda" data-lbl="Respaldo">
              @if (a.fallbackEfectivo; as f) {
                <span class="mchip" [class.propio]="f.origen === 'agente'"><b>{{ nombreProv(f.provider) }}</b><code>{{ f.model }}</code>@if (f.origen === 'global') { <em>global</em> }</span>
              } @else {
                <span class="mchip vacio">sin respaldo</span>
              }
            </div>
            <div class="celda btn">
              <button class="btn-secondary sm" (click)="abrir(a)" [disabled]="providers().length === 0 && !a.assignment">
                @if (abierto) { Cerrar } @else { <i class="ph ph-sliders-horizontal"></i> Cambiar }
              </button>
            </div>

            @if (abierto) {
              <div class="editor">
                <div class="bloque">
                  <span class="lbl">Modelo principal</span>
                  <div class="par">
                    <select [ngModel]="borrador().provider" (ngModelChange)="cambiarProveedor($event)">
                      <option value="">Por defecto · Gemini {{ a.defaultModel }}</option>
                      @for (p of providers(); track p.id) { <option [value]="p.id" [disabled]="!p.enabled">{{ p.name }}{{ p.enabled ? '' : ' (apagado)' }}</option> }
                    </select>
                    <input type="text" [ngModel]="borrador().model" (ngModelChange)="set('model', $event)" [attr.list]="'mods-' + a.name"
                      [disabled]="!borrador().provider" [placeholder]="borrador().provider ? (cargando() ? 'cargando modelos…' : 'elige o escribe el id') : a.defaultModel" />
                    <datalist [id]="'mods-' + a.name">@for (m of modelos()[borrador().provider] || []; track m) { <option [value]="m"></option> }</datalist>
                  </div>
                  @if (borrador().provider && modelos()[borrador().provider]?.length && borrador().model && !modelos()[borrador().provider]!.includes(borrador().model)) {
                    <small class="hint warn"><i class="ph ph-warning"></i> Ese id no aparece en la lista del proveedor: pruébalo antes de guardar.</small>
                  }
                  @if (prueba(); as r) {
                    <div class="res" [class.ok]="r.ok" [class.bad]="!r.ok">
                      <i class="ph" [class.ph-check-circle]="r.ok" [class.ph-x-circle]="!r.ok"></i>
                      <span>@if (r.ok) { Respondió en {{ r.ms }} ms: “{{ r.respuesta }}” } @else { {{ r.error }} }</span>
                    </div>
                  }
                </div>
                <div class="bloque">
                  <span class="lbl">Respaldo de este agente</span>
                  <app-model-picker [value]="borrador().respaldo" [etiquetaDefecto]="etiquetaRespaldo()" (valueChange)="set('respaldo', $event)" />
                </div>
                <div class="pie">
                  <button class="btn-secondary sm" (click)="probar(a)" [disabled]="!borrador().provider || !borrador().model || probando()">
                    <i class="ph" [class.ph-lightning]="!probando()" [class.ph-spinner]="probando()"></i> Probar principal
                  </button>
                  <span class="spacer"></span>
                  <button class="btn-secondary sm" (click)="cerrar()">Cancelar</button>
                  <button class="btn-primary sm" (click)="guardar(a)" [disabled]="!sucio(a) || !valido() || guardando()">Guardar</button>
                </div>
              </div>
            }
          </div>
        } @empty {
          <div class="empty">Ningún agente tiene modelo propio: todos usan el por defecto.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
    .head > div:first-child { flex: 1 1 320px; min-width: 0; }
    .head .card-sub { margin-bottom: 0; }
    .filtros { display: flex; gap: 6px; }
    .chip .n { font-size: 11px; opacity: .7; margin-left: 4px; }
    .aviso { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; font-size: 13px; background: rgba(129,140,248,.08); border: 1px solid rgba(129,140,248,.35); }
    .aviso a { color: var(--accent-primary); cursor: pointer; text-decoration: underline; }

    .global { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px; border-radius: 12px; background: var(--bg-main); border: 1px solid var(--border-light); margin-bottom: 14px; }
    .gi { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: rgba(129,140,248,.14); color: var(--accent-primary); font-size: 19px; flex-shrink: 0; }
    .gtxt { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; }
    .gtxt small { color: var(--text-dim); font-size: 12px; }
    .gedit { flex-basis: 100%; display: flex; flex-direction: column; gap: 8px; }
    .acc { display: flex; justify-content: flex-end; gap: 8px; }

    .mchip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--border-light); background: var(--bg-main); font-size: 12.5px; min-width: 0; }
    .mchip b { font-weight: 600; white-space: nowrap; }
    .mchip code { font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .mchip em { font-style: normal; font-size: 11px; color: var(--text-dim); border-left: 1px solid var(--border-light); padding-left: 6px; white-space: nowrap; }
    .mchip.propio { border-color: rgba(129,140,248,.5); background: rgba(129,140,248,.08); }
    .mchip.propio code { color: var(--text-main); }
    .mchip.caido { border-color: rgba(245,158,11,.55); }
    .mchip.caido i { color: var(--warn); }
    .mchip.vacio { color: var(--text-dim); border-style: dashed; }

    .lista { border: 1px solid var(--border-light); border-radius: 12px; overflow: hidden; }
    .cab, .fila { display: grid; grid-template-columns: minmax(200px, 1.3fr) minmax(170px, 1fr) minmax(170px, 1fr) 100px; gap: 14px; align-items: center; padding: 11px 14px; }
    .cab { background: var(--bg-main); font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); padding-top: 9px; padding-bottom: 9px; }
    .fila { border-top: 1px solid var(--border-light); }
    .fila.abierta { background: rgba(129,140,248,.05); }
    .ag { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .ag small { color: var(--text-dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .warn-tag { font-size: 11.5px; color: var(--warn); }
    .celda { min-width: 0; }
    .celda.btn { text-align: right; }
    .btn-secondary.sm, .btn-primary.sm { padding: 6px 11px; font-size: 12.5px; display: inline-flex; align-items: center; gap: 5px; }

    .editor { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 14px; margin-top: 2px; border-radius: 10px; background: var(--bg-card); border: 1px solid var(--border-light); }
    .bloque { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .lbl { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: .04em; }
    .par { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .par input:disabled { opacity: .55; }
    .pie { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; padding-top: 12px; border-top: 1px solid var(--border-light); }
    .hint { font-size: 12px; color: var(--text-dim); }
    .hint.warn { color: var(--warn); }
    .res { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; padding: 8px 10px; border-radius: 8px; line-height: 1.4; }
    .res i { margin-top: 2px; }
    .res.ok { background: rgba(16,185,129,.1); color: var(--ok); }
    .res.bad { background: rgba(239,68,68,.1); color: var(--danger); word-break: break-word; }

    @media (max-width: 900px) {
      .cab { display: none; }
      .fila { grid-template-columns: 1fr auto; gap: 8px 12px; }
      .ag { grid-column: 1 / -1; }
      .ag small { white-space: normal; }
      .celda[data-lbl] { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; }
      .celda[data-lbl]::before { content: attr(data-lbl); font-size: 11.5px; color: var(--text-dim); width: 64px; flex-shrink: 0; }
      .celda.btn { grid-column: 1 / -1; text-align: left; }
      .editor { grid-template-columns: 1fr; }
      .par { grid-template-columns: 1fr; }
    }
  `],
})
export class AgentModelsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  providers = input.required<LlmProvider[]>();
  agentes = input.required<AgenteLlm[]>();
  cambio = output<void>();
  irProveedores = output<void>();

  filtro = signal<Filtro>('todos');
  abiertoEn = signal<string | null>(null);
  borrador = signal<Borrador>({ provider: '', model: '', respaldo: '' });
  modelos = signal<Record<string, string[]>>({});
  cargando = signal(false);
  probando = signal(false);
  guardando = signal(false);
  prueba = signal<Prueba | null>(null);

  globalFallback = signal<string>('');
  editGlobal = signal(false);
  borradorGlobal = signal('');

  propios = computed(() => this.agentes().filter((a) => a.assignment || a.fallback).length);
  visibles = computed(() => this.filtro() === 'todos' ? this.agentes() : this.agentes().filter((a) => a.assignment || a.fallback));
  globalValido = computed(() => { const g = this.borradorGlobal(); return !g || !!this.partir(g)?.model; });
  valido = computed(() => {
    const b = this.borrador();
    return (!b.provider || !!b.model.trim()) && (!b.respaldo || !!this.partir(b.respaldo)?.model);
  });

  ngOnChanges() {
    this.api.getGlobalFallback().subscribe({ next: (r) => { this.globalFallback.set(r.fallback ? `${r.fallback.provider}/${r.fallback.model}` : ''); this.cdr.markForCheck(); }, error: () => {} });
  }

  nombreProv(id: string) { return this.providers().find((p) => p.id === id)?.name || id; }
  caido(a: AgenteLlm) { return !!a.assignment && (a.efectivo.provider !== a.assignment.provider || a.efectivo.model !== a.assignment.model); }
  etiquetaRespaldo() { const g = this.globalFallback(); return g ? `Usar el global (${this.partir(g)!.model})` : 'Sin respaldo'; }

  partir(ref: string): { provider: string; model: string } | null {
    const i = (ref || '').indexOf('/');
    return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : null;
  }
  private ref(x?: { provider: string; model: string } | null) { return x ? `${x.provider}/${x.model}` : ''; }

  abrirGlobal() { this.borradorGlobal.set(this.globalFallback()); this.editGlobal.set(true); }

  guardarGlobal() {
    const ref = this.borradorGlobal();
    this.api.setGlobalFallback(this.partir(ref)).subscribe({
      next: () => { this.globalFallback.set(ref || ''); this.editGlobal.set(false); this.toast.ok(ref ? 'Respaldo global guardado' : 'Respaldo global quitado'); this.cambio.emit(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo guardar'),
    });
  }

  abrir(a: AgenteLlm) {
    if (this.abiertoEn() === a.name) return this.cerrar();
    this.abiertoEn.set(a.name);
    this.prueba.set(null);
    this.borrador.set({ provider: a.assignment?.provider || '', model: a.assignment?.model || '', respaldo: this.ref(a.fallback) });
    if (a.assignment) this.cargarModelos(a.assignment.provider);
  }
  cerrar() { this.abiertoEn.set(null); this.prueba.set(null); }

  set(campo: keyof Borrador, v: string) { this.borrador.set({ ...this.borrador(), [campo]: v }); if (campo === 'model') this.prueba.set(null); }

  cambiarProveedor(provider: string) {
    this.borrador.set({ ...this.borrador(), provider, model: '' });
    this.prueba.set(null);
    this.cargarModelos(provider);
  }

  cargarModelos(providerId: string) {
    if (!providerId || this.modelos()[providerId]) return;
    this.cargando.set(true);
    this.api.getLlmModels(providerId).subscribe({
      next: (r) => { this.cargando.set(false); this.modelos.set({ ...this.modelos(), [providerId]: r.models }); this.cdr.markForCheck(); },
      error: () => { this.cargando.set(false); this.modelos.set({ ...this.modelos(), [providerId]: [] }); },
    });
  }

  sucio(a: AgenteLlm) {
    const b = this.borrador();
    const principal = b.provider ? `${b.provider}/${b.model.trim()}` : '';
    return principal !== this.ref(a.assignment) || b.respaldo !== this.ref(a.fallback);
  }

  async guardar(a: AgenteLlm) {
    const b = this.borrador();
    const principal = b.provider && b.model.trim() ? { provider: b.provider, model: b.model.trim() } : null;
    this.guardando.set(true);
    try {
      // En serie: ambas rutas reescriben la misma configuración en el backend.
      if (this.ref(principal) !== this.ref(a.assignment)) await firstValueFrom(this.api.setLlmAssignment(a.name, principal));
      if (b.respaldo !== this.ref(a.fallback)) await firstValueFrom(this.api.setLlmFallback(a.name, this.partir(b.respaldo)));
      this.toast.ok(`${a.titulo}: guardado`);
      this.cerrar();
      this.cambio.emit();
    } catch (e: any) {
      this.toast.error(e?.error?.error || 'No se pudo guardar');
    } finally {
      this.guardando.set(false);
    }
  }

  probar(a: AgenteLlm) {
    const b = this.borrador();
    this.probando.set(true);
    this.prueba.set(null);
    this.api.testLlm(b.provider, b.model.trim()).subscribe({
      next: (r) => { this.probando.set(false); this.prueba.set(r); this.cdr.markForCheck(); },
      error: (e) => { this.probando.set(false); this.prueba.set({ ok: false, ms: 0, error: e?.error?.error || 'Error' }); },
    });
  }
}
