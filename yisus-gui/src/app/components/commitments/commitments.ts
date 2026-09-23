import { ChangeDetectorRef, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, BackfillEstado, Commitment, CommitmentStatus, CommitmentUpdate, TaskDelivery } from '../../services/api.service';
import { DeliveryPickerComponent } from '../tasks/delivery-picker';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';

type Vista = 'propuestos' | 'abiertos' | 'vencidos' | 'hechos' | 'todos';

const ESTADO_LABEL: Record<CommitmentStatus, string> = { propuesto: 'Propuesto', pendiente: 'Pendiente', en_curso: 'En curso', hecho: 'Hecho', cancelado: 'Cancelado', descartado: 'Descartado' };
const ORIGEN_LABEL: Record<string, string> = { google_chat: 'Google Chat', gmail: 'Gmail', meet: 'Meet', manual: 'Manual', backfill: 'Backfill' };

/**
 * Compromisos: lo que Jesús debe y lo que le deben. Los "propuestos" son los que
 * detectó la IA (Chat, Gmail, Meet) y esperan visto bueno; el resto es la lista viva.
 */
@Component({
  selector: 'app-commitments',
  imports: [FormsModule, RouterLink, FriendlyDatePipe, DeliveryPickerComponent],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Compromisos</h2>
          <p class="sub">Lo que debes y lo que te deben, detectado en Chat, Gmail y Meet o anotado a mano. Los propuestos esperan tu visto bueno; el aviso diario se configura en <a routerLink="/tasks">Tareas programadas</a> ("Aviso de compromisos").</p>
        </div>
        <div class="row">
          <button class="btn-secondary" (click)="abrirBackfill()" title="Importar desde la memoria episódica"><i class="ph ph-clock-counter-clockwise"></i> Backfill</button>
          <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Nuevo</button>
        </div>
      </div>

      <div class="kpis">
        <button class="kpi" [class.on]="vista() === 'propuestos'" (click)="ir('propuestos')"><b>{{ stats()['propuesto'] || 0 }}</b><span>Propuestos</span></button>
        <button class="kpi" [class.on]="vista() === 'abiertos'" (click)="ir('abiertos')"><b>{{ (stats()['pendiente'] || 0) + (stats()['en_curso'] || 0) }}</b><span>Abiertos</span></button>
        <button class="kpi danger" [class.on]="vista() === 'vencidos'" (click)="ir('vencidos')"><b>{{ stats()['vencidos'] || 0 }}</b><span>Vencidos</span></button>
        <button class="kpi" [class.on]="vista() === 'hechos'" (click)="ir('hechos')"><b>{{ stats()['hecho'] || 0 }}</b><span>Hechos</span></button>
        <button class="kpi" [class.on]="vista() === 'todos'" (click)="ir('todos')"><b>{{ total() }}</b><span>Todos</span></button>
      </div>

      <div class="filtros">
        <div class="seg">
          <button [class.on]="quien() === ''" (click)="quien.set('')">Todos</button>
          <button [class.on]="quien() === '1'" (click)="quien.set('1')">Los que debo</button>
          <button [class.on]="quien() === '0'" (click)="quien.set('0')">Me deben</button>
        </div>
        <input type="text" class="buscar" [ngModel]="q()" (ngModelChange)="q.set($event)" placeholder="Filtrar por texto, persona…" />
        <button class="btn-secondary" (click)="load()"><i class="ph ph-arrows-clockwise"></i></button>
        @if (vista() === 'propuestos' && propuestosAntiguos().length) {
          <span class="spacer"></span>
          <button class="btn-secondary" (click)="descartarAntiguos()" title="Propuestos cuya fecha ya pasó: casi siempre ya se hicieron o quedaron obsoletos"><i class="ph ph-broom"></i> Descartar {{ propuestosAntiguos().length }} con fecha pasada</button>
        }
      </div>

      @if (!cargado()) {
        <div class="card"><div class="empty">Cargando…</div></div>
      } @else if (filtrados().length === 0) {
        <div class="card"><div class="empty">
          @switch (vista()) {
            @case ('propuestos') { Nada propuesto por revisar. Lo nuevo aparece acá tras la consolidación nocturna, una reunión ingresada o el backfill. }
            @case ('vencidos') { Nada vencido. }
            @default { Sin compromisos en esta vista. Anota uno con "Nuevo" o dile al agente "anota que le debo…". }
          }
        </div></div>
      } @else {
        @for (c of filtrados(); track c.id) {
          <div class="cm" [class.vencido]="vencido(c)" [class.propuesto]="c.status === 'propuesto'" [class.cerrado]="c.status === 'hecho' || c.status === 'cancelado' || c.status === 'descartado'">
            <div class="cm-head">
              <div class="cm-badges">
                <span class="tb estado" [attr.data-estado]="c.status">{{ estadoLabel(c.status) }}</span>
                <span class="tb quien" [class.mio]="c.mine"><i class="ph" [class.ph-user]="c.mine" [class.ph-users]="!c.mine"></i> {{ c.mine ? 'Lo debo' : 'Me debe ' + c.owner }}</span>
                @if (c.priority === 'alta') { <span class="tb prio">alta</span> }
                @if (c.source_type) {
                  <span class="tb origen" [title]="c.source_title || ''">
                    @if (c.source_link) { <a [href]="c.source_link" target="_blank" rel="noopener">{{ origenLabel(c.source_type) }} <i class="ph ph-arrow-square-out"></i></a> }
                    @else { {{ origenLabel(c.source_type) }} }
                  </span>
                }
              </div>
              <div class="cm-actions">
                @if (c.status === 'propuesto') {
                  <button class="btn-primary sm" (click)="aceptar(c)" title="Aceptar con la fecha sugerida o la que elijas"><i class="ph ph-check"></i> Aceptar</button>
                  <button class="btn-secondary sm" (click)="cambiarEstado(c, 'descartado')"><i class="ph ph-x"></i> Descartar</button>
                } @else if (c.status === 'pendiente' || c.status === 'en_curso') {
                  @if (c.status === 'pendiente') { <button class="ta" title="Marcar en curso" (click)="cambiarEstado(c, 'en_curso')"><i class="ph ph-play"></i></button> }
                  <button class="ta ok" title="Marcar hecho (y avisar)" (click)="abrirCierre(c, 'hecho')"><i class="ph ph-check-circle"></i></button>
                  <button class="ta" title="Avisar a la contraparte" (click)="abrirCierre(c, null)"><i class="ph ph-paper-plane-tilt"></i></button>
                  <button class="ta" title="Cancelar (y avisar)" (click)="abrirCierre(c, 'cancelado')"><i class="ph ph-prohibit"></i></button>
                } @else {
                  <button class="ta" title="Reabrir" (click)="cambiarEstado(c, 'pendiente')"><i class="ph ph-arrow-counter-clockwise"></i></button>
                }
                <button class="ta" [class.on]="abierto() === c.id" title="Detalle e historial" (click)="toggleDetalle(c)"><i class="ph ph-list-dashes"></i></button>
                <button class="ta del" title="Eliminar" (click)="eliminar(c)"><i class="ph ph-trash"></i></button>
              </div>
            </div>

            <div class="cm-main">
              <div class="cm-title">
                <input type="text" class="titulo" [ngModel]="c.title" (ngModelChange)="pendTitle[c.id] = $event" (blur)="guardarTitulo(c)" />
              </div>
              <div class="cm-meta">
                <label class="fecha" [class.sugerida]="!c.due_date && c.proposed_due">
                  <i class="ph ph-calendar"></i>
                  <input type="date" [ngModel]="c.due_date || c.proposed_due || ''" (ngModelChange)="cambiarFecha(c, $event)" />
                  @if (!c.due_date && c.proposed_due) { <small>sugerida</small> }
                  @if (vencido(c)) { <small class="venc">vencido</small> }
                </label>
                @if (c.counterpart) { <span class="con"><i class="ph ph-handshake"></i> {{ c.counterpart }}</span> }
                @if (c.source_title) { <span class="src" [title]="c.source_title">{{ c.source_title }}</span> }
                <span class="spacer"></span>
                <code class="id">{{ c.id }}</code>
              </div>
              @if (c.detail) { <div class="cm-detail">{{ c.detail }}</div> }

              @if (abierto() === c.id) {
                <div class="detalle">
                  <div class="campos">
                    <label class="field"><span>Responsable</span><input type="text" [ngModel]="c.owner" (ngModelChange)="pend[c.id] = { ...(pend[c.id] || {}), owner: $event }" /></label>
                    <label class="field"><span>Con quién / para quién</span><input type="text" [ngModel]="c.counterpart || ''" (ngModelChange)="pend[c.id] = { ...(pend[c.id] || {}), counterpart: $event }" /></label>
                    <label class="field"><span>Prioridad</span>
                      <select [ngModel]="c.priority" (ngModelChange)="pend[c.id] = { ...(pend[c.id] || {}), priority: $event }">
                        <option value="alta">alta</option><option value="media">media</option><option value="baja">baja</option>
                      </select>
                    </label>
                    <label class="field detalle-txt"><span>Detalle</span><textarea rows="2" [ngModel]="c.detail || ''" (ngModelChange)="pend[c.id] = { ...(pend[c.id] || {}), detail: $event }"></textarea></label>
                  </div>
                  <div class="row" style="margin-bottom:14px">
                    <span class="spacer"></span>
                    <button class="btn-primary sm" [disabled]="!pend[c.id]" (click)="guardarCampos(c)">Guardar cambios</button>
                  </div>

                  <div class="nota-row">
                    <input type="text" [(ngModel)]="notaNueva" placeholder="Feedback o avance: 'hablé con X, queda para el lunes'…" (keydown.enter)="agregarNota(c)" />
                    <button class="btn-secondary sm" (click)="agregarNota(c)" [disabled]="!notaNueva.trim()"><i class="ph ph-chat-text"></i> Nota</button>
                  </div>
                  <div class="hist">
                    @for (u of historial(); track u.id) {
                      <div class="hist-item">
                        <span class="hist-when">{{ u.at | friendlyDate }}</span>
                        <span class="tb kind">{{ u.kind }}</span>
                        <span class="hist-text">{{ u.text }}</span>
                        <span class="hist-by">{{ u.by }}</span>
                      </div>
                    } @empty { <div class="empty" style="padding:8px 0">Sin movimientos.</div> }
                  </div>
                </div>
              }
            </div>
          </div>
        }
      }
    </div>

    @if (modal()) {
      <div class="modal-backdrop" (click)="modal.set(false)">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head"><h3>Nuevo compromiso</h3><button class="btn-icon" (click)="modal.set(false)"><i class="ph ph-x"></i></button></div>
          <div class="modal-body">
            <label class="field"><span>Compromiso</span><input type="text" [(ngModel)]="form.title" placeholder="Ej: Enviar el informe de costos a Sebastián" autofocus /></label>
            <div class="dos">
              <label class="field"><span>Responsable</span><input type="text" [(ngModel)]="form.owner" placeholder="Jesús (o el nombre de quien te lo debe)" /></label>
              <label class="field"><span>Con quién / para quién</span><input type="text" [(ngModel)]="form.counterpart" /></label>
              <label class="field"><span>Fecha comprometida</span><input type="date" [(ngModel)]="form.due_date" /><small class="hint">Vacía = se sugiere una y queda marcada como "sugerida".</small></label>
              <label class="field"><span>Prioridad</span><select [(ngModel)]="form.priority"><option value="alta">alta</option><option value="media">media</option><option value="baja">baja</option></select></label>
            </div>
            <label class="field"><span>Detalle (opcional)</span><textarea rows="2" [(ngModel)]="form.detail"></textarea></label>
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="modal.set(false)">Cancelar</button>
            <button class="btn-primary" [disabled]="!form.title.trim() || guardando()" (click)="crear()">Guardar</button>
          </div>
        </div>
      </div>
    }

    @if (cierre(); as z) {
      <div class="modal-backdrop" (click)="cierre.set(null)">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head">
            <h3>{{ z.status === 'hecho' ? 'Marcar como hecho' : z.status === 'cancelado' ? 'Cancelar compromiso' : 'Avisar a la contraparte' }}</h3>
            <button class="btn-icon" (click)="cierre.set(null)"><i class="ph ph-x"></i></button>
          </div>
          <div class="modal-body">
            <p class="card-sub"><strong>{{ z.c.title }}</strong>@if (z.c.counterpart) { · con {{ z.c.counterpart }} }</p>
            <label class="field">
              <span>Mensaje para {{ z.c.counterpart || 'la contraparte' }}</span>
              <textarea rows="3" [(ngModel)]="z.message"></textarea>
              <small class="hint">Se envía tal cual por los canales que marques. Sin canales, solo se cambia el estado.</small>
            </label>
            <label class="field"><span>Avisar por</span></label>
            <app-delivery-picker [value]="z.delivery" (valueChange)="setDelivery($event)" />
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="cierre.set(null)">Cancelar</button>
            @if (z.status) { <button class="btn-secondary" (click)="confirmarCierre(false)">Solo {{ z.status === 'hecho' ? 'marcar hecho' : 'cancelar' }}</button> }
            <button class="btn-primary" [disabled]="!z.delivery.length || enviando()" (click)="confirmarCierre(true)"><i class="ph ph-paper-plane-tilt"></i> {{ z.status ? (z.status === 'hecho' ? 'Marcar y avisar' : 'Cancelar y avisar') : 'Enviar aviso' }}</button>
          </div>
        </div>
      </div>
    }

    @if (modalBackfill()) {
      <div class="modal-backdrop" (click)="modalBackfill.set(false)">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head"><h3>Backfill desde la memoria episódica</h3><button class="btn-icon" (click)="modalBackfill.set(false)"><i class="ph ph-x"></i></button></div>
          <div class="modal-body">
            <p class="card-sub">Recorre las reuniones, hilos de Chat y correos ya indexados en Qdrant y propone como compromisos las tareas que encuentre. Es idempotente (relanzarlo no duplica) y usa la IA para normalizar, así que tiene costo. Lo detectado entra como <strong>propuesto</strong>: nada se acepta solo.</p>
            <label class="field"><span>Solo desde esta fecha (opcional)</span><input type="date" [(ngModel)]="backfillDesde" /></label>
            @if (backfill(); as b) {
              <div class="bf">
                <div><b>{{ b.corriendo ? 'Corriendo…' : b.terminado ? 'Terminado' : 'Sin ejecutar' }}</b>@if (b.ultimo) { <span class="dim"> · último: {{ b.ultimo }}</span> }</div>
                <div class="dim">puntos {{ b.puntos }} · procesados {{ b.procesados }} · saltados {{ b.saltados }} · <b>nuevos {{ b.nuevos }}</b> · repetidos {{ b.repetidos }}</div>
                @if (b.error) { <div class="badge danger" style="margin-top:8px">{{ b.error }}</div> }
              </div>
            }
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="modalBackfill.set(false)">Cerrar</button>
            <button class="btn-primary" [disabled]="backfill()?.corriendo" (click)="lanzarBackfill()"><i class="ph ph-play"></i> Ejecutar</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .kpi { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--border-light); background: var(--bg-card); color: var(--text-main); cursor: pointer; text-align: left; }
    .kpi b { font-size: 22px; } .kpi span { font-size: 12px; color: var(--text-dim); }
    .kpi.on { border-color: var(--accent-primary); box-shadow: inset 0 0 0 1px var(--accent-primary); }
    .kpi.danger b { color: var(--danger); }
    .filtros { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
    .seg { display: inline-flex; border: 1px solid var(--border-light); border-radius: 8px; overflow: hidden; }
    .seg button { padding: 8px 12px; border: none; background: var(--bg-card); color: var(--text-dim); cursor: pointer; font-size: 13px; }
    .seg button.on { background: var(--accent-primary); color: #fff; }
    .buscar { flex: 1; min-width: 180px; max-width: 360px; }
    .cm { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
    .cm.vencido { border-color: rgba(239,68,68,.45); }
    .cm.propuesto { border-style: dashed; }
    .cm.cerrado { opacity: .6; }
    .cm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .cm-badges { display: flex; gap: 6px; flex-wrap: wrap; }
    .tb { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; background: var(--bg-main); color: var(--text-dim); }
    .tb.estado[data-estado=propuesto] { background: rgba(168,85,247,.16); color: #c084fc; }
    .tb.estado[data-estado=pendiente] { background: rgba(148,163,184,.16); color: #cbd5e1; }
    .tb.estado[data-estado=en_curso] { background: rgba(56,189,248,.16); color: #7dd3fc; }
    .tb.estado[data-estado=hecho] { background: rgba(16,185,129,.16); color: var(--ok); }
    .tb.quien.mio { background: rgba(129,140,248,.16); color: #a5b4fc; }
    .tb.prio { background: rgba(239,68,68,.14); color: var(--danger); }
    .tb.origen a { color: inherit; text-decoration: none; display: inline-flex; gap: 4px; align-items: center; }
    .tb.kind { text-transform: none; letter-spacing: 0; font-weight: 600; }
    .cm-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
    .ta { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border-light); background: var(--bg-main); color: var(--text-dim); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; }
    .ta:hover, .ta.on { border-color: var(--accent-primary); color: var(--accent-primary); }
    .ta.ok:hover { border-color: var(--ok); color: var(--ok); }
    .ta.del:hover { border-color: var(--danger); color: var(--danger); }
    .btn-primary.sm, .btn-secondary.sm { padding: 6px 11px; font-size: 12px; }
    .titulo { font-size: 15px; font-weight: 600; border-color: transparent; background: transparent; padding: 4px 6px; margin-left: -6px; }
    .titulo:hover, .titulo:focus { border-color: var(--border-light); background: var(--bg-input); }
    .cm-meta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 6px; font-size: 13px; color: var(--text-dim); }
    .fecha { display: inline-flex; align-items: center; gap: 6px; }
    .fecha input { width: auto; padding: 4px 8px; font-size: 13px; }
    .fecha.sugerida input { border-style: dashed; color: var(--text-dim); }
    .fecha small { font-size: 11px; } .fecha small.venc { color: var(--danger); font-weight: 700; }
    .con, .src { display: inline-flex; align-items: center; gap: 5px; }
    .src { max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .id { font-size: 11px; color: var(--text-dim); }
    .cm-detail { margin-top: 8px; font-size: 13.5px; color: var(--text-dim); white-space: pre-wrap; }
    .detalle { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--border-light); }
    .campos { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0 12px; }
    .campos .detalle-txt { grid-column: 1 / -1; }
    .nota-row { display: flex; gap: 8px; margin-bottom: 10px; }
    .hist-item { display: grid; grid-template-columns: 110px auto 1fr auto; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border-light); font-size: 13px; }
    .hist-when, .hist-by { color: var(--text-dim); font-size: 12px; }
    .dos { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
    .bf { margin-top: 6px; padding: 10px 12px; border-radius: 8px; background: var(--bg-main); font-size: 13px; }
    .dim { color: var(--text-dim); }
    @media (max-width: 640px) { .cm-head { flex-direction: column; } .dos { grid-template-columns: 1fr; } .hist-item { grid-template-columns: 1fr; gap: 2px; } }
  `],
})
export class CommitmentsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  items = signal<Commitment[]>([]);
  stats = signal<Record<string, number>>({});
  hoy = signal('');
  cargado = signal(false);
  vista = signal<Vista>('abiertos');
  quien = signal<'' | '1' | '0'>('');
  q = signal('');
  abierto = signal<string | null>(null);
  historial = signal<CommitmentUpdate[]>([]);
  modal = signal(false);
  modalBackfill = signal(false);
  backfill = signal<BackfillEstado | null>(null);
  guardando = signal(false);
  enviando = signal(false);
  cierre = signal<{ c: Commitment; status: CommitmentStatus | null; message: string; delivery: TaskDelivery[] } | null>(null);
  notaNueva = '';
  backfillDesde = '';
  pend: Record<string, Partial<Commitment>> = {};
  pendTitle: Record<string, string> = {};
  form = this.formVacio();
  private pollBackfill: any = null;

  total = computed(() => Object.entries(this.stats()).filter(([k]) => k !== 'vencidos').reduce((a, [, v]) => a + v, 0));
  filtrados = computed(() => {
    const f = this.q().trim().toLowerCase();
    const quien = this.quien();
    return this.items().filter((c) =>
      (quien === '' || String(c.mine) === quien) &&
      (!f || [c.title, c.detail, c.owner, c.counterpart, c.source_title, c.id].some((x) => (x || '').toLowerCase().includes(f))));
  });

  propuestosAntiguos = computed(() => this.filtrados().filter((c) => c.status === 'propuesto' && (c.due_date || c.proposed_due || '') < this.hoy() && (c.due_date || c.proposed_due)));

  constructor() { this.load(); }

  descartarAntiguos() {
    const ids = this.propuestosAntiguos().map((c) => c.id);
    if (!confirm(`¿Descartar ${ids.length} propuesto(s) con fecha anterior a hoy? Quedan en "Hechos" como descartados y se pueden reabrir.`)) return;
    this.api.bulkCommitments(ids, 'descartado', 'Descartado en lote: fecha anterior a hoy').subscribe({
      next: (r) => { this.toast.ok(`${r.actualizados} descartado(s)`); this.load(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo'),
    });
  }

  ir(v: Vista) { this.vista.set(v); this.load(); }

  load() {
    const p: Record<string, string> = {};
    switch (this.vista()) {
      case 'propuestos': p['status'] = 'propuesto'; break;
      case 'abiertos': p['status'] = 'pendiente,en_curso'; break;
      case 'vencidos': p['vencidos'] = '1'; break;
      case 'hechos': p['status'] = 'hecho,cancelado,descartado'; break;
    }
    this.api.getCommitments(p).subscribe({
      next: (r) => { this.items.set(r.items); this.stats.set(r.stats); this.hoy.set(r.hoy); this.cargado.set(true); this.cdr.markForCheck(); },
      error: (e) => { this.cargado.set(true); this.toast.error(e?.error?.error || 'No se pudieron cargar los compromisos'); },
    });
  }

  estadoLabel(s: CommitmentStatus) { return ESTADO_LABEL[s] || s; }
  origenLabel(s: string) { return ORIGEN_LABEL[s] || s; }
  vencido(c: Commitment) { return !!c.due_date && c.due_date < this.hoy() && (c.status === 'pendiente' || c.status === 'en_curso'); }

  // ─── Acciones ─────────────────────────────────────────────────────────
  aceptar(c: Commitment) {
    this.api.acceptCommitment(c.id, null).subscribe({
      next: (r) => { this.toast.ok(`Aceptado para el ${r.item.due_date}`); this.load(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo aceptar'),
    });
  }
  cambiarEstado(c: Commitment, status: CommitmentStatus) {
    this.api.updateCommitment(c.id, { status }).subscribe({
      next: () => { this.toast.ok(`${c.id}: ${ESTADO_LABEL[status]}`); this.load(); if (this.abierto() === c.id) this.cargarHistorial(c.id); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo cambiar'),
    });
  }
  abrirCierre(c: Commitment, status: CommitmentStatus | null) {
    this.cierre.set({ c, status, message: '', delivery: [] });
    this.api.getCommitmentDefaultMessage(c.id, status || undefined).subscribe({ next: (r) => { const z = this.cierre(); if (z && !z.message) { z.message = r.message; this.cierre.set({ ...z }); } }, error: () => {} });
  }
  setDelivery(d: TaskDelivery[]) { const z = this.cierre(); if (z) this.cierre.set({ ...z, delivery: d }); }
  confirmarCierre(avisar: boolean) {
    const z = this.cierre();
    if (!z) return;
    this.enviando.set(true);
    const fin = () => { this.enviando.set(false); this.cierre.set(null); this.load(); if (this.abierto() === z.c.id) this.cargarHistorial(z.c.id); };
    const notificar = () => this.api.notifyCommitment(z.c.id, z.delivery, z.message).subscribe({
      next: (r) => { this.toast.ok(`Avisado por ${r.enviados.join(' + ')}${r.fallos.length ? ' · fallos: ' + r.fallos.join(' · ') : ''}`); fin(); },
      error: (e) => { this.toast.error(e?.error?.error || 'No se pudo avisar'); fin(); },
    });
    if (z.status) {
      this.api.updateCommitment(z.c.id, { status: z.status }).subscribe({
        next: () => { if (avisar && z.delivery.length) notificar(); else { this.toast.ok(`${z.c.id}: ${ESTADO_LABEL[z.status!]}`); fin(); } },
        error: (e) => { this.toast.error(e?.error?.error || 'No se pudo cambiar'); this.enviando.set(false); },
      });
    } else if (avisar) notificar();
  }
  cambiarFecha(c: Commitment, fecha: string) {
    if (!fecha || fecha === c.due_date) return;
    const req = c.status === 'propuesto' ? this.api.acceptCommitment(c.id, fecha) : this.api.updateCommitment(c.id, { due_date: fecha });
    req.subscribe({ next: () => { this.toast.ok(`Fecha: ${fecha}`); this.load(); }, error: (e) => this.toast.error(e?.error?.error || 'No se pudo cambiar la fecha') });
  }
  guardarTitulo(c: Commitment) {
    const t = (this.pendTitle[c.id] || '').trim();
    if (!t || t === c.title) return;
    this.api.updateCommitment(c.id, { title: t }).subscribe({ next: () => { delete this.pendTitle[c.id]; this.load(); }, error: (e) => this.toast.error(e?.error?.error || 'No se pudo guardar') });
  }
  guardarCampos(c: Commitment) {
    const p = this.pend[c.id];
    if (!p) return;
    this.api.updateCommitment(c.id, p).subscribe({ next: () => { delete this.pend[c.id]; this.toast.ok('Guardado'); this.load(); this.cargarHistorial(c.id); }, error: (e) => this.toast.error(e?.error?.error || 'No se pudo guardar') });
  }
  eliminar(c: Commitment) {
    if (!confirm(`¿Eliminar "${c.title}"? Se pierde su historial.`)) return;
    this.api.deleteCommitment(c.id).subscribe({ next: () => { this.toast.ok('Eliminado'); this.load(); }, error: () => this.toast.error('No se pudo eliminar') });
  }
  toggleDetalle(c: Commitment) {
    if (this.abierto() === c.id) { this.abierto.set(null); return; }
    this.abierto.set(c.id); this.notaNueva = ''; this.cargarHistorial(c.id);
  }
  private cargarHistorial(id: string) {
    this.api.getCommitment(id).subscribe({ next: (r) => { this.historial.set(r.updates); this.cdr.markForCheck(); }, error: () => {} });
  }
  agregarNota(c: Commitment) {
    const t = this.notaNueva.trim();
    if (!t) return;
    this.api.addCommitmentNote(c.id, t).subscribe({ next: (r) => { this.historial.set(r.updates); this.notaNueva = ''; this.cdr.markForCheck(); }, error: () => this.toast.error('No se pudo guardar la nota') });
  }

  // ─── Nuevo ────────────────────────────────────────────────────────────
  private formVacio() { return { title: '', detail: '', owner: '', counterpart: '', due_date: '', priority: 'media' as 'alta' | 'media' | 'baja' }; }
  abrirNuevo() { this.form = this.formVacio(); this.modal.set(true); }
  crear() {
    this.guardando.set(true);
    const f = this.form;
    this.api.createCommitment({ title: f.title.trim(), detail: f.detail.trim() || null, owner: f.owner.trim() || undefined, counterpart: f.counterpart.trim() || null, due_date: f.due_date || null, priority: f.priority } as any).subscribe({
      next: (r) => { this.guardando.set(false); this.modal.set(false); this.toast.ok(r.item.due_date ? `Registrado para el ${r.item.due_date}` : `Registrado; fecha sugerida ${r.item.proposed_due}`); this.vista.set('abiertos'); this.load(); },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo crear'); },
    });
  }

  // ─── Backfill ─────────────────────────────────────────────────────────
  abrirBackfill() {
    this.modalBackfill.set(true);
    this.api.getCommitmentsBackfill().subscribe({ next: (b) => { this.backfill.set(b); this.cdr.markForCheck(); if (b.corriendo) this.seguirBackfill(); }, error: () => {} });
  }
  lanzarBackfill() {
    this.api.startCommitmentsBackfill(this.backfillDesde || undefined).subscribe({
      next: (b) => { this.backfill.set(b); this.seguirBackfill(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo lanzar'),
    });
  }
  private seguirBackfill() {
    clearInterval(this.pollBackfill);
    this.pollBackfill = setInterval(() => {
      this.api.getCommitmentsBackfill().subscribe({ next: (b) => {
        this.backfill.set(b); this.cdr.markForCheck();
        if (!b.corriendo) { clearInterval(this.pollBackfill); this.load(); if (!b.error) this.toast.ok(`Backfill listo: ${b.nuevos} propuesto(s)`); }
      } });
    }, 2000);
  }
}
