import { ChangeDetectorRef, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, EnvVar } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

const FILTRO_SIN_DEFINIR = '__sin_definir__';

/**
 * Claves y variables del `.env`, agrupadas. Los secretos se muestran
 * enmascarados; para cambiarlos se escribe el valor nuevo (vacío = sin cambio).
 */
@Component({
  selector: 'app-env-vars',
  imports: [FormsModule],
  template: `
    <div class="card">
      <div class="head">
        <div>
          <h3>Claves y variables</h3>
          <p class="card-sub">
            Edita <code>{{ ruta() }}</code> en el backend. Los secretos nunca viajan completos a la GUI.
            Las marcadas <span class="tag ok">al instante</span> aplican al guardar; el resto se lee al arrancar.
          </p>
        </div>
        <div class="head-acc">
          <button class="btn-icon" title="Recargar" (click)="cargar()"><i class="ph ph-arrows-clockwise"></i></button>
          <button class="btn-secondary sm" (click)="reiniciar()" [disabled]="reiniciando()"><i class="ph" [class.ph-power]="!reiniciando()" [class.ph-spinner]="reiniciando()"></i> {{ reiniciando() ? 'Reiniciando…' : 'Reiniciar backend' }}</button>
        </div>
      </div>

      @if (porReiniciar().length) {
        <div class="aviso">
          <i class="ph ph-info"></i>
          <span>Guardado. Para aplicar {{ porReiniciar().join(', ') }} hay que reiniciar el backend.</span>
          <span class="spacer"></span>
          <button class="btn-primary sm" (click)="reiniciar()" [disabled]="reiniciando()">Reiniciar ahora</button>
          <button class="btn-icon" title="Más tarde" (click)="porReiniciar.set([])"><i class="ph ph-x"></i></button>
        </div>
      }

      <div class="toolbar">
        <div class="buscar">
          <i class="ph ph-magnifying-glass"></i>
          <input type="text" [ngModel]="filtro()" (ngModelChange)="filtro.set($event)" placeholder="Buscar variable o descripción…" />
        </div>
        <div class="chips">
          <button class="chip" [class.on]="!grupoSel()" (click)="grupoSel.set(null)">Todas <span class="n">{{ vars().length }}</span></button>
          @for (g of nombresGrupos(); track g.nombre) {
            <button class="chip" [class.on]="grupoSel() === g.nombre" (click)="grupoSel.set(grupoSel() === g.nombre ? null : g.nombre)">{{ g.nombre }} <span class="n">{{ g.n }}</span></button>
          }
          @if (sinDefinir() > 0) {
            <button class="chip falta" [class.on]="grupoSel() === FILTRO_SIN_DEFINIR" (click)="grupoSel.set(grupoSel() === FILTRO_SIN_DEFINIR ? null : FILTRO_SIN_DEFINIR)"><i class="ph ph-warning"></i> Sin definir <span class="n">{{ sinDefinir() }}</span></button>
          }
        </div>
      </div>

      @for (g of grupos(); track g.nombre) {
        <section class="grupo">
          <div class="g-head">{{ g.nombre }} <span>{{ g.vars.length }}</span></div>
          @for (v of g.vars; track v.key) {
            @let c = cambio(v.key);
            <div class="var" [class.mod]="c !== undefined && c !== null" [class.quitar]="c === null">
              <div class="k">
                <div class="k-l">
                  @if (v.secreto) { <i class="ph ph-lock-simple" title="Secreto"></i> }
                  <code>{{ v.key }}</code>
                  @if (c === null) { <span class="tag bad">se quitará</span> }
                  @else if (c !== undefined) { <span class="tag acc">modificada</span> }
                  @else if (!v.definida) { <span class="tag warn">sin definir</span> }
                  @if (v.caliente) { <span class="tag ok">al instante</span> }
                </div>
                @if (v.descripcion) { <small>{{ v.descripcion }}</small> }
              </div>
              <div class="v">
                @if (c === null) {
                  <div class="quitado">Quedará comentada en el archivo.</div>
                } @else if (v.secreto) {
                  <div class="secreto">
                    <input [type]="visibles()[v.key] ? 'text' : 'password'" autocomplete="new-password" [ngModel]="c ?? ''" (ngModelChange)="editar(v.key, $event)"
                      [placeholder]="v.valor ? v.valor + ' · escribe para reemplazar' : 'sin definir'" />
                    @if (c) { <button class="btn-icon ojo" [title]="visibles()[v.key] ? 'Ocultar' : 'Ver lo que escribiste'" (click)="alternarVer(v.key)"><i class="ph" [class.ph-eye]="!visibles()[v.key]" [class.ph-eye-slash]="visibles()[v.key]"></i></button> }
                  </div>
                } @else {
                  <input type="text" [ngModel]="c ?? v.valor ?? ''" (ngModelChange)="editar(v.key, $event)" [placeholder]="v.placeholder || ''" />
                }
              </div>
              <div class="acc">
                @if (c !== undefined) {
                  <button class="btn-icon" title="Descartar cambio" (click)="descartar(v.key)"><i class="ph ph-arrow-counter-clockwise"></i></button>
                } @else if (v.definida) {
                  <button class="btn-icon danger" title="Quitar del .env" (click)="quitar(v.key)"><i class="ph ph-trash"></i></button>
                }
              </div>
            </div>
          }
        </section>
      } @empty {
        <div class="empty">Ninguna variable coincide con el filtro.</div>
      }

      @if (agregando()) {
        <div class="nueva">
          <input type="text" class="nk" [(ngModel)]="nuevaKey" placeholder="NOMBRE_VARIABLE" (keydown.enter)="agregar()" />
          <input type="text" class="nv" [(ngModel)]="nuevoValor" placeholder="valor" (keydown.enter)="agregar()" />
          <button class="btn-secondary sm" (click)="agregar()" [disabled]="!nuevaKey.trim()">Agregar</button>
          <button class="btn-icon" title="Cancelar" (click)="agregando.set(false)"><i class="ph ph-x"></i></button>
        </div>
      } @else {
        <button class="agregar" (click)="agregando.set(true)"><i class="ph ph-plus"></i> Agregar otra variable</button>
      }

      @if (pendientes() > 0) {
        <div class="barra">
          <i class="ph ph-pencil-simple-line"></i>
          <span><b>{{ pendientes() }}</b> cambio{{ pendientes() === 1 ? '' : 's' }} sin guardar@if (pendientesReinicio() > 0) { <span class="dim"> · {{ pendientesReinicio() }} requiere{{ pendientesReinicio() === 1 ? '' : 'n' }} reinicio</span> }</span>
          <span class="spacer"></span>
          <button class="btn-secondary sm" (click)="descartarTodo()">Descartar</button>
          <button class="btn-primary sm" (click)="guardar()" [disabled]="guardando()"><i class="ph ph-floppy-disk"></i> Guardar</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    .head > div:first-child { flex: 1 1 360px; min-width: 0; }
    .head .card-sub { margin-bottom: 0; line-height: 1.6; }
    .head-acc { display: flex; gap: 6px; align-items: center; }
    .btn-secondary.sm, .btn-primary.sm { padding: 6px 11px; font-size: 12.5px; display: inline-flex; align-items: center; gap: 5px; }

    .aviso { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; margin-bottom: 12px; border-radius: 10px; font-size: 13px; background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.4); }
    .aviso > i { color: var(--warn); font-size: 17px; }

    .toolbar { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
    .buscar { position: relative; max-width: 380px; }
    .buscar i { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--text-dim); }
    .buscar input { padding-left: 32px; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip .n { font-size: 11px; opacity: .7; }
    .chip.falta { color: var(--warn); border-color: rgba(245,158,11,.4); }
    .chip.falta.on { background: var(--warn); border-color: var(--warn); color: #111; }

    .grupo { border: 1px solid var(--border-light); border-radius: 12px; margin-bottom: 12px; overflow: hidden; }
    .g-head { padding: 9px 14px; background: var(--bg-main); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); border-bottom: 1px solid var(--border-light); }
    .g-head span { font-weight: 400; margin-left: 4px; opacity: .8; }
    .var { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(240px, 1.2fr) 36px; gap: 14px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--border-light); border-left: 3px solid transparent; }
    .g-head + .var { border-top: none; }
    .var.mod { border-left-color: var(--accent-primary); background: rgba(129,140,248,.05); }
    .var.quitar { border-left-color: var(--danger); background: rgba(239,68,68,.05); }
    .var.quitar code { text-decoration: line-through; opacity: .7; }
    .k { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .k-l { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .k-l > i { color: var(--text-dim); font-size: 13px; }
    .k code { font-size: 12.5px; font-weight: 600; }
    .k small { color: var(--text-dim); font-size: 12px; line-height: 1.4; }
    .v { min-width: 0; }
    .v input { width: 100%; font-size: 13px; }
    .secreto { position: relative; }
    .secreto input { padding-right: 38px; }
    .secreto input::placeholder { font-family: ui-monospace, monospace; font-size: 12px; }
    .ojo { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); }
    .quitado { font-size: 12.5px; color: var(--danger); }
    .acc { display: flex; justify-content: flex-end; }
    .btn-icon.danger:hover { color: var(--danger); }

    .tag { display: inline-flex; align-items: center; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border-light); color: var(--text-dim); font-family: var(--font-main); font-weight: 500; white-space: nowrap; }
    .tag.ok { color: var(--ok); border-color: rgba(16,185,129,.35); }
    .tag.warn { color: var(--warn); border-color: rgba(245,158,11,.45); }
    .tag.bad { color: var(--danger); border-color: rgba(239,68,68,.45); }
    .tag.acc { color: var(--accent-primary); border-color: rgba(129,140,248,.45); }

    .agregar { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 10px; border: 1px dashed var(--border-light); background: none; color: var(--text-dim); font-size: 13px; cursor: pointer; }
    .agregar:hover { color: var(--accent-primary); border-color: var(--accent-primary); }
    .nueva { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px; border: 1px dashed var(--accent-primary); border-radius: 10px; }
    .nk { flex: 0 1 240px; font-family: ui-monospace, monospace; text-transform: uppercase; }
    .nv { flex: 1 1 200px; }

    .barra { position: sticky; bottom: 12px; z-index: 5; display: flex; align-items: center; gap: 10px; margin-top: 14px; padding: 10px 12px 10px 14px; border-radius: 12px; background: var(--bg-card); border: 1px solid var(--accent-primary); box-shadow: 0 8px 28px rgba(0,0,0,.35); font-size: 13.5px; }
    .barra > i { color: var(--accent-primary); font-size: 18px; }
    .dim { color: var(--text-dim); }

    @media (max-width: 760px) {
      .var { grid-template-columns: 1fr 36px; gap: 8px; }
      .v { grid-column: 1; grid-row: 2; }
      .acc { grid-column: 2; grid-row: 1 / span 2; align-self: start; }
      .barra { flex-wrap: wrap; }
    }
  `],
})
export class EnvVarsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  readonly FILTRO_SIN_DEFINIR = FILTRO_SIN_DEFINIR;
  ruta = signal('.env');
  vars = signal<EnvVar[]>([]);
  cambios = signal<Record<string, string | null>>({});
  visibles = signal<Record<string, boolean>>({});
  guardando = signal(false);
  reiniciando = signal(false);
  porReiniciar = signal<string[]>([]);
  filtro = signal('');
  grupoSel = signal<string | null>(null);
  agregando = signal(false);
  nuevaKey = '';
  nuevoValor = '';

  pendientes = computed(() => Object.keys(this.cambios()).length);
  pendientesReinicio = computed(() => Object.keys(this.cambios()).filter((k) => !this.vars().find((v) => v.key === k)?.caliente).length);
  sinDefinir = computed(() => this.vars().filter((v) => !v.definida).length);

  nombresGrupos = computed(() => {
    const m = new Map<string, number>();
    for (const v of this.vars()) m.set(v.grupo, (m.get(v.grupo) || 0) + 1);
    return [...m.entries()].map(([nombre, n]) => ({ nombre, n }));
  });

  grupos = computed(() => {
    const f = this.filtro().trim().toLowerCase();
    const sel = this.grupoSel();
    const map = new Map<string, EnvVar[]>();
    for (const v of this.vars()) {
      if (f && !v.key.toLowerCase().includes(f) && !v.descripcion.toLowerCase().includes(f)) continue;
      if (sel === FILTRO_SIN_DEFINIR ? v.definida : sel && v.grupo !== sel) continue;
      if (!map.has(v.grupo)) map.set(v.grupo, []);
      map.get(v.grupo)!.push(v);
    }
    return [...map.entries()].map(([nombre, vars]) => ({ nombre, vars }));
  });

  constructor() { this.cargar(); }

  cargar() {
    this.api.getEnv().subscribe({
      next: (r) => { this.ruta.set(r.ruta); this.vars.set(r.vars); this.cambios.set({}); this.visibles.set({}); this.cdr.markForCheck(); },
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

  cambio(key: string): string | null | undefined { return this.cambios()[key]; }
  alternarVer(key: string) { this.visibles.set({ ...this.visibles(), [key]: !this.visibles()[key] }); }
  descartar(key: string) { const c = { ...this.cambios() }; delete c[key]; this.cambios.set(c); }
  descartarTodo() { this.cambios.set({}); this.visibles.set({}); this.vars.set(this.vars().filter((v) => v.enArchivo || v.definida || esConocida(v))); }

  quitar(key: string) {
    if (!confirm(`¿Quitar ${key} del .env? Quedará comentada en el archivo (se aplica al guardar).`)) return;
    this.cambios.set({ ...this.cambios(), [key]: null });
  }

  agregar() {
    const k = this.nuevaKey.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) { this.toast.error('Nombre inválido: solo letras, números y _'); return; }
    this.cambios.set({ ...this.cambios(), [k]: this.nuevoValor });
    if (!this.vars().some((v) => v.key === k)) {
      this.vars.set([...this.vars(), { key: k, grupo: 'Otras', descripcion: '', secreto: /(KEY|SECRET|TOKEN|PASSWORD|PASS|URI|PRIVATE)/i.test(k), caliente: false, valor: null, definida: false, enArchivo: false }]);
    }
    this.filtro.set(''); this.grupoSel.set(null);
    this.nuevaKey = ''; this.nuevoValor = '';
    this.agregando.set(false);
  }

  guardar() {
    this.guardando.set(true);
    this.api.saveEnv(this.cambios()).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.toast.ok(`Guardado: ${r.cambiadas.join(', ')}`);
        this.porReiniciar.set(r.requierenReinicio || []);
        this.cargar();
      },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); },
    });
  }

  reiniciar() {
    const sinGuardar = this.pendientes();
    if (!confirm(`¿Reiniciar el backend ahora? Las conversaciones en curso se cortan.${sinGuardar ? `\n\nOjo: tienes ${sinGuardar} cambio(s) sin guardar que se perderán.` : ''}`)) return;
    this.reiniciando.set(true);
    this.api.restartBackend().subscribe({
      next: () => {
        this.porReiniciar.set([]);
        // Espera a que vuelva a responder en vez de un tiempo fijo.
        let intentos = 0;
        const t = setInterval(() => {
          intentos++;
          this.api.getStatus().subscribe({
            next: () => { if (intentos < 3) return; clearInterval(t); this.reiniciando.set(false); this.toast.ok('Backend reiniciado'); this.cargar(); },
            error: () => { if (intentos > 40) { clearInterval(t); this.reiniciando.set(false); this.toast.error('El backend no volvió a responder: revisa los logs'); } },
          });
        }, 1500);
      },
      error: (e) => { this.reiniciando.set(false); this.toast.error(e?.error?.error || 'No se pudo reiniciar'); },
    });
  }
}

/** Las variables agregadas a mano y descartadas desaparecen; las del catálogo se quedan. */
function esConocida(v: EnvVar) { return v.grupo !== 'Otras' || !!v.descripcion; }
