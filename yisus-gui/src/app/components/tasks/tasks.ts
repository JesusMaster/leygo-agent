import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, TareaIntegrada, ScheduledTask, TaskRun, TaskKind, TaskInput, TaskChannel, TaskDelivery } from '../../services/api.service';
import { ModelPickerComponent } from '../model-picker/model-picker';
import { DeliveryPickerComponent } from './delivery-picker';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';

/**
 * Tareas programadas, calcadas de la vista de Leygo: una tarjeta por tarea con
 * tipo y modo, instrucción, horario y próxima ejecución; acciones de ejecutar
 * ahora, historial, pausar, editar en línea y eliminar; y un modal para crear.
 */
@Component({
  selector: 'app-tasks',
  imports: [FormsModule, FriendlyDatePipe, DeliveryPickerComponent, ModelPickerComponent],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Tareas programadas</h2>
          <p class="sub">Recordatorios y rutinas automáticas de Yisus. Una acción autónoma la trabaja el agente con sus herramientas y te reporta por Telegram.</p>
        </div>
        <button class="btn-primary" (click)="abrirNueva()"><i class="ph ph-plus"></i> Nueva tarea</button>
      </div>

      <div class="tabs">
        <button class="tab" [class.on]="pestana() === 'mias'" (click)="ir('mias')"><i class="ph ph-user"></i> Mis tareas <span class="cnt">{{ mias().length }}</span></button>
        <button class="tab" [class.on]="pestana() === 'sistema'" (click)="ir('sistema')"><i class="ph ph-puzzle-piece"></i> Rutinas del sistema <span class="cnt">{{ sistema().length }}</span></button>
        <button class="tab" [class.on]="pestana() === 'finalizadas'" (click)="ir('finalizadas')"><i class="ph ph-check-circle"></i> Finalizadas <span class="cnt">{{ finalizadas().length }}</span></button>
      </div>

      @if (!cargado()) {
        <div class="empty">Cargando tareas…</div>
      } @else if (visibles().length === 0) {
        <div class="card empty-state">
          @switch (pestana()) {
            @case ('mias') {
              <i class="ph ph-calendar-check"></i>
              <h3>Todavía no hay tareas tuyas</h3>
              <p>Programa un recordatorio de una vez, una rutina diaria o una expresión cron. También puedes pedírselo al agente por chat: "todos los días a las 8:45 revisa mi agenda".</p>
              <button class="btn-primary" (click)="abrirNueva()"><i class="ph ph-plus"></i> Nueva tarea</button>
            }
            @case ('sistema') {
              <i class="ph ph-puzzle-piece"></i>
              <h3>Sin rutinas del sistema</h3>
              <p>Morning Digest, aviso de compromisos, sync de Meet y consolidación se pueden volver a programar desde "Nueva tarea".</p>
            }
            @default {
              <i class="ph ph-check-circle"></i>
              <h3>Nada finalizado</h3>
              <p>Acá quedan las tareas de una sola vez que ya se ejecutaron.</p>
            }
          }
        </div>
      } @else {
        @if (pestana() === 'finalizadas') {
          <div class="row" style="margin-bottom:12px">
            <span class="spacer"></span>
            <button class="btn-secondary" (click)="limpiarFinalizadas()"><i class="ph ph-broom"></i> Eliminar todas las finalizadas ({{ finalizadas().length }})</button>
          </div>
        }
        @for (t of visibles(); track t.id) {
          <div class="task" [class.paused]="t.status === 'paused'" [class.done]="t.status === 'done'">
            <div class="task-head">
              <div class="task-badges">
              <span class="tb kind"><i class="ph" [class]="'ph ' + iconoTipo(t.kind)"></i> {{ etiquetaTipo(t.kind) }}</span>
              @if (t.autonomous === 2) { <span class="tb sys"><i class="ph ph-puzzle-piece"></i> Rutina del sistema</span> }
              @else if (t.autonomous) { <span class="tb agent"><i class="ph ph-robot"></i> Acción de agente</span> }
              @else { <span class="tb plain"><i class="ph ph-bell"></i> Recordatorio</span> }
              @for (d of t.delivery; track d.channel + (d.target || '')) {
                <span class="tb chan" [title]="d.target || ''"><i class="ph" [class]="'ph ' + iconoCanal(d.channel)"></i> {{ etiquetaCanal(d.channel) }}</span>
              }
              @if (t.autonomous === 1 && t.model) { <span class="tb model" [title]="t.model"><i class="ph ph-cpu"></i> {{ modeloCorto(t.model) }}</span> }
              @if (t.status === 'paused') { <span class="badge warn">PAUSADA</span> }
              @if (t.status === 'done') { <span class="badge dim">EJECUTADA</span> }
              </div>
              <div class="task-actions">
                <button class="ta ejecutar" title="Ejecutar ahora" [disabled]="ejecutando() === t.id" (click)="ejecutar(t)">
                  @if (ejecutando() === t.id) { <span class="spinner"></span> } @else { <i class="ph ph-play"></i> }
                </button>
                <button class="ta hist" [class.on]="historial() === t.id" title="Historial de ejecuciones" (click)="toggleHistorial(t)"><i class="ph ph-clock-counter-clockwise"></i></button>
                @if (t.status !== 'done') {
                  <button class="ta pause" [title]="t.status === 'paused' ? 'Reanudar' : 'Pausar'" (click)="alternar(t)">
                    <i class="ph" [class.ph-pause]="t.status === 'active'" [class.ph-play-circle]="t.status === 'paused'"></i>
                  </button>
                }
                <button class="ta edit" title="Editar" (click)="editar(t)"><i class="ph ph-pencil-simple"></i></button>
                <button class="ta del" title="Eliminar" (click)="eliminar(t)"><i class="ph ph-trash"></i></button>
              </div>
            </div>

            <div class="task-main">
              <div class="task-body">
                <h3 class="task-title">{{ titulo(t) }}</h3>

                @if (editando() === t.id) {
                  @if (t.autonomous !== 2) { <textarea class="task-edit" rows="3" [(ngModel)]="editForm.message"></textarea> }
                  <div class="dos-col" style="margin-top:12px">
                    <label class="field">
                      <span>Cuándo</span>
                      <select [(ngModel)]="editForm.kind">
                        <option value="once">Una vez (fecha)</option>
                        <option value="interval">Cada N minutos</option>
                        <option value="daily">Diaria (hora exacta)</option>
                        <option value="cron">Cron</option>
                      </select>
                    </label>
                    @switch (editForm.kind) {
                      @case ('once') { <label class="field"><span>Fecha y hora</span><input type="datetime-local" [(ngModel)]="editForm.run_at" /></label> }
                      @case ('interval') { <label class="field"><span>Cada cuántos minutos</span><input type="number" min="1" step="1" [(ngModel)]="editForm.interval_minutes" /></label> }
                      @case ('daily') { <label class="field"><span>Hora (America/Santiago)</span><input type="time" [(ngModel)]="editForm.time_of_day" /></label> }
                      @case ('cron') { <label class="field"><span>Expresión cron</span><input type="text" class="mono" [(ngModel)]="editForm.cron_expr" placeholder="0 9 * * 1-5" /></label> }
                    }
                  </div>
                  @if (t.autonomous === 1) {
                    <div class="field"><span>Modelo que procesa la tarea</span></div>
                    <app-model-picker [value]="editForm.model" (valueChange)="editForm.model = $event" />
                  }
                  <div class="field" style="margin-top:12px"><span>Entregar por</span></div>
                  <app-delivery-picker [value]="editForm.delivery" (valueChange)="editForm.delivery = $event" />
                  <div class="row" style="margin-top:12px">
                    <button class="btn-secondary" (click)="editando.set(null)">Cancelar</button>
                    <button class="btn-primary" [disabled]="!edicionValida(t)" (click)="guardarEdicion(t)">Guardar</button>
                  </div>
                } @else {
                  <div class="task-msg">{{ t.integrada ? t.integrada.descripcion : t.message }}</div>
                }

                <div class="task-when">
                  {{ t.descripcion }}
                  @if (t.next_run_at) { · Próxima ejecución: <strong>{{ fecha(t.next_run_at) }}</strong> }
                  @if (t.last_run_at) { · Última: {{ t.last_run_at | friendlyDate }} }
                </div>
              </div>

            </div>

            @if (historial() === t.id) {
              <div class="task-history">
                <div class="th-title"><i class="ph ph-list-bullets"></i> Historial de ejecuciones</div>
                @if (!runs()) { <div class="empty">Cargando…</div> }
                @else if (runs()!.length === 0) { <div class="empty">Todavía no se ha ejecutado.</div> }
                @else {
                  <div class="runs">
                    @for (r of runs(); track r.id + '-' + r.started_at) {
                      <div class="corrida" [class.err]="r.status === 'error'">
                        <div class="corrida-head">
                          @if (r.status === 'success') { <span class="badge ok"><i class="ph ph-check-circle"></i> Éxito</span> }
                          @else { <span class="badge danger"><i class="ph ph-x-circle"></i> Error</span> }
                          <span class="corrida-meta"><i class="ph" [class.ph-alarm]="r.trigger === 'scheduled'" [class.ph-hand-pointing]="r.trigger === 'manual'"></i> {{ r.trigger === 'manual' ? 'Manual' : 'Programado' }}</span>
                          <span class="corrida-meta">{{ r.started_at | friendlyDate }}</span>
                          <span class="corrida-meta dim">{{ r.duration_ms }}ms</span>
                        </div>
                        <div class="corrida-label">
                          <span>Resultado</span>
                          <button class="btn-link" (click)="toggleVer(r)">{{ abierto(r) ? 'Plegar' : 'Ver todo' }}</button>
                        </div>
                        <pre class="corrida-pre" [class.open]="abierto(r)">{{ r.result || '—' }}</pre>
                      </div>
                    }
                  </div>
                }
              </div>
            }
          </div>
        }
      }
    </div>

    <!-- ─── Modal: programar tarea ───────────────────────────────────────── -->
    @if (modal()) {
      <div class="modal-backdrop" (click)="cerrarModal()">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head">
            <h3>Programar tarea</h3>
            <button class="btn-icon" (click)="cerrarModal()"><i class="ph ph-x"></i></button>
          </div>
          <div class="modal-body">
            @if (integradasDisponibles().length) {
              <label class="field">
                <span>Qué programar</span>
                <select [(ngModel)]="form.integrada">
                  <option value="">Un mensaje o instrucción propia</option>
                  @for (i of integradasDisponibles(); track i.key) { <option [value]="i.key">Rutina del sistema: {{ i.titulo }}</option> }
                </select>
              </label>
            }
            @if (form.integrada) {
              <p class="hint" style="margin:-6px 0 14px">{{ descripcionIntegrada(form.integrada) }}</p>
            } @else {
              <label class="field">
                <span>Mensaje o instrucción</span>
                <textarea rows="4" [(ngModel)]="form.message" placeholder="Ej: Recordarme llamar a Pablo · o · Revisa mi agenda del día y envíame un resumen de mis reuniones"></textarea>
              </label>

              <label class="check">
                <input type="checkbox" [(ngModel)]="form.autonomous" />
                <span><strong>Es una acción autónoma</strong> (el agente trabajará en esto con sus herramientas y te reporta el resultado)</span>
              </label>
              @if (form.autonomous) {
                <div class="field"><span>Modelo que procesa la tarea</span></div>
                <app-model-picker [value]="form.model" (valueChange)="form.model = $event" />
                <small class="hint" style="display:block;margin:-6px 0 14px">Por defecto usa el modelo del Coordinator (Ajustes → Modelos por agente). Cámbialo si esta tarea merece uno más barato o más capaz.</small>
              }
            }

            <div class="dos-col">
              <label class="field">
                <span>Tipo de tarea</span>
                <select [(ngModel)]="form.kind">
                  <option value="once">Una vez (fecha)</option>
                  <option value="interval">Recurrente (cada N minutos)</option>
                  <option value="daily">Diaria (hora exacta)</option>
                  <option value="cron">Avanzado (expresión cron)</option>
                </select>
              </label>

              @switch (form.kind) {
                @case ('once') {
                  <label class="field"><span>Fecha y hora</span><input type="datetime-local" [(ngModel)]="form.run_at" /></label>
                }
                @case ('interval') {
                  <label class="field"><span>Cada cuántos minutos</span><input type="number" min="1" step="1" [(ngModel)]="form.interval_minutes" placeholder="30" /></label>
                }
                @case ('daily') {
                  <label class="field"><span>Hora (America/Santiago)</span><input type="time" [(ngModel)]="form.time_of_day" /></label>
                }
                @case ('cron') {
                  <label class="field"><span>Expresión cron (ej: 0 10-18 * * 1-5)</span><input type="text" class="mono" [(ngModel)]="form.cron_expr" placeholder="0 9 * * 1-5" /></label>
                }
              }
            </div>
            @if (form.kind === 'cron') {
              <small class="hint">minuto · hora · día del mes · mes · día de la semana. <code>0 9 * * 1-5</code> = lunes a viernes a las 9:00.</small>
            }

            <label class="field" style="margin-top:14px"><span>Entregar por (uno o varios)</span></label>
            <app-delivery-picker [value]="form.delivery" (valueChange)="form.delivery = $event" />
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="cerrarModal()">Cancelar</button>
            <button class="btn-primary" [disabled]="!formValido() || guardando()" (click)="crear()">Guardar tarea</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .tabs { display: flex; gap: 6px; margin-bottom: 18px; border-bottom: 1px solid var(--border-light); overflow-x: auto; }
    .tab { display: inline-flex; align-items: center; gap: 8px; padding: 10px 14px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--text-dim); font-size: 14px; cursor: pointer; white-space: nowrap; margin-bottom: -1px; }
    .tab i { font-size: 17px; }
    .tab:hover { color: var(--text-main); }
    .tab.on { color: var(--accent-primary); border-bottom-color: var(--accent-primary); }
    .tab .cnt { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--bg-main); color: var(--text-dim); }
    .tab.on .cnt { background: rgba(129,140,248,.18); color: var(--accent-primary); }
    .tb.sys { background: rgba(168,85,247,.14); color: #c084fc; }
    .tb.model { background: rgba(56,189,248,.14); color: #7dd3fc; text-transform: none; letter-spacing: 0; }
    .task { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; padding: 20px 22px; margin-bottom: 16px; transition: border-color .15s; }
    .task:hover { border-color: var(--accent-primary); }
    .task.paused { opacity: .85; }
    .task.done { opacity: .7; }

    .task-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
    .task-badges { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .tb { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .tb.kind { background: rgba(45,212,191,.14); color: #5eead4; }
    .tb.agent { background: rgba(129,140,248,.16); color: #a5b4fc; }
    .tb.chan { background: rgba(251,146,60,.14); color: #fdba74; }
    .tb.plain { background: var(--bg-input); color: var(--text-dim); border: 1px solid var(--border-light); }

    .task-main { display: block; }
    .task-body { flex: 1; min-width: 0; }
    .task-title { margin: 0 0 10px; font-size: 17px; }
    .task-msg { padding: 12px 14px; border-radius: 10px; background: var(--bg-input); border: 1px solid var(--border-light); color: var(--text-dim); font-style: italic; font-size: 14px; line-height: 1.55; white-space: pre-wrap; }
    .task-edit { width: 100%; font-size: 14px; line-height: 1.55; }
    .task-when { margin-top: 12px; color: var(--text-dim); font-size: 13.5px; }
    .task-when strong { color: var(--text-main); font-weight: 500; }

    .task-actions { display: flex; gap: 2px; flex: 0 0 auto; padding: 2px; border-radius: 10px; background: var(--bg-input); border: 1px solid var(--border-light); }
    .ta { width: 34px; height: 34px; border-radius: 8px; border: 0; background: transparent; cursor: pointer; font-size: 18px; display: grid; place-items: center; color: var(--text-dim); transition: background .12s, color .12s; outline: none; }
    .ta:hover { background: var(--bg-card); }
    .ta:focus-visible { box-shadow: 0 0 0 2px var(--accent-primary) inset; }
    .ta:disabled { cursor: default; }
    .ta.ejecutar { color: var(--ok); }
    .ta.hist.on { background: var(--bg-card); color: var(--accent-primary); }
    .ta.pause { color: var(--warn); }
    .ta.edit { color: var(--accent-primary); }
    .ta.del { color: var(--danger); }
    .spinner { width: 15px; height: 15px; border-radius: 50%; border: 2px solid rgba(16,185,129,.25); border-top-color: var(--ok); animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .task-history { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border-light); }
    .th-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; margin-bottom: 12px; }
    .th-title i { color: var(--accent-primary); }
    .runs { max-height: 520px; overflow: auto; padding-right: 6px; }
    .corrida { border: 1px solid var(--border-light); border-left: 3px solid var(--ok); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; background: var(--bg-input); }
    .corrida.err { border-left-color: var(--danger); }
    .corrida-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .corrida-head .badge i { font-size: 13px; }
    .corrida-meta { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: var(--text-dim); }
    .corrida-meta.dim { opacity: .7; font-size: 12px; }
    .corrida-label { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-dim); }
    .btn-link { background: none; border: 0; padding: 0; color: var(--accent-primary); cursor: pointer; font: inherit; font-size: 12px; text-transform: none; letter-spacing: 0; }
    .btn-link:hover { text-decoration: underline; }
    .corrida-pre { margin: 0; padding: 12px 14px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border-light); font-family: inherit; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: var(--text-main); max-height: 150px; overflow: hidden; position: relative; }
    .corrida-pre:not(.open)::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 40px; background: linear-gradient(transparent, var(--bg-card)); }
    .corrida-pre.open { max-height: none; overflow: auto; }

    .empty-state { text-align: center; padding: 48px 24px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .empty-state > i { font-size: 40px; color: var(--accent-primary); }
    .empty-state p { color: var(--text-dim); max-width: 56ch; margin: 0 0 8px; }

    .dos-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .dos-col .field { margin: 0; }
    .modal input[type=time], .modal input[type=datetime-local], .modal input[type=number], .modal input[type=text], .modal select { width: 100%; box-sizing: border-box; }
    @media (max-width: 560px) { .dos-col { grid-template-columns: 1fr; } }
    .check { display: flex; align-items: flex-start; gap: 10px; margin: 4px 0 16px; cursor: pointer; font-size: 14px; }
    .check input { width: 16px; height: 16px; margin-top: 2px; accent-color: var(--accent-primary); }
    .field .hint, .hint { display: block; margin-top: 8px; color: var(--text-dim); font-size: 12px; }
    .hint.warn { color: var(--warn); }
    .hint code { background: var(--bg-input); padding: 1px 5px; border-radius: 4px; }

    @media (max-width: 720px) {
      .task { padding: 14px; }
      .task-head { flex-direction: column; }
      .task-actions { align-self: flex-end; }
      .task-title { font-size: 15.5px; }
      .task-msg { font-size: 13.5px; }
      .runs { max-height: none; padding-right: 0; }
    }
  `],
})
export class TasksComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  items = signal<ScheduledTask[]>([]);
  pestana = signal<'mias' | 'sistema' | 'finalizadas'>((localStorage.getItem('yisus_tasks_tab') as any) || 'mias');
  mias = computed(() => this.items().filter((t) => t.autonomous !== 2 && t.status !== 'done'));
  sistema = computed(() => this.items().filter((t) => t.autonomous === 2 && t.status !== 'done'));
  finalizadas = computed(() => this.items().filter((t) => t.status === 'done'));
  visibles = computed(() => this.pestana() === 'mias' ? this.mias() : this.pestana() === 'sistema' ? this.sistema() : this.finalizadas());
  ir(p: 'mias' | 'sistema' | 'finalizadas') { this.pestana.set(p); try { localStorage.setItem('yisus_tasks_tab', p); } catch {} }
  limpiarFinalizadas() {
    const lista = this.finalizadas();
    if (!lista.length || !confirm(`¿Eliminar ${lista.length} tarea(s) finalizada(s) y su historial?`)) return;
    let pend = lista.length;
    for (const t of lista) this.api.deleteTask(t.id).subscribe({ next: () => { if (--pend === 0) { this.toast.ok('Finalizadas eliminadas'); this.load(); } }, error: () => { if (--pend === 0) this.load(); } });
  }
  cargado = signal(false);
  editando = signal<string | null>(null);
  editForm: { message: string; delivery: TaskDelivery[]; kind: TaskKind; run_at: string; interval_minutes: number | null; time_of_day: string; cron_expr: string; model: string } = { message: '', delivery: [{ channel: 'telegram' }], kind: 'daily', run_at: '', interval_minutes: null, time_of_day: '09:00', cron_expr: '', model: '' };
  integradas = signal<TareaIntegrada[]>([]);
  /** Rutinas del sistema que no tienen tarea (p. ej. si se borró): se pueden volver a programar */
  integradasDisponibles = computed(() => this.integradas().filter((i) => !this.items().some((t) => t.autonomous === 2 && t.message === i.key)));
  ejecutando = signal<string | null>(null);
  historial = signal<string | null>(null);
  runs = signal<TaskRun[] | null>(null);
  private abiertos = new Set<string>();

  modal = signal(false);
  guardando = signal(false);
  form: { message: string; autonomous: boolean; integrada: string; model: string; kind: TaskKind; run_at: string; interval_minutes: number | null; time_of_day: string; cron_expr: string; delivery: TaskDelivery[] } = this.formVacio();

  constructor() { this.load(); }

  load() {
    this.api.getTasks().subscribe({
      next: (r) => { this.items.set(r.tasks || []); this.integradas.set(r.integradas || []); this.cargado.set(true); },
      error: () => { this.cargado.set(true); this.toast.error('No se pudieron cargar las tareas'); },
    });
  }

  // ─── Presentación ────────────────────────────────────────────────────
  modeloCorto(m: string) { const i = m.indexOf('/'); return i > 0 ? m.slice(i + 1) : m; }
  descripcionIntegrada(key: string) { return this.integradas().find((i) => i.key === key)?.descripcion || ''; }
  titulo(t: ScheduledTask): string {
    if (t.integrada) return t.integrada.titulo;
    if (t.autonomous === 2) return `Rutina del sistema: ${t.message} (no registrada en este backend)`;
    const m = t.message.trim().replace(/\s+/g, ' ');
    const corte = m.length > 60 ? m.slice(0, 60).replace(/\s\S*$/, '') + '…' : m;
    return (t.autonomous ? 'Rutina: ' : 'Recordatorio: ') + corte;
  }
  etiquetaCanal(c: TaskChannel) { return { telegram: 'Telegram', chat: 'Google Chat', buzz: 'Buzz', email: 'Email', a2a: 'Agente A2A' }[c || 'telegram']; }
  iconoCanal(c: TaskChannel) { return { telegram: 'ph-telegram-logo', chat: 'ph-chats-circle', buzz: 'ph-broadcast', email: 'ph-envelope-simple', a2a: 'ph-robot' }[c || 'telegram']; }
  etiquetaTipo(k: TaskKind) { return { once: 'Una vez', interval: 'Recurrente', daily: 'Diario', cron: 'Cron' }[k]; }
  iconoTipo(k: TaskKind) { return { once: 'ph-calendar-blank', interval: 'ph-arrows-clockwise', daily: 'ph-sun', cron: 'ph-code' }[k]; }
  fecha(ms: number) { return new Date(ms).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' }); }

  // ─── Acciones ────────────────────────────────────────────────────────
  ejecutar(t: ScheduledTask) {
    this.ejecutando.set(t.id);
    this.api.runTask(t.id).subscribe({
      next: (r) => {
        this.ejecutando.set(null);
        r.run.status === 'success' ? this.toast.ok('Ejecutada. El resultado se entregó por ' + t.delivery.map((d) => this.etiquetaCanal(d.channel)).join(' + ') + '.') : this.toast.error(`Falló: ${r.run.result?.slice(0, 120)}`);
        this.load();
        if (this.historial() === t.id) this.cargarRuns(t.id);
      },
      error: (e) => { this.ejecutando.set(null); this.toast.error(e?.error?.error || 'No se pudo ejecutar'); },
    });
  }

  alternar(t: ScheduledTask) {
    const status = t.status === 'paused' ? 'active' : 'paused';
    this.api.updateTask(t.id, { status }).subscribe({
      next: () => { this.load(); this.toast.ok(status === 'paused' ? 'Tarea pausada' : 'Tarea reanudada'); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo cambiar el estado'),
    });
  }

  editar(t: ScheduledTask) {
    this.editForm = {
      message: t.message, delivery: (t.delivery || []).map((d) => ({ ...d })), kind: t.kind,
      run_at: t.run_at ? this.aLocal(t.run_at) : '', interval_minutes: t.interval_minutes, time_of_day: t.time_of_day || '09:00', cron_expr: t.cron_expr || '', model: t.model || '',
    };
    this.editando.set(t.id);
  }
  private aLocal(ms: number) { const d = new Date(ms); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
  private horarioValido(f: { kind: TaskKind; run_at: string; interval_minutes: number | null; time_of_day: string; cron_expr: string }): boolean {
    switch (f.kind) {
      case 'once': return !!f.run_at && new Date(f.run_at).getTime() > Date.now();
      case 'interval': return !!f.interval_minutes && f.interval_minutes >= 1;
      case 'daily': return /^\d{2}:\d{2}$/.test(f.time_of_day);
      case 'cron': return f.cron_expr.trim().split(/\s+/).length === 5;
    }
  }
  private horarioDe(f: { kind: TaskKind; run_at: string; interval_minutes: number | null; time_of_day: string; cron_expr: string }): Partial<TaskInput> {
    const out: Partial<TaskInput> = { kind: f.kind };
    if (f.kind === 'once') out.run_at = new Date(f.run_at).toISOString();
    if (f.kind === 'interval') out.interval_minutes = f.interval_minutes;
    if (f.kind === 'daily') out.time_of_day = f.time_of_day;
    if (f.kind === 'cron') out.cron_expr = f.cron_expr.trim();
    return out;
  }
  edicionValida(t: ScheduledTask): boolean {
    const f = this.editForm;
    if (!f.message.trim() || !DeliveryPickerComponent.valida(f.delivery) || !this.horarioValido(f)) return false;
    return true;
  }
  private limpia(d: TaskDelivery[]) { return d.map((x) => ({ channel: x.channel, target: x.channel === 'telegram' ? null : ((x.target || '').trim() || null) })); }
  guardarEdicion(t: ScheduledTask) {
    const f = this.editForm;
    this.api.updateTask(t.id, { ...(t.autonomous === 2 ? {} : { message: f.message.trim() }), ...(t.autonomous === 1 ? { model: f.model || null } : {}), delivery: this.limpia(f.delivery), ...this.horarioDe(f) }).subscribe({
      next: () => { this.editando.set(null); this.load(); this.toast.ok('Tarea actualizada'); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo guardar'),
    });
  }

  eliminar(t: ScheduledTask) {
    if (!confirm(t.autonomous === 2 ? `¿Eliminar la rutina "${t.integrada?.titulo || t.message}"? Podrás volver a programarla desde "Nueva tarea".` : `¿Eliminar esta tarea?\n\n"${t.message.slice(0, 120)}"`)) return;
    this.api.deleteTask(t.id).subscribe({
      next: () => { if (this.historial() === t.id) this.historial.set(null); this.load(); this.toast.ok('Tarea eliminada'); },
      error: () => this.toast.error('No se pudo eliminar'),
    });
  }

  // ─── Historial ───────────────────────────────────────────────────────
  toggleHistorial(t: ScheduledTask) {
    if (this.historial() === t.id) { this.historial.set(null); return; }
    this.historial.set(t.id); this.runs.set(null); this.cargarRuns(t.id);
  }
  private cargarRuns(id: string) {
    this.api.getTaskRuns(id, 20).subscribe({
      next: (r) => this.runs.set(r.runs || []),
      error: () => { this.runs.set([]); this.toast.error('No se pudo cargar el historial'); },
    });
  }
  toggleVer(r: TaskRun) { const k = `${r.id}-${r.started_at}`; this.abiertos.has(k) ? this.abiertos.delete(k) : this.abiertos.add(k); this.runs.update((x) => x ? [...x] : x); }
  abierto(r: TaskRun) { return this.abiertos.has(`${r.id}-${r.started_at}`); }

  // ─── Crear ───────────────────────────────────────────────────────────
  private formVacio() { return { message: '', autonomous: false, integrada: '', model: '', kind: 'once' as TaskKind, run_at: '', interval_minutes: null as number | null, time_of_day: '09:00', cron_expr: '', delivery: [{ channel: 'telegram' as TaskChannel }] as TaskDelivery[] }; }
  abrirNueva() { this.form = this.formVacio(); if (this.pestana() === 'sistema') { this.form.integrada = this.integradasDisponibles()[0]?.key || ''; this.form.kind = 'daily'; } this.modal.set(true); }
  cerrarModal() { if (!this.guardando()) this.modal.set(false); }

  formValido(): boolean {
    const f = this.form;
    if ((!f.integrada && !f.message.trim()) || !DeliveryPickerComponent.valida(f.delivery)) return false;
    return this.horarioValido(f);
  }

  crear() {
    const f = this.form;
    const datos: TaskInput = f.integrada
      ? { message: f.integrada, autonomous: 2, kind: f.kind, delivery: this.limpia(f.delivery), ...this.horarioDe(f) }
      : { message: f.message.trim(), autonomous: f.autonomous, kind: f.kind, delivery: this.limpia(f.delivery), ...(f.autonomous && f.model ? { model: f.model } : {}), ...this.horarioDe(f) };
    this.guardando.set(true);
    this.api.createTask(datos).subscribe({
      next: () => { this.guardando.set(false); this.modal.set(false); this.load(); this.toast.ok('Tarea programada'); },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo programar'); },
    });
  }
}
