import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ScheduledTask, TaskRun, TaskKind, TaskInput } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';

/**
 * Tareas programadas, calcadas de la vista de Leygo: una tarjeta por tarea con
 * tipo y modo, instrucción, horario y próxima ejecución; acciones de ejecutar
 * ahora, historial, pausar, editar en línea y eliminar; y un modal para crear.
 */
@Component({
  selector: 'app-tasks',
  imports: [FormsModule, FriendlyDatePipe],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Tareas programadas</h2>
          <p class="sub">Recordatorios y rutinas automáticas de Yisus. Una acción autónoma la trabaja el agente con sus herramientas y te reporta por Telegram.</p>
        </div>
        <button class="btn-primary" (click)="abrirNueva()"><i class="ph ph-plus"></i> Nueva tarea</button>
      </div>

      @if (!cargado()) {
        <div class="empty">Cargando tareas…</div>
      } @else if (items().length === 0) {
        <div class="card empty-state">
          <i class="ph ph-calendar-check"></i>
          <h3>Todavía no hay tareas</h3>
          <p>Programa un recordatorio de una vez, una rutina diaria o una expresión cron. También puedes pedírselo al agente por chat: "todos los días a las 8:45 revisa mi agenda".</p>
          <button class="btn-primary" (click)="abrirNueva()"><i class="ph ph-plus"></i> Nueva tarea</button>
        </div>
      } @else {
        @for (t of items(); track t.id) {
          <div class="task" [class.paused]="t.status === 'paused'" [class.done]="t.status === 'done'">
            <div class="task-badges">
              <span class="tb kind"><i class="ph" [class]="'ph ' + iconoTipo(t.kind)"></i> {{ etiquetaTipo(t.kind) }}</span>
              @if (t.autonomous) { <span class="tb agent"><i class="ph ph-robot"></i> Acción de agente</span> }
              @else { <span class="tb plain"><i class="ph ph-bell"></i> Recordatorio</span> }
              @if (t.status === 'paused') { <span class="badge warn">PAUSADA</span> }
              @if (t.status === 'done') { <span class="badge dim">EJECUTADA</span> }
            </div>

            <div class="task-main">
              <div class="task-body">
                <h3 class="task-title">{{ titulo(t) }}</h3>

                @if (editando() === t.id) {
                  <textarea class="task-edit" rows="3" [(ngModel)]="textoEdit"></textarea>
                  <div class="row" style="margin-top:10px">
                    <button class="btn-secondary" (click)="editando.set(null)">Cancelar</button>
                    <button class="btn-primary" [disabled]="!textoEdit.trim() || textoEdit.trim() === t.message" (click)="guardarEdicion(t)">Guardar</button>
                  </div>
                } @else {
                  <div class="task-msg">{{ t.message }}</div>
                }

                <div class="task-when">
                  {{ t.descripcion }}
                  @if (t.next_run_at) { · Próxima ejecución: <strong>{{ fecha(t.next_run_at) }}</strong> }
                  @if (t.last_run_at) { · Última: {{ t.last_run_at | friendlyDate }} }
                </div>
              </div>

              <div class="task-actions">
                <button class="ta run" title="Ejecutar ahora" [disabled]="ejecutando() === t.id" (click)="ejecutar(t)">
                  <i class="ph" [class.ph-play-circle]="ejecutando() !== t.id" [class.ph-circle-notch]="ejecutando() === t.id" [class.spin]="ejecutando() === t.id"></i>
                </button>
                <button class="ta hist" [class.on]="historial() === t.id" title="Historial de ejecuciones" (click)="toggleHistorial(t)"><i class="ph ph-clock-counter-clockwise"></i></button>
                @if (t.status !== 'done') {
                  <button class="ta pause" [title]="t.status === 'paused' ? 'Reanudar' : 'Pausar'" (click)="alternar(t)">
                    <i class="ph" [class.ph-pause]="t.status === 'active'" [class.ph-play]="t.status === 'paused'"></i>
                  </button>
                }
                <button class="ta edit" title="Editar instrucción" (click)="editar(t)"><i class="ph ph-pencil-simple-line"></i></button>
                <button class="ta del" title="Eliminar" (click)="eliminar(t)"><i class="ph ph-trash"></i></button>
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
                      <div class="run" [class.err]="r.status === 'error'">
                        <div class="run-head">
                          @if (r.status === 'success') { <span class="badge ok"><i class="ph ph-check-circle"></i> Éxito</span> }
                          @else { <span class="badge danger"><i class="ph ph-x-circle"></i> Error</span> }
                          <span class="run-meta"><i class="ph" [class.ph-alarm]="r.trigger === 'scheduled'" [class.ph-hand-pointing]="r.trigger === 'manual'"></i> {{ r.trigger === 'manual' ? 'Manual' : 'Programado' }}</span>
                          <span class="run-meta">{{ r.started_at | friendlyDate }}</span>
                          <span class="run-meta dim">{{ r.duration_ms }}ms</span>
                        </div>
                        <div class="run-label">
                          <span>Resultado</span>
                          <button class="btn-link" (click)="toggleVer(r)">{{ abierto(r) ? 'Plegar' : 'Ver todo' }}</button>
                        </div>
                        <pre class="run-pre" [class.open]="abierto(r)">{{ r.result || '—' }}</pre>
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
            <label class="field">
              <span>Mensaje o instrucción</span>
              <textarea rows="4" [(ngModel)]="form.message" placeholder="Ej: Recordarme llamar a Pablo · o · Revisa mi agenda del día y envíame un resumen de mis reuniones"></textarea>
            </label>

            <label class="check">
              <input type="checkbox" [(ngModel)]="form.autonomous" />
              <span><strong>Es una acción autónoma</strong> (el agente trabajará en esto con sus herramientas y te reporta el resultado)</span>
            </label>

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
    .task { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; padding: 20px 22px; margin-bottom: 16px; transition: border-color .15s; }
    .task:hover { border-color: var(--accent-primary); }
    .task.paused { opacity: .85; }
    .task.done { opacity: .7; }

    .task-badges { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
    .tb { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .tb.kind { background: rgba(45,212,191,.14); color: #5eead4; }
    .tb.agent { background: rgba(129,140,248,.16); color: #a5b4fc; }
    .tb.plain { background: var(--bg-input); color: var(--text-dim); border: 1px solid var(--border-light); }

    .task-main { display: flex; gap: 20px; align-items: flex-start; }
    .task-body { flex: 1; min-width: 0; }
    .task-title { margin: 0 0 10px; font-size: 17px; }
    .task-msg { padding: 12px 14px; border-radius: 10px; background: var(--bg-input); border: 1px solid var(--border-light); color: var(--text-dim); font-style: italic; font-size: 14px; line-height: 1.55; white-space: pre-wrap; }
    .task-edit { width: 100%; font-size: 14px; line-height: 1.55; }
    .task-when { margin-top: 12px; color: var(--text-dim); font-size: 13.5px; }
    .task-when strong { color: var(--text-main); font-weight: 500; }

    .task-actions { display: flex; gap: 4px; flex: 0 0 auto; padding-top: 2px; }
    .ta { width: 38px; height: 38px; border-radius: 9px; border: 0; background: transparent; cursor: pointer; font-size: 20px; display: grid; place-items: center; transition: background .12s; }
    .ta:hover { background: var(--bg-input); }
    .ta:disabled { opacity: .5; cursor: default; }
    .ta.run { color: var(--ok); }
    .ta.hist { color: var(--text-dim); }
    .ta.hist.on { background: var(--bg-input); color: var(--accent-primary); }
    .ta.pause { color: var(--warn); }
    .ta.edit { color: var(--accent-primary); }
    .ta.del { color: var(--danger); }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .task-history { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border-light); }
    .th-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; margin-bottom: 12px; }
    .th-title i { color: var(--accent-primary); }
    .runs { max-height: 520px; overflow: auto; padding-right: 6px; }
    .run { border: 1px solid var(--border-light); border-left: 3px solid var(--ok); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; background: var(--bg-input); }
    .run.err { border-left-color: var(--danger); }
    .run-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .run-head .badge i { font-size: 13px; }
    .run-meta { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: var(--text-dim); }
    .run-meta.dim { opacity: .7; font-size: 12px; }
    .run-label { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-dim); }
    .btn-link { background: none; border: 0; padding: 0; color: var(--accent-primary); cursor: pointer; font: inherit; font-size: 12px; text-transform: none; letter-spacing: 0; }
    .btn-link:hover { text-decoration: underline; }
    .run-pre { margin: 0; padding: 12px 14px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border-light); font-family: inherit; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: var(--text-main); max-height: 150px; overflow: hidden; position: relative; }
    .run-pre:not(.open)::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 40px; background: linear-gradient(transparent, var(--bg-card)); }
    .run-pre.open { max-height: none; overflow: auto; }

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
    .hint code { background: var(--bg-input); padding: 1px 5px; border-radius: 4px; }

    @media (max-width: 720px) {
      .task-main { flex-direction: column; }
      .task-actions { align-self: flex-end; }
    }
  `],
})
export class TasksComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  items = signal<ScheduledTask[]>([]);
  cargado = signal(false);
  editando = signal<string | null>(null);
  textoEdit = '';
  ejecutando = signal<string | null>(null);
  historial = signal<string | null>(null);
  runs = signal<TaskRun[] | null>(null);
  private abiertos = new Set<string>();

  modal = signal(false);
  guardando = signal(false);
  form: { message: string; autonomous: boolean; kind: TaskKind; run_at: string; interval_minutes: number | null; time_of_day: string; cron_expr: string } = this.formVacio();

  constructor() { this.load(); }

  load() {
    this.api.getTasks().subscribe({
      next: (r) => { this.items.set(r.tasks || []); this.cargado.set(true); },
      error: () => { this.cargado.set(true); this.toast.error('No se pudieron cargar las tareas'); },
    });
  }

  // ─── Presentación ────────────────────────────────────────────────────
  titulo(t: ScheduledTask): string {
    const m = t.message.trim().replace(/\s+/g, ' ');
    const corte = m.length > 60 ? m.slice(0, 60).replace(/\s\S*$/, '') + '…' : m;
    return (t.autonomous ? 'Rutina: ' : 'Recordatorio: ') + corte;
  }
  etiquetaTipo(k: TaskKind) { return { once: 'Una vez', interval: 'Recurrente', daily: 'Diario', cron: 'Cron' }[k]; }
  iconoTipo(k: TaskKind) { return { once: 'ph-calendar-blank', interval: 'ph-arrows-clockwise', daily: 'ph-sun', cron: 'ph-code' }[k]; }
  fecha(ms: number) { return new Date(ms).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' }); }

  // ─── Acciones ────────────────────────────────────────────────────────
  ejecutar(t: ScheduledTask) {
    this.ejecutando.set(t.id);
    this.api.runTask(t.id).subscribe({
      next: (r) => {
        this.ejecutando.set(null);
        r.run.status === 'success' ? this.toast.ok('Ejecutada. El resultado fue a Telegram.') : this.toast.error(`Falló: ${r.run.result?.slice(0, 120)}`);
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

  editar(t: ScheduledTask) { this.textoEdit = t.message; this.editando.set(t.id); }
  guardarEdicion(t: ScheduledTask) {
    this.api.updateTask(t.id, { message: this.textoEdit.trim() }).subscribe({
      next: () => { this.editando.set(null); this.load(); this.toast.ok('Instrucción actualizada'); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo guardar'),
    });
  }

  eliminar(t: ScheduledTask) {
    if (!confirm(`¿Eliminar esta tarea?\n\n"${t.message.slice(0, 120)}"`)) return;
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
  private formVacio() { return { message: '', autonomous: false, kind: 'once' as TaskKind, run_at: '', interval_minutes: null as number | null, time_of_day: '09:00', cron_expr: '' }; }
  abrirNueva() { this.form = this.formVacio(); this.modal.set(true); }
  cerrarModal() { if (!this.guardando()) this.modal.set(false); }

  formValido(): boolean {
    const f = this.form;
    if (!f.message.trim()) return false;
    switch (f.kind) {
      case 'once': return !!f.run_at && new Date(f.run_at).getTime() > Date.now();
      case 'interval': return !!f.interval_minutes && f.interval_minutes >= 1;
      case 'daily': return /^\d{2}:\d{2}$/.test(f.time_of_day);
      case 'cron': return f.cron_expr.trim().split(/\s+/).length === 5;
    }
  }

  crear() {
    const f = this.form;
    const datos: TaskInput = { message: f.message.trim(), autonomous: f.autonomous, kind: f.kind };
    if (f.kind === 'once') datos.run_at = new Date(f.run_at).toISOString();
    if (f.kind === 'interval') datos.interval_minutes = f.interval_minutes;
    if (f.kind === 'daily') datos.time_of_day = f.time_of_day;
    if (f.kind === 'cron') datos.cron_expr = f.cron_expr.trim();
    this.guardando.set(true);
    this.api.createTask(datos).subscribe({
      next: () => { this.guardando.set(false); this.modal.set(false); this.load(); this.toast.ok('Tarea programada'); },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo programar'); },
    });
  }
}
