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

/** Tarjetas de proveedores + modal para agregar/editar (con presets al estilo Leygo). */
@Component({
  selector: 'app-llm-providers',
  imports: [FormsModule],
  template: `
    <div class="card">
      <div class="row head">
        <div>
          <h3>Proveedores de LLM</h3>
          <p class="card-sub" style="margin-bottom:0">Las keys se guardan en la base del agente (nunca vuelven completas a la GUI). Un proveedor apagado deja a sus agentes en Gemini por defecto.</p>
        </div>
        <span class="spacer"></span>
        <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Agregar proveedor</button>
      </div>

      @if (providers().length === 0) {
        <div class="empty">Sin proveedores. Agrega uno para poder elegir modelos por agente.</div>
      } @else {
        <div class="prov-grid">
          @for (p of providers(); track p.id) {
            <div class="prov" [class.off]="!p.enabled">
              <div class="prov-head">
                <i class="ph {{ icono(p.kind) }}"></i>
                <div class="prov-nombre">
                  <strong>{{ p.name }}</strong>
                  <small>{{ nombreKind(p.kind) }}@if (p.baseUrl) { · {{ p.baseUrl }} }</small>
                </div>
                <label class="switch" title="{{ p.enabled ? 'Activo' : 'Desactivado' }}">
                  <input type="checkbox" [checked]="p.enabled" (change)="toggle(p, $any($event.target).checked)" />
                  <span></span>
                </label>
              </div>
              <div class="prov-meta">
                @if (p.tieneKey) { <span class="badge ok"><i class="ph ph-key"></i> {{ p.apiKeyMask }}</span> }
                @else if (necesitaKey(p.kind)) { <span class="badge warn"><i class="ph ph-warning"></i> sin API key</span> }
                @else { <span class="badge dim">sin key (local)</span> }
                <span class="badge dim">{{ usos(p.id) }} agente{{ usos(p.id) === 1 ? '' : 's' }}</span>
              </div>
              <div class="prov-actions">
                <button class="btn-secondary sm" (click)="abrirEditar(p)"><i class="ph ph-pencil-simple"></i> Editar</button>
                <button class="btn-secondary sm" (click)="verModelos(p)" [disabled]="cargandoModelos() === p.id">
                  <i class="ph" [class.ph-list]="cargandoModelos() !== p.id" [class.ph-spinner]="cargandoModelos() === p.id"></i> Modelos
                </button>
                <span class="spacer"></span>
                <button class="btn-icon danger" title="Eliminar" (click)="eliminar(p)"><i class="ph ph-trash"></i></button>
              </div>
              @if (modelosDe()[p.id]; as ms) {
                <div class="modelos">
                  @if (ms.length === 0) { <small class="hint">El proveedor no devolvió modelos.</small> }
                  @for (m of ms; track m) { <code>{{ m }}</code> }
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
            <h3>{{ form.id ? 'Editar proveedor' : 'Nuevo proveedor' }}</h3>
            <button class="btn-icon" (click)="cerrar()"><i class="ph ph-x"></i></button>
          </div>
          <div class="modal-body">
            @if (!form.id) {
              <label class="field">
                <span>Tipo</span>
                <div class="presets">
                  @for (pr of presets(); track pr.id) {
                    <button type="button" class="preset" [class.on]="form.preset === pr.id" (click)="elegirPreset(pr)">
                      <i class="ph {{ icono(pr.kind) }}"></i> {{ pr.name }}
                    </button>
                  }
                </div>
              </label>
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
              <span>API key @if (form.id) { <em>(vacío = conservar la actual)</em> } @else if (!presetActual()?.needsKey) { <em>(opcional)</em> }</span>
              <input type="password" [(ngModel)]="form.apiKey" autocomplete="off" placeholder="sk-…" />
              @if (presetActual()?.keysUrl) { <small class="hint">Consíguela en <a [href]="presetActual()!.keysUrl" target="_blank" rel="noopener">{{ presetActual()!.keysUrl }}</a></small> }
            </label>
            @if (presetActual()?.hint) { <p class="hint">{{ presetActual()!.hint }}</p> }
            @if (prueba(); as pr) {
              <div class="prueba" [class.ok]="pr.ok" [class.bad]="!pr.ok">
                @if (pr.ok) { <i class="ph ph-check-circle"></i> Respondió en {{ pr.ms }} ms: “{{ pr.respuesta }}” }
                @else { <i class="ph ph-x-circle"></i> {{ pr.error }} }
              </div>
            }
          </div>
          <div class="modal-foot">
            @if (form.id) {
              <input type="text" class="modelo-prueba" [(ngModel)]="modeloPrueba" placeholder="modelo para probar" />
              <button class="btn-secondary" (click)="probar()" [disabled]="probando() || !modeloPrueba"><i class="ph ph-lightning"></i> Probar</button>
              <span class="spacer"></span>
            }
            <button class="btn-secondary" (click)="cerrar()">Cancelar</button>
            <button class="btn-primary" (click)="guardar()" [disabled]="guardando() || !form.name">{{ form.id ? 'Guardar' : 'Agregar' }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .head { align-items: flex-start; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
    .prov-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
    .prov { border: 1px solid var(--border-light); border-radius: 12px; padding: 14px 16px; background: var(--bg-main); display: flex; flex-direction: column; gap: 10px; }
    .prov.off { opacity: .6; }
    .prov-head { display: flex; align-items: center; gap: 12px; }
    .prov-head > i { font-size: 26px; color: var(--accent-primary); }
    .prov-nombre { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .prov-nombre small { color: var(--text-dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .prov-meta { display: flex; gap: 8px; flex-wrap: wrap; }
    .prov-actions { display: flex; gap: 8px; align-items: center; }
    .btn-secondary.sm { padding: 6px 10px; font-size: 12px; }
    .btn-icon.danger:hover { color: var(--danger); }
    .modelos { display: flex; flex-wrap: wrap; gap: 6px; max-height: 140px; overflow: auto; padding-top: 6px; border-top: 1px dashed var(--border-light); }
    .modelos code { font-size: 11px; padding: 2px 6px; background: var(--bg-input); border-radius: 6px; }
    .switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .switch span { position: absolute; inset: 0; background: var(--border-light); border-radius: 999px; cursor: pointer; transition: .2s; }
    .switch span::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .2s; }
    .switch input:checked + span { background: var(--accent-primary); }
    .switch input:checked + span::before { transform: translateX(16px); }
    .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
    .preset { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 8px; border: 1px solid var(--border-light); background: var(--bg-input); color: var(--text-main); font-size: 13px; cursor: pointer; text-align: left; }
    .preset i { font-size: 18px; color: var(--text-dim); }
    .preset.on { border-color: var(--accent-primary); background: rgba(99,102,241,.12); }
    .preset.on i { color: var(--accent-primary); }
    .hint { color: var(--text-dim); font-size: 12px; margin-top: 6px; display: block; }
    .hint a { color: var(--accent-primary); }
    .prueba { margin-top: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13px; display: flex; gap: 8px; align-items: center; }
    .prueba.ok { background: rgba(16,185,129,.12); color: var(--ok); }
    .prueba.bad { background: rgba(239,68,68,.12); color: var(--danger); }
    .modelo-prueba { max-width: 220px; }
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
  cambio = output<void>();

  modal = signal(false);
  guardando = signal(false);
  probando = signal(false);
  prueba = signal<{ ok: boolean; ms: number; respuesta?: string; error?: string } | null>(null);
  cargandoModelos = signal<string | null>(null);
  modelosDe = signal<Record<string, string[]>>({});
  modeloPrueba = '';
  form: LlmProviderInput = { name: '', kind: 'openai', baseUrl: '', apiKey: '', enabled: true, preset: 'openai' };

  icono(k: ProviderKind) { return ICONO_KIND[k]; }
  nombreKind(k: ProviderKind) { return NOMBRE_KIND[k]; }
  necesitaKey(k: ProviderKind) { return k === 'gemini' || k === 'openai' || k === 'anthropic'; }
  usos(id: string) { return this.usosPorProveedor()[id] || 0; }
  presetActual() { return this.presets().find((p) => p.id === this.form.preset); }
  placeholderUrl() { return this.presetActual()?.baseUrl || 'https://…/v1'; }

  abrirNuevo() {
    const pr = this.presets().find((p) => p.id === 'openai') || this.presets()[0];
    this.form = { name: '', kind: 'openai', baseUrl: '', apiKey: '', enabled: true, preset: 'openai' };
    if (pr) this.elegirPreset(pr);
    this.prueba.set(null);
    this.modal.set(true);
  }

  abrirEditar(p: LlmProvider) {
    this.form = { id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl || '', apiKey: '', enabled: p.enabled, preset: p.preset };
    this.modeloPrueba = '';
    this.prueba.set(null);
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
    const data: LlmProviderInput = { ...this.form, baseUrl: this.form.baseUrl?.trim() || undefined, apiKey: this.form.apiKey?.trim() || undefined };
    this.api.saveLlmProvider(data).subscribe({
      next: () => { this.guardando.set(false); this.modal.set(false); this.toast.ok('Proveedor guardado'); this.cambio.emit(); },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); },
    });
  }

  toggle(p: LlmProvider, enabled: boolean) {
    this.api.saveLlmProvider({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, enabled }).subscribe({
      next: () => this.cambio.emit(),
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo cambiar'),
    });
  }

  eliminar(p: LlmProvider) {
    if (!confirm(`¿Eliminar "${p.name}"? Los agentes que lo usen volverán a Gemini por defecto.`)) return;
    this.api.deleteLlmProvider(p.id).subscribe({
      next: () => { this.toast.ok('Proveedor eliminado'); this.cambio.emit(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo eliminar'),
    });
  }

  verModelos(p: LlmProvider) {
    if (this.modelosDe()[p.id]) { const c = { ...this.modelosDe() }; delete c[p.id]; this.modelosDe.set(c); return; }
    this.cargandoModelos.set(p.id);
    this.api.getLlmModels(p.id).subscribe({
      next: (r) => { this.cargandoModelos.set(null); this.modelosDe.set({ ...this.modelosDe(), [p.id]: r.models }); },
      error: (e) => { this.cargandoModelos.set(null); this.toast.error(e?.error?.error || 'No se pudieron listar los modelos'); },
    });
  }

  probar() {
    if (!this.form.id || !this.modeloPrueba) return;
    this.probando.set(true);
    this.prueba.set(null);
    this.api.testLlm(this.form.id, this.modeloPrueba.trim()).subscribe({
      next: (r) => { this.probando.set(false); this.prueba.set(r); this.cdr.markForCheck(); },
      error: (e) => { this.probando.set(false); this.prueba.set({ ok: false, ms: 0, error: e?.error?.error || 'Error al probar' }); },
    });
  }
}
