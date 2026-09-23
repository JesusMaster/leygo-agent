import { ChangeDetectorRef, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, WebhookProvider } from '../../services/api.service';

let cacheCatalogo: WebhookProvider[] | null = null;

/**
 * Selector proveedor + modelo (los de Ajustes → Proveedores LLM).
 * value = "<proveedor>/<modelo>" o '' para "el modelo por defecto del agente".
 */
@Component({
  selector: 'app-model-picker',
  imports: [FormsModule],
  template: `
    <div class="mp">
      <label class="field">
        <span>Proveedor</span>
        <select [ngModel]="proveedor()" (ngModelChange)="cambiarProveedor($event)">
          @if (permitirDefecto()) { <option value="">{{ etiquetaDefecto() }}</option> }
          @for (p of catalogo(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
          @if (proveedor() && !enCatalogo()) { <option [value]="proveedor()">{{ proveedor() }} (ya no existe)</option> }
        </select>
      </label>
      <label class="field">
        <span>Modelo</span>
        <input type="text" [ngModel]="modelo()" (ngModelChange)="cambiarModelo($event)" [attr.list]="listaId" [disabled]="!proveedor()" [placeholder]="proveedor() ? 'id del modelo' : '—'" />
        <datalist [id]="listaId">
          @for (m of modelosDelProveedor(); track m) { <option [value]="m"></option> }
        </datalist>
      </label>
    </div>
  `,
  styles: [`
    .mp { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 560px) { .mp { grid-template-columns: 1fr; } }
    input:disabled { opacity: .5; }
  `],
})
export class ModelPickerComponent {
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);

  value = input<string | null | undefined>('');
  permitirDefecto = input(true);
  etiquetaDefecto = input('Por defecto (el del Coordinator en Ajustes)');
  valueChange = output<string>();

  catalogo = signal<WebhookProvider[]>(cacheCatalogo || []);
  listaId = `mp-${Math.random().toString(36).slice(2, 8)}`;

  proveedor = computed(() => { const v = this.value() || ''; const i = v.indexOf('/'); return i > 0 ? v.slice(0, i) : ''; });
  modelo = computed(() => { const v = this.value() || ''; const i = v.indexOf('/'); return i > 0 ? v.slice(i + 1) : ''; });
  enCatalogo = computed(() => this.catalogo().some((p) => p.id === this.proveedor()));
  modelosDelProveedor = computed(() => this.catalogo().find((p) => p.id === this.proveedor())?.models || []);

  constructor() {
    if (!cacheCatalogo) {
      this.api.getLlmCatalogo().subscribe({
        next: (r) => { cacheCatalogo = r.providers || []; this.catalogo.set(cacheCatalogo); this.cdr.markForCheck(); },
        error: () => {},
      });
    }
  }

  cambiarProveedor(id: string) {
    if (!id) { this.valueChange.emit(''); return; }
    const ms = this.catalogo().find((p) => p.id === id)?.models || [];
    const sugerido = ms.find((m) => /flash-lite|mini|nano/.test(m)) || ms[0] || '';
    this.valueChange.emit(`${id}/${sugerido}`);
  }
  cambiarModelo(m: string) {
    this.valueChange.emit(this.proveedor() ? `${this.proveedor()}/${m}` : '');
  }
}
