import { ChangeDetectorRef, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgenteLlm, ApiService, LlmProvider } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { ModelPickerComponent } from '../model-picker/model-picker';

interface Fila { agente: AgenteLlm; provider: string; model: string; sucio: boolean; }

/** Tabla agente → proveedor + modelo. Aplica en el siguiente turno, sin reiniciar. */
@Component({
  selector: 'app-agent-models',
  imports: [FormsModule, ModelPickerComponent],
  template: `
    <div class="card">
      <h3>Modelo por agente</h3>
      <p class="card-sub">Cada agente puede usar un proveedor distinto. "Por defecto" es el Gemini del <code>.env</code>. Los cambios aplican en la siguiente llamada, sin reiniciar.</p>

      <div class="global">
        <div class="info">
          <strong><i class="ph ph-lifebuoy"></i> Respaldo global</strong>
          <div class="desc">Si el modelo principal de un agente falla por cuota, sobrecarga o caída del proveedor (429, 503, "high demand"…), la misma petición se repite con este modelo. Un agente puede tener su propio respaldo más abajo. Conviene que sea de <em>otro</em> proveedor.</div>
        </div>
        <div class="controles">
          <app-model-picker [value]="globalFallback()" etiquetaDefecto="Sin respaldo" (valueChange)="guardarGlobal($event)" />
        </div>
      </div>

      <div class="lista">
        @for (f of filas(); track f.agente.name) {
          <div class="fila">
            <div class="info">
              <strong>{{ f.agente.titulo }}</strong>
              <div class="desc">{{ f.agente.descripcion }}</div>
              @if (f.agente.advertencia) { <span class="badge warn"><i class="ph ph-warning"></i> {{ f.agente.advertencia }}</span> }
            </div>
            <div class="controles">
              <select class="prov" [ngModel]="f.provider" (ngModelChange)="cambiarProveedor(f, $event)">
                <option value="">Por defecto ({{ f.agente.defaultModel }})</option>
                @for (p of providers(); track p.id) { <option [value]="p.id" [disabled]="!p.enabled">{{ p.name }}{{ p.enabled ? '' : ' (apagado)' }}</option> }
              </select>
              @if (f.provider) {
                <input class="mod" type="text" [(ngModel)]="f.model" (ngModelChange)="f.sucio = true" [attr.list]="'modelos-' + f.provider" placeholder="id del modelo" (focus)="cargarModelos(f.provider)" />
                <datalist [id]="'modelos-' + f.provider">
                  @for (m of modelos()[f.provider] || []; track m) { <option [value]="m"></option> }
                </datalist>
              } @else {
                <span class="dim mod">{{ f.agente.defaultModel }}</span>
              }
              <div class="acciones">
                @if (f.provider) {
                  <button class="btn-icon" title="Probar este modelo" (click)="probar(f)" [disabled]="!f.model || probando() === f.agente.name">
                    <i class="ph" [class.ph-lightning]="probando() !== f.agente.name" [class.ph-spinner]="probando() === f.agente.name"></i>
                  </button>
                }
                <button class="btn-primary sm" (click)="guardar(f)" [disabled]="!f.sucio || (!!f.provider && !f.model)">Guardar</button>
              </div>
              @if (resultado()[f.agente.name]; as r) {
                <div class="res" [class.ok]="r.ok" [class.bad]="!r.ok">{{ r.ok ? (r.ms + ' ms · ' + r.respuesta) : r.error }}</div>
              }
              <div class="respaldo">
                <span class="dim"><i class="ph ph-lifebuoy"></i> Respaldo:</span>
                <app-model-picker [value]="refRespaldo(f.agente)" [etiquetaDefecto]="f.agente.fallbackEfectivo?.origen === 'global' ? ('Global (' + f.agente.fallbackEfectivo!.model + ')') : 'Sin respaldo'" (valueChange)="guardarRespaldo(f, $event)" />
              </div>
            </div>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .fila { display: flex; flex-wrap: wrap; gap: 12px 20px; padding: 14px 0; border-bottom: 1px solid var(--border-light); }
    .fila:last-child { border-bottom: none; }
    .info { flex: 1 1 200px; min-width: 0; }
    .desc { color: var(--text-dim); font-size: 12px; margin: 3px 0 4px; }
    .controles { flex: 3 1 340px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .controles select.prov { flex: 1 1 170px; width: auto; }
    .controles .mod { flex: 1 1 170px; width: auto; }
    .dim { color: var(--text-dim); font-size: 13px; }
    .acciones { display: inline-flex; gap: 6px; align-items: center; margin-left: auto; }
    .btn-primary.sm { padding: 7px 12px; font-size: 12px; }
    .res { flex-basis: 100%; font-size: 12px; }
    .res.ok { color: var(--ok); }
    .res.bad { color: var(--danger); }
    .global { display: flex; flex-wrap: wrap; gap: 12px 20px; padding: 12px 14px; margin-bottom: 8px; border-radius: 10px; background: var(--bg-main); border: 1px solid var(--border-light); }
    .respaldo { flex-basis: 100%; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .respaldo app-model-picker { flex: 1 1 320px; }
  `],
})
export class AgentModelsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  providers = input.required<LlmProvider[]>();
  agentes = input.required<AgenteLlm[]>();
  cambio = output<void>();

  filas = signal<Fila[]>([]);
  modelos = signal<Record<string, string[]>>({});
  probando = signal<string | null>(null);
  resultado = signal<Record<string, { ok: boolean; ms: number; respuesta?: string; error?: string }>>({});

  globalFallback = signal<string>('');

  ngOnChanges() {
    this.filas.set(this.agentes().map((a) => ({ agente: a, provider: a.assignment?.provider || '', model: a.assignment?.model || '', sucio: false })));
    this.api.getGlobalFallback().subscribe({ next: (r) => { this.globalFallback.set(r.fallback ? `${r.fallback.provider}/${r.fallback.model}` : ''); this.cdr.markForCheck(); }, error: () => {} });
  }

  refRespaldo(a: AgenteLlm): string { return a.fallback ? `${a.fallback.provider}/${a.fallback.model}` : ''; }

  private partir(ref: string): { provider: string; model: string } | null {
    const i = (ref || '').indexOf('/');
    return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : null;
  }

  guardarGlobal(ref: string) {
    this.api.setGlobalFallback(this.partir(ref)).subscribe({
      next: () => { this.globalFallback.set(ref || ''); this.toast.ok(ref ? 'Respaldo global guardado' : 'Respaldo global quitado'); this.cambio.emit(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo guardar'),
    });
  }

  guardarRespaldo(f: Fila, ref: string) {
    this.api.setLlmFallback(f.agente.name, this.partir(ref)).subscribe({
      next: () => { this.toast.ok(`${f.agente.titulo}: respaldo ${ref ? 'guardado' : 'quitado'}`); this.cambio.emit(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo guardar'),
    });
  }

  cambiarProveedor(f: Fila, provider: string) {
    f.provider = provider;
    f.sucio = true;
    if (provider) {
      f.model = '';
      this.cargarModelos(provider);
    }
    this.filas.set([...this.filas()]);
  }

  cargarModelos(providerId: string) {
    if (!providerId || this.modelos()[providerId]) return;
    this.api.getLlmModels(providerId).subscribe({
      next: (r) => { this.modelos.set({ ...this.modelos(), [providerId]: r.models }); this.cdr.markForCheck(); },
      error: () => { this.modelos.set({ ...this.modelos(), [providerId]: [] }); },
    });
  }

  guardar(f: Fila) {
    this.api.setLlmAssignment(f.agente.name, f.provider && f.model ? { provider: f.provider, model: f.model.trim() } : null).subscribe({
      next: () => { f.sucio = false; this.toast.ok(`${f.agente.titulo}: modelo actualizado`); this.cambio.emit(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo guardar'),
    });
  }

  probar(f: Fila) {
    this.probando.set(f.agente.name);
    this.api.testLlm(f.provider, f.model.trim()).subscribe({
      next: (r) => { this.probando.set(null); this.resultado.set({ ...this.resultado(), [f.agente.name]: r }); this.cdr.markForCheck(); },
      error: (e) => { this.probando.set(null); this.resultado.set({ ...this.resultado(), [f.agente.name]: { ok: false, ms: 0, error: e?.error?.error || 'Error' } }); },
    });
  }
}
