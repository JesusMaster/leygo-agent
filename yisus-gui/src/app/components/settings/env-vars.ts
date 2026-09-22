import { ChangeDetectorRef, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, EnvVar } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

/**
 * Claves y variables del `.env`, agrupadas. Los secretos se muestran
 * enmascarados; para cambiarlos se escribe el valor nuevo (vacío = sin cambio).
 */
@Component({
  selector: 'app-env-vars',
  imports: [FormsModule],
  template: `
    <div class="card">
      <div class="row head">
        <div>
          <h3>Claves y variables</h3>
          <p class="card-sub" style="margin-bottom:0">
            Edita el <code>{{ ruta() }}</code> del backend. Los secretos nunca viajan completos a la GUI.
            Las variables marcadas <span class="badge dim">reinicio</span> se leen al arrancar: guarda y reinicia.
          </p>
        </div>
        <span class="spacer"></span>
        <input type="text" class="buscar" [ngModel]="filtro()" (ngModelChange)="filtro.set($event)" placeholder="Filtrar…" />
        <button class="btn-secondary" (click)="cargar()"><i class="ph ph-arrows-clockwise"></i></button>
        <button class="btn-secondary" (click)="reiniciar()" [disabled]="reiniciando()"><i class="ph ph-power"></i> Reiniciar backend</button>
        <button class="btn-primary" (click)="guardar()" [disabled]="pendientes() === 0 || guardando()">
          <i class="ph ph-floppy-disk"></i> Guardar{{ pendientes() ? ' (' + pendientes() + ')' : '' }}
        </button>
      </div>

      @if (aviso()) { <div class="aviso"><i class="ph ph-info"></i> {{ aviso() }}</div> }

      @for (g of grupos(); track g.nombre) {
        <details class="grupo" open>
          <summary>{{ g.nombre }} <span class="badge dim">{{ g.vars.length }}</span></summary>
          <div class="tabla-wrap">
            <table>
              @for (v of g.vars; track v.key) {
                <tr [class.mod]="cambios()[v.key] !== undefined">
                  <td class="k">
                    <code>{{ v.key }}</code>
                    <div class="desc">{{ v.descripcion }}</div>
                    <div class="tags">
                      @if (v.secreto) { <span class="badge dim"><i class="ph ph-lock-simple"></i> secreto</span> }
                      @if (!v.caliente) { <span class="badge dim">reinicio</span> }
                      @if (!v.definida) { <span class="badge warn">sin definir</span> }
                    </div>
                  </td>
                  <td class="v">
                    @if (v.secreto) {
                      <div class="valor-actual">{{ v.valor || '—' }}</div>
                      <input type="password" autocomplete="new-password" [ngModel]="cambios()[v.key] ?? ''" (ngModelChange)="editar(v.key, $event)" placeholder="nuevo valor (vacío = sin cambio)" />
                    } @else {
                      <input type="text" [ngModel]="cambios()[v.key] ?? v.valor ?? ''" (ngModelChange)="editar(v.key, $event)" [placeholder]="v.placeholder || ''" />
                    }
                  </td>
                  <td class="acc">
                    @if (cambios()[v.key] !== undefined) {
                      <button class="btn-icon" title="Descartar" (click)="descartar(v.key)"><i class="ph ph-arrow-counter-clockwise"></i></button>
                    }
                    @if (v.definida) {
                      <button class="btn-icon danger" title="Quitar del .env" (click)="quitar(v.key)"><i class="ph ph-trash"></i></button>
                    }
                  </td>
                </tr>
              }
            </table>
          </div>
        </details>
      }

      <details class="grupo nueva">
        <summary>Agregar variable</summary>
        <div class="row" style="flex-wrap:wrap">
          <input type="text" class="nk" [(ngModel)]="nuevaKey" placeholder="NOMBRE_VARIABLE" />
          <input type="text" class="nv" [(ngModel)]="nuevoValor" placeholder="valor" />
          <button class="btn-secondary" (click)="agregar()" [disabled]="!nuevaKey.trim()"><i class="ph ph-plus"></i> Agregar</button>
        </div>
      </details>
    </div>
  `,
  styles: [`
    .head { align-items: flex-start; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
    .buscar { max-width: 180px; }
    .aviso { margin-bottom: 14px; padding: 10px 12px; border-radius: 8px; background: rgba(245,158,11,.14); color: var(--warn); font-size: 13px; display: flex; gap: 8px; align-items: center; }
    .grupo { border: 1px solid var(--border-light); border-radius: 10px; margin-bottom: 10px; background: var(--bg-main); }
    .grupo summary { cursor: pointer; padding: 10px 14px; font-weight: 600; font-size: 14px; display: flex; gap: 8px; align-items: center; }
    .grupo.nueva .row { padding: 10px 14px 14px; }
    .tabla-wrap { overflow-x: auto; }
    td.k { width: 36%; min-width: 220px; }
    td.k code { font-size: 12px; }
    .desc { color: var(--text-dim); font-size: 12px; margin: 3px 0 5px; }
    .tags { display: flex; gap: 6px; flex-wrap: wrap; }
    td.v { min-width: 240px; }
    .valor-actual { font-family: monospace; font-size: 12px; color: var(--text-dim); margin-bottom: 6px; }
    td.acc { white-space: nowrap; text-align: right; width: 80px; }
    tr.mod td { background: rgba(99,102,241,.06); }
    .btn-icon.danger:hover { color: var(--danger); }
    .nk { max-width: 240px; font-family: monospace; }
    .nv { flex: 1; min-width: 200px; }
  `],
})
export class EnvVarsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  ruta = signal('.env');
  vars = signal<EnvVar[]>([]);
  cambios = signal<Record<string, string | null>>({});
  guardando = signal(false);
  reiniciando = signal(false);
  aviso = signal<string | null>(null);
  filtro = signal('');
  nuevaKey = '';
  nuevoValor = '';

  pendientes = computed(() => Object.keys(this.cambios()).length);

  grupos = computed(() => {
    const f = this.filtro().trim().toLowerCase();
    const map = new Map<string, EnvVar[]>();
    for (const v of this.vars()) {
      if (f && !v.key.toLowerCase().includes(f) && !v.descripcion.toLowerCase().includes(f)) continue;
      if (!map.has(v.grupo)) map.set(v.grupo, []);
      map.get(v.grupo)!.push(v);
    }
    return [...map.entries()].map(([nombre, vars]) => ({ nombre, vars }));
  });

  constructor() { this.cargar(); }

  cargar() {
    this.api.getEnv().subscribe({
      next: (r) => { this.ruta.set(r.ruta); this.vars.set(r.vars); this.cambios.set({}); this.cdr.markForCheck(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo leer el .env'),
    });
  }

  editar(key: string, valor: string) {
    const v = this.vars().find((x) => x.key === key);
    const c = { ...this.cambios() };
    // Sin cambio real → se quita de pendientes.
    if ((v?.secreto && valor === '') || (!v?.secreto && valor === (v?.valor ?? ''))) delete c[key];
    else c[key] = valor;
    this.cambios.set(c);
  }

  descartar(key: string) { const c = { ...this.cambios() }; delete c[key]; this.cambios.set(c); }

  quitar(key: string) {
    if (!confirm(`¿Quitar ${key} del .env? Quedará comentada en el archivo.`)) return;
    this.cambios.set({ ...this.cambios(), [key]: null });
  }

  agregar() {
    const k = this.nuevaKey.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) { this.toast.error('Nombre inválido: solo letras, números y _'); return; }
    this.cambios.set({ ...this.cambios(), [k]: this.nuevoValor });
    if (!this.vars().some((v) => v.key === k)) {
      this.vars.set([...this.vars(), { key: k, grupo: 'Otras', descripcion: '', secreto: /(KEY|SECRET|TOKEN|PASSWORD|PASS|URI|PRIVATE)/i.test(k), caliente: false, valor: null, definida: false, enArchivo: false }]);
    }
    this.nuevaKey = ''; this.nuevoValor = '';
  }

  guardar() {
    this.guardando.set(true);
    this.api.saveEnv(this.cambios()).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.toast.ok(`Guardado: ${r.cambiadas.join(', ')}`);
        this.aviso.set(r.requierenReinicio.length ? `Reinicia el backend para aplicar: ${r.requierenReinicio.join(', ')}` : null);
        this.cargar();
      },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); },
    });
  }

  reiniciar() {
    if (!confirm('¿Reiniciar el backend ahora? Las conversaciones en curso se cortan.')) return;
    this.reiniciando.set(true);
    this.api.restartBackend().subscribe({
      next: (r) => {
        this.toast.ok(r.modo === 'watch' ? 'Reiniciando (tsx watch)…' : 'Backend detenido; el supervisor lo levanta de nuevo');
        this.aviso.set(null);
        setTimeout(() => { this.reiniciando.set(false); this.cargar(); }, 6000);
      },
      error: (e) => { this.reiniciando.set(false); this.toast.error(e?.error?.error || 'No se pudo reiniciar'); },
    });
  }
}
