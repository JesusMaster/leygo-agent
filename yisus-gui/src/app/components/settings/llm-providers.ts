import { ChangeDetectorRef, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, LlmProvider, LlmProviderInput, ProviderKind, ProviderPreset } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

const ICONO_KIND: Record<ProviderKind, string> = {
  gemini: 'ph-google-logo', openai: 'ph-open-ai-logo', anthropic: 'ph-brain', ollama: 'ph-desktop', openai_compatible: 'ph-plugs-connected',
};
const NOMBRE_KIND: Record<ProviderKind, string> = {
  gemini: 'Google Gemini', openai: 'OpenAI', anthropic: 'Anthropic', ollama: 'Ollama', openai_compatible: 'Compatible OpenAI',
};

type Prueba = { ok: boolean; ms: number; respuesta?: string; error?: string; modelo?: string };

/** Tarjetas de proveedores + modal para agregar/editar con presets. */
@Component({
  selector: 'app-llm-providers',
  imports: [FormsModule],
  template: `
    <div class="card">
      <div class="head">
        <div>
          <h3>Proveedores de LLM</h3>
          <p class="card-sub">
            Las keys se guardan en la base del agente y nunca vuelven completas a la GUI.
            @if (porDefecto() > 0) { <b>{{ porDefecto() }}</b> agente{{ porDefecto() === 1 ? ' usa' : 's usan' }} el Gemini del <code>.env</code> (modelo por defecto). }
          </p>
        </div>
        <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Agregar proveedor</button>
      </div>

      @if (providers().length === 0) {
        <div class="vacio">
          <i class="ph ph-cpu"></i>
          <p>Sin proveedores. Agrega uno para elegir otro modelo en algún agente o para tener un respaldo si Gemini falla.</p>
          <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Agregar proveedor</button>
        </div>
      } @else {
        <div class="prov-grid">
          @for (p of providers(); track p.id) {
            <div class="prov" [class.off]="!p.enabled">
              <div class="prov-head">
                <span class="ico k-{{ p.kind }}"><i class="ph {{ icono(p.kind) }}"></i></span>
                <div class="prov-nombre">
                  <strong>{{ p.name }}</strong>
                  <small>{{ nombreKind(p.kind) }}@if (p.baseUrl) { · {{ host(p.baseUrl) }} }</small>
                </div>
                <label class="switch" [title]="p.enabled ? 'Activo: clic para apagar' : 'Apagado: clic para activar'">
                  <input type="checkbox" [checked]="p.enabled" (change)="toggle(p, $any($event.target).checked)" />
                  <span></span>
                </label>
              </div>

              <div class="prov-meta">
                @if (p.tieneKey) { <span class="tag ok" title="API key guardada"><i class="ph ph-key"></i> {{ p.apiKeyMask }}</span> }
                @else if (necesitaKey(p.kind)) { <span class="tag warn"><i class="ph ph-warning"></i> falta API key</span> }
                @else { <span class="tag">local, sin key</span> }
                <span class="tag" [class.uso]="usos(p.id) > 0">
                  @if (usos(p.id) > 0) { {{ usos(p.id) }} agente{{ usos(p.id) === 1 ? '' : 's' }} } @else { sin agentes asignados }
                </span>
                @if (!p.enabled) { <span class="tag">apagado</span> }
              </div>

              @if (ocupado()[p.id]) {
                <div class="res wait"><i class="ph ph-spinner"></i><span>Probando{{ probandoModelo()[p.id] ? ' ' + probandoModelo()[p.id] : '' }}…</span></div>
              } @else if (prueba()[p.id]; as r) {
                <div class="res" [class.ok]="r.ok" [class.bad]="!r.ok">
                  <i class="ph" [class.ph-check-circle]="r.ok" [class.ph-x-circle]="!r.ok"></i>
                  <div class="res-t">
                    @if (r.ok) { <span><b>{{ r.modelo }}</b> respondió en {{ r.ms }} ms</span> }
                    @else {
                      @if (r.modelo) { <b>{{ r.modelo }}</b> }
                      <span class="err" [class.full]="errAbierto()[p.id]" (click)="alternarErr(p.id)" [title]="errAbierto()[p.id] ? '' : 'Ver completo'">{{ r.error }}</span>
                      <button class="link" (click)="abrirEditar(p)">Probar con otro modelo</button>
                    }
                  </div>
                </div>
              }

              <div class="prov-actions">
                <button class="btn-secondary sm" (click)="probarRapido(p)" [disabled]="ocupado()[p.id] || !p.enabled" title="Le hace una pregunta corta a un modelo de chat del proveedor">
                  <i class="ph" [class.ph-lightning]="!ocupado()[p.id]" [class.ph-spinner]="ocupado()[p.id]"></i> Probar
                </button>
                <button class="btn-secondary sm" (click)="verModelos(p)" [disabled]="cargandoModelos() === p.id">
                  <i class="ph" [class.ph-list]="cargandoModelos() !== p.id" [class.ph-spinner]="cargandoModelos() === p.id"></i>
                  Modelos@if (modelosDe()[p.id]; as ms) { <span class="n">{{ ms.length }}</span> }
                </button>
                <button class="btn-secondary sm" (click)="abrirEditar(p)"><i class="ph ph-pencil-simple"></i> Editar</button>
              </div>

              @if (abiertos()[p.id] && modelosDe()[p.id]; as ms) {
                <div class="modelos">
                  @if (ms.length === 0) { <small class="hint">El proveedor no devolvió modelos.</small> }
                  @for (m of ms; track m) { <code (click)="copiar(m)" title="Copiar id">{{ m }}</code> }
                </div>
              }
            </div>
          }
        </div>
      }
    </div>

    @if (modal()) {
      <div class="modal-backdrop" (click)="cerrar()">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head">
            <h3>{{ form.id ? 'Editar ' + form.name : 'Nuevo proveedor' }}</h3>
            <button class="btn-icon" (click)="cerrar()"><i class="ph ph-x"></i></button>
          </div>
          <div class="modal-body">
            @if (!form.id) {
              <div class="field">
                <span>Proveedor</span>
                <div class="presets">
                  @for (pr of presets(); track pr.id) {
                    <button type="button" class="preset" [class.on]="form.preset === pr.id" (click)="elegirPreset(pr)">
                      <i class="ph {{ icono(pr.kind) }}"></i>
                      <span>{{ pr.name }}<small>{{ pr.baseUrl ? host(pr.baseUrl) : pr.kind === 'gemini' ? 'API de Google' : 'URL propia' }}</small></span>
                    </button>
                  }
                </div>
              </div>
            }
            <label class="field">
              <span>Nombre</span>
              <input type="text" [(ngModel)]="form.name" placeholder="ej: OpenAI producción" />
            </label>
            @if (form.kind !== 'gemini') {
              <label class="field">
                <span>URL base @if (form.kind === 'anthropic') { <em>(opcional)</em> }</span>
                <input type="text" [(ngModel)]="form.baseUrl" [placeholder]="placeholderUrl()" />
              </label>
            }
            <label class="field">
              <span>API key @if (form.id) { <em>(vacío = conservar {{ keyActual() || 'la actual' }})</em> } @else if (!presetActual()?.needsKey) { <em>(opcional)</em> }</span>
              <input type="password" [(ngModel)]="form.apiKey" autocomplete="new-password" placeholder="sk-…" />
              @if (presetActual()?.keysUrl) { <small class="hint">Consíguela en <a [href]="presetActual()!.keysUrl" target="_blank" rel="noopener">{{ host(presetActual()!.keysUrl!) }}</a></small> }
            </label>
            @if (presetActual()?.hint) { <p class="hint"><i class="ph ph-info"></i> {{ presetActual()!.hint }}</p> }

            @if (form.id) {
              <div class="probar-box">
                <span class="lbl">Probar con un modelo</span>
                <div class="probar-row">
                  <input type="text" [(ngModel)]="modeloPrueba" list="modelos-modal" placeholder="id del modelo" (focus)="cargarModelosModal()" />
                  <datalist id="modelos-modal">@for (m of modelosDe()[form.id!] || []; track m) { <option [value]="m"></option> }</datalist>
                  <button class="btn-secondary" (click)="probar()" [disabled]="probando() || !modeloPrueba"><i class="ph" [class.ph-lightning]="!probando()" [class.ph-spinner]="probando()"></i> Probar</button>
                </div>
                <small class="hint">Prueba con la key guardada: si cambiaste la key, guarda primero.</small>
                @if (pruebaModal(); as pr) {
                  <div class="res" [class.ok]="pr.ok" [class.bad]="!pr.ok">
                    <i class="ph" [class.ph-check-circle]="pr.ok" [class.ph-x-circle]="!pr.ok"></i>
                    @if (pr.ok) { <span>Respondió en {{ pr.ms }} ms: “{{ pr.respuesta }}”</span> } @else { <span>{{ pr.error }}</span> }
                  </div>
                }
              </div>
            }
          </div>
          <div class="modal-foot">
            @if (form.id) { <button class="btn-borrar" (click)="eliminarDesdeModal()"><i class="ph ph-trash"></i> Eliminar</button><span class="spacer"></span> }
            <button class="btn-secondary" (click)="cerrar()">Cancelar</button>
            <button class="btn-primary" (click)="guardar()" [disabled]="guardando() || !form.name.trim()">{{ form.id ? 'Guardar' : 'Agregar y probar' }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
    .head > div { flex: 1 1 320px; min-width: 0; }
    .head .card-sub { margin-bottom: 0; }
    .vacio { text-align: center; padding: 28px 12px; color: var(--text-dim); }
    .vacio > i { font-size: 34px; }
    .vacio p { max-width: 420px; margin: 8px auto 14px; font-size: 13.5px; }

    .prov-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
    .prov { border: 1px solid var(--border-light); border-radius: 12px; padding: 14px; background: var(--bg-main); display: flex; flex-direction: column; gap: 12px; }
    .prov.off .prov-head, .prov.off .prov-meta { opacity: .55; }
    .prov-head { display: flex; align-items: center; gap: 12px; }
    .ico { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; font-size: 21px; background: rgba(129,140,248,.14); color: var(--accent-primary); flex-shrink: 0; }
    .prov-nombre { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .prov-nombre strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .prov-nombre small { color: var(--text-dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .prov-meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .tag { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border-light); color: var(--text-dim); }
    .tag.ok { color: var(--ok); border-color: rgba(16,185,129,.35); font-family: ui-monospace, monospace; font-size: 11.5px; }
    .tag.warn { color: var(--warn); border-color: rgba(245,158,11,.45); }
    .tag.uso { color: var(--text-main); }
    .prov-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: auto; }
    .btn-secondary.sm { padding: 6px 10px; font-size: 12.5px; display: inline-flex; align-items: center; gap: 5px; }
    .n { font-size: 11px; padding: 0 6px; border-radius: 999px; background: var(--bg-input); }
    .btn-icon.danger:hover { color: var(--danger); }
    .res { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; padding: 8px 10px; border-radius: 8px; line-height: 1.4; }
    .res i { margin-top: 2px; }
    .res.ok { background: rgba(16,185,129,.1); color: var(--ok); }
    .res.bad { background: rgba(239,68,68,.1); color: var(--danger); word-break: break-word; }
    .res.wait { background: var(--bg-input); color: var(--text-dim); }
    .res-t { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .err { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
    .err.full { display: block; }
    .link { align-self: flex-start; background: none; border: none; padding: 0; color: var(--accent-primary); font-size: 12px; cursor: pointer; }
    .btn-borrar { background: none; border: none; color: var(--danger); font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; padding: 6px 4px; }
    .btn-borrar:hover { text-decoration: underline; }
    .modelos { display: flex; flex-wrap: wrap; gap: 6px; max-height: 150px; overflow: auto; padding-top: 10px; border-top: 1px dashed var(--border-light); }
    .modelos code { font-size: 11px; padding: 2px 7px; background: var(--bg-input); border-radius: 6px; cursor: copy; }
    .modelos code:hover { color: var(--accent-primary); }

    .switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .switch span { position: absolute; inset: 0; background: var(--border-light); border-radius: 999px; cursor: pointer; transition: .2s; }
    .switch span::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .2s; }
    .switch input:checked + span { background: var(--ok); }
    .switch input:checked + span::before { transform: translateX(16px); }

    .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
    .preset { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border-radius: 9px; border: 1px solid var(--border-light); background: var(--bg-input); color: var(--text-main); font-size: 13px; cursor: pointer; text-align: left; }
    .preset > span { display: flex; flex-direction: column; min-width: 0; }
    .preset small { color: var(--text-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .preset i { font-size: 19px; color: var(--text-dim); }
    .preset.on { border-color: var(--accent-primary); background: rgba(99,102,241,.12); }
    .preset.on i { color: var(--accent-primary); }
    .hint { color: var(--text-dim); font-size: 12px; margin-top: 6px; display: block; }
    .hint a { color: var(--accent-primary); }
    .probar-box { margin-top: 6px; padding: 12px; border-radius: 10px; border: 1px dashed var(--border-light); display: flex; flex-direction: column; gap: 8px; }
    .probar-box .lbl { font-size: 13px; color: var(--text-dim); }
    .probar-row { display: flex; gap: 8px; }
    .probar-row input { flex: 1; min-width: 0; }
    em { font-style: normal; opacity: .7; }
  `],
})
export class LlmProvidersComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  providers = input.required<LlmProvider[]>();
  presets = input.required<ProviderPreset[]>();
  usosPorProveedor = input<Record<string, number>>({});
  /** Agentes sin asignación: corren con el Gemini del .env. */
  porDefecto = input(0);
  cambio = output<void>();

  modal = signal(false);
  guardando = signal(false);
  probando = signal(false);
  pruebaModal = signal<Prueba | null>(null);
  prueba = signal<Record<string, Prueba>>({});
  ocupado = signal<Record<string, boolean>>({});
  probandoModelo = signal<Record<string, string>>({});
  errAbierto = signal<Record<string, boolean>>({});
  cargandoModelos = signal<string | null>(null);
  modelosDe = signal<Record<string, string[]>>({});
  abiertos = signal<Record<string, boolean>>({});
  modeloPrueba = '';
  form: LlmProviderInput = { name: '', kind: 'openai', baseUrl: '', apiKey: '', enabled: true, preset: 'openai' };

  icono(k: ProviderKind) { return ICONO_KIND[k]; }
  nombreKind(k: ProviderKind) { return NOMBRE_KIND[k]; }
  necesitaKey(k: ProviderKind) { return k === 'gemini' || k === 'openai' || k === 'anthropic'; }
  usos(id: string) { return this.usosPorProveedor()[id] || 0; }
  presetActual() { return this.presets().find((p) => p.id === this.form.preset); }
  placeholderUrl() { return this.presetActual()?.baseUrl || 'https://…/v1'; }
  keyActual() { return this.providers().find((p) => p.id === this.form.id)?.apiKeyMask; }
  host(u: string) { try { return new URL(u).host; } catch { return u; } }

  copiar(t: string) { navigator.clipboard.writeText(t).then(() => this.toast.ok(`Copiado: ${t}`), () => {}); }

  abrirNuevo() {
    const pr = this.presets().find((p) => p.id === 'openai') || this.presets()[0];
    this.form = { name: '', kind: 'openai', baseUrl: '', apiKey: '', enabled: true, preset: 'openai' };
    if (pr) this.elegirPreset(pr);
    this.pruebaModal.set(null);
    this.modal.set(true);
  }

  abrirEditar(p: LlmProvider) {
    this.form = { id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl || '', apiKey: '', enabled: p.enabled, preset: p.preset };
    this.modeloPrueba = this.prueba()[p.id]?.modelo || '';
    this.pruebaModal.set(null);
    this.modal.set(true);
  }

  elegirPreset(pr: ProviderPreset) {
    this.form.preset = pr.id;
    this.form.kind = pr.kind;
    this.form.baseUrl = pr.baseUrl || '';
    if (!this.form.name || this.presets().some((x) => x.name === this.form.name)) this.form.name = pr.name;
  }

  cerrar() { this.modal.set(false); }

  guardar() {
    this.guardando.set(true);
    const nuevo = !this.form.id;
    const data: LlmProviderInput = { ...this.form, name: this.form.name.trim(), baseUrl: this.form.baseUrl?.trim() || undefined, apiKey: this.form.apiKey?.trim() || undefined };
    this.api.saveLlmProvider(data).subscribe({
      next: (r: any) => {
        this.guardando.set(false); this.modal.set(false);
        this.toast.ok(nuevo ? 'Proveedor agregado' : 'Proveedor guardado');
        this.cambio.emit();
        // Al agregar, se prueba de inmediato: así se sabe al tiro si la key sirve.
        const id = r?.provider?.id || r?.id;
        if (nuevo && id) setTimeout(() => this.probarRapido({ ...(data as any), id, enabled: true }), 300);
        // La key pudo cambiar: los modelos y la prueba anteriores ya no valen.
        if (!nuevo && data.apiKey) this.olvidar(data.id!);
      },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); },
    });
  }

  private olvidar(id: string) {
    const m = { ...this.modelosDe() }; delete m[id]; this.modelosDe.set(m);
    const p = { ...this.prueba() }; delete p[id]; this.prueba.set(p);
  }

  toggle(p: LlmProvider, enabled: boolean) {
    this.api.saveLlmProvider({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, enabled }).subscribe({
      next: () => {
        const n = this.usos(p.id);
        this.toast.ok(enabled ? `${p.name} activo` : `${p.name} apagado${n ? `: ${n} agente${n === 1 ? '' : 's'} vuelve${n === 1 ? '' : 'n'} al modelo por defecto` : ''}`);
        this.cambio.emit();
      },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo cambiar'),
    });
  }

  eliminarDesdeModal() {
    const p = this.providers().find((x) => x.id === this.form.id);
    if (p) this.eliminar(p, () => this.modal.set(false));
  }

  eliminar(p: LlmProvider, alTerminar?: () => void) {
    const n = this.usos(p.id);
    if (!confirm(`¿Eliminar "${p.name}"?${n ? ` ${n} agente${n === 1 ? '' : 's'} volverá${n === 1 ? '' : 'n'} a Gemini por defecto.` : ''}`)) return;
    this.api.deleteLlmProvider(p.id).subscribe({
      next: () => { this.toast.ok('Proveedor eliminado'); alTerminar?.(); this.cambio.emit(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo eliminar'),
    });
  }

  verModelos(p: LlmProvider) {
    const abierto = !!this.abiertos()[p.id];
    this.abiertos.set({ ...this.abiertos(), [p.id]: !abierto });
    if (abierto || this.modelosDe()[p.id]) return;
    this.cargandoModelos.set(p.id);
    this.api.getLlmModels(p.id).subscribe({
      next: (r) => { this.cargandoModelos.set(null); this.modelosDe.set({ ...this.modelosDe(), [p.id]: r.models }); this.cdr.markForCheck(); },
      error: (e) => { this.cargandoModelos.set(null); this.abiertos.set({ ...this.abiertos(), [p.id]: false }); this.toast.error(e?.error?.error || 'No se pudieron listar los modelos'); },
    });
  }

  cargarModelosModal() {
    const id = this.form.id;
    if (!id || this.modelosDe()[id]) return;
    this.api.getLlmModels(id).subscribe({ next: (r) => { this.modelosDe.set({ ...this.modelosDe(), [id]: r.models }); this.cdr.markForCheck(); }, error: () => {} });
  }

  alternarErr(id: string) { this.errAbierto.set({ ...this.errAbierto(), [id]: !this.errAbierto()[id] }); }

  private marcar(id: string, v: boolean, modelo = '') {
    this.ocupado.set({ ...this.ocupado(), [id]: v });
    this.probandoModelo.set({ ...this.probandoModelo(), [id]: modelo });
  }

  /** Prueba con el último modelo que funcionó o con uno de chat liviano de su lista. */
  probarRapido(p: Pick<LlmProvider, 'id' | 'name'>) {
    this.marcar(p.id, true);
    this.errAbierto.set({ ...this.errAbierto(), [p.id]: false });
    const fijar = (r: Prueba) => { this.marcar(p.id, false); this.prueba.set({ ...this.prueba(), [p.id]: r }); this.cdr.markForCheck(); };
    const conModelo = (modelo: string) => {
      this.marcar(p.id, true, modelo);
      this.api.testLlm(p.id, modelo).subscribe({
        next: (r) => fijar({ ...r, modelo }),
        error: (e) => fijar({ ok: false, ms: 0, modelo, error: e?.error?.error || 'Error al probar' }),
      });
    };
    const previo = this.prueba()[p.id]?.ok ? this.prueba()[p.id].modelo : undefined;
    if (previo) { conModelo(previo); return; }
    this.api.getLlmModels(p.id).subscribe({
      next: (r) => {
        this.modelosDe.set({ ...this.modelosDe(), [p.id]: r.models });
        const modelo = elegirModeloDePrueba(r.models);
        if (!modelo) { fijar({ ok: false, ms: 0, error: 'Respondió, pero sin modelos de chat: revisa la key o descarga uno (Ollama).' }); return; }
        conModelo(modelo);
      },
      error: (e) => fijar({ ok: false, ms: 0, error: e?.error?.error || 'No se pudo conectar: revisa la URL y la key' }),
    });
  }

  probar() {
    if (!this.form.id || !this.modeloPrueba) return;
    this.probando.set(true);
    this.pruebaModal.set(null);
    const modelo = this.modeloPrueba.trim();
    this.api.testLlm(this.form.id, modelo).subscribe({
      next: (r) => { this.probando.set(false); this.pruebaModal.set(r); this.prueba.set({ ...this.prueba(), [this.form.id!]: { ...r, modelo } }); this.cdr.markForCheck(); },
      error: (e) => { this.probando.set(false); this.pruebaModal.set({ ok: false, ms: 0, error: e?.error?.error || 'Error al probar' }); },
    });
  }
}

/**
 * Modelo para la prueba rápida: de chat, liviano y estable. Se descartan los
 * especializados (computer use, imagen, audio, embeddings, realtime…), que
 * rechazan una pregunta de texto simple y harían parecer caído al proveedor.
 */
function elegirModeloDePrueba(ms: string[]): string | undefined {
  const NO_CHAT = /(embed|image|imagen|tts|audio|whisper|transcribe|speech|dall|moderation|rerank|veo|lyria|computer|robotics|live|native|realtime|search|aqa|learnlm|sora|codex|instruct|davinci|babbage|vision-preview|guard)/i;
  const chat = ms.filter((m) => !NO_CHAT.test(m));
  const lista = chat.length ? chat : ms;
  const puntaje = (m: string) =>
    (/(flash|mini|nano|haiku|small|turbo|lite|chat|kimi)/i.test(m) ? 4 : 0)
    + (/(preview|exp|beta|alpha|test)/i.test(m) ? 0 : 2)
    + (/(thinking|reason|r1|\bo\d|pro|opus|large)/i.test(m) ? 0 : 1)
    + version(m) / 100
    - m.length / 1000;
  return [...lista].sort((a, b) => puntaje(b) - puntaje(a))[0];
}

/** Versión aproximada del nombre (gemini-3.8-flash → 3.8, claude-haiku-4-5 → 4.5) para preferir la más nueva. */
function version(m: string): number {
  const x = m.match(/(\d+)(?:[.-](\d))?(?!\d{3})/);
  return x ? Number(`${x[1]}.${x[2] || 0}`) : 0;
}
