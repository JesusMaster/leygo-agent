import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, TareaIntegrada, ScheduledTask, TaskRun, TaskInput, TaskChannel, TaskDelivery } from '../../services/api.service';
import { ModelPickerComponent } from '../model-picker/model-picker';
import { DeliveryPickerComponent } from './delivery-picker';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';
import { MarkdownPipe } from '../../pipes/markdown.pipe';

type Pestana = 'mias' | 'sistema' | 'finalizadas';
type Modo = 'recordatorio' | 'agente' | 'rutina';
type Preset = 'once' | 'daily' | 'weekly' | 'interval' | 'cron';

interface Form {
  id: string | null;            // null = nueva (o duplicada)
  modo: Modo;
  integrada: string;
  message: string;
  model: string;
  preset: Preset;
  run_at: string;               // datetime-local
  time: string;                 // HH:MM (diaria/semanal)
  dias: number[];               // 0=dom … 6=sáb (semanal)
  cada: number | null;
  unidad: 'min' | 'h';
  cron: string;
  delivery: TaskDelivery[];
}

const DIAS = [{ n: 1, l: 'L' }, { n: 2, l: 'M' }, { n: 3, l: 'X' }, { n: 4, l: 'J' }, { n: 5, l: 'V' }, { n: 6, l: 'S' }, { n: 0, l: 'D' }];
const EJEMPLOS = [
  'Revisa mi agenda de hoy y envíame un resumen con las reuniones y qué preparar para cada una.',
  'Revisa mis compromisos vencidos y dime a quién debería escribirle hoy y qué decirle.',
  'Resume los correos importantes que no he respondido desde ayer.',
  'Dame el consumo de tokens de la semana y los 3 modelos más caros.',
];

/**
 * Tareas programadas: lista compacta (estado, horario en palabras, próxima y última
 * ejecución) con detalle desplegable, y un solo formulario para crear, editar y duplicar.
 */
@Component({
  selector: 'app-tasks',
  imports: [FormsModule, FriendlyDatePipe, MarkdownPipe, DeliveryPickerComponent, ModelPickerComponent],
  host: { '(document:click)': 'menu.set(null)' },
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Tareas programadas</h2>
          <p class="sub">Recordatorios que te llegan tal cual y acciones que el agente trabaja con sus herramientas y te reporta. También puedes pedírselas por chat: "todos los días hábiles a las 8:45 revisa mi agenda".</p>
        </div>
        <button class="btn-primary" (click)="abrirNueva()"><i class="ph ph-plus"></i> Nueva tarea</button>
      </div>

      @if (agenda().length) {
        <div class="agenda">
          <span class="ag-lbl"><i class="ph ph-clock"></i> Próximas 24 h</span>
          @for (a of agenda(); track a.t.id) {
            <button class="ag-item" (click)="enfocar(a.t)" [title]="titulo(a.t)">
              <b>{{ cuandoCorto(a.at) }}</b>
              <span>{{ titulo(a.t) }}</span>
            </button>
          }
        </div>
      }

      <div class="barra-top">
        <div class="tabs">
          <button class="tab" [class.on]="pestana() === 'mias'" (click)="ir('mias')">Mis tareas <span class="cnt">{{ mias().length }}</span></button>
          <button class="tab" [class.on]="pestana() === 'sistema'" (click)="ir('sistema')">Rutinas del sistema <span class="cnt">{{ sistema().length }}</span></button>
          <button class="tab" [class.on]="pestana() === 'finalizadas'" (click)="ir('finalizadas')">Finalizadas <span class="cnt">{{ finalizadas().length }}</span></button>
        </div>
        <input type="text" class="buscar" [ngModel]="q()" (ngModelChange)="q.set($event)" placeholder="Buscar…" />
      </div>

      @if (!cargado()) {
        <div class="card"><div class="empty">Cargando tareas…</div></div>
      } @else if (visibles().length === 0) {
        <div class="card empty-state">
          @switch (pestana()) {
            @case ('mias') {
              <i class="ph ph-calendar-check"></i>
              <h3>{{ q() ? 'Nada coincide' : 'Todavía no hay tareas tuyas' }}</h3>
              <p>Programa un recordatorio de una vez, una rutina diaria o semanal, o una acción que el agente trabaje por ti.</p>
              <button class="btn-primary" (click)="abrirNueva()"><i class="ph ph-plus"></i> Nueva tarea</button>
            }
            @case ('sistema') {
              <i class="ph ph-puzzle-piece"></i>
              <h3>Sin rutinas del sistema</h3>
              <p>Morning Digest, aviso de compromisos, sync de Meet y consolidación se vuelven a programar desde "Nueva tarea".</p>
            }
            @default {
              <i class="ph ph-check-circle"></i>
              <h3>Nada finalizado</h3>
              <p>Aquí quedan las tareas de una sola vez que ya se ejecutaron.</p>
            }
          }
        </div>
      } @else {
        @if (pestana() === 'finalizadas') {
          <div class="row" style="margin-bottom:10px">
            <span class="spacer"></span>
            <button class="btn-secondary" (click)="limpiarFinalizadas()"><i class="ph ph-broom"></i> Eliminar todas ({{ finalizadas().length }})</button>
          </div>
        }
        <div class="lista card">
          @for (t of visibles(); track t.id) {
            <div class="t" [id]="'t-' + t.id" [class.paused]="t.status === 'paused'" [class.done]="t.status === 'done'" [class.open]="abierta() === t.id" [class.flash]="flash() === t.id">
              <div class="t-row" (click)="toggleDetalle(t)">
                @if (t.status !== 'done') {
                  <label class="sw" (click)="$event.stopPropagation()" [title]="t.status === 'active' ? 'Activa — clic para pausar' : 'Pausada — clic para reanudar'">
                    <input type="checkbox" [checked]="t.status === 'active'" (change)="alternar(t)" /><span></span>
                  </label>
                } @else { <span class="sw-ph"><i class="ph ph-check-circle"></i></span> }

                <span class="t-ico" [attr.data-modo]="modoDe(t)"><i class="ph" [class]="'ph ' + iconoModo(modoDe(t))"></i></span>

                <div class="t-main">
                  <div class="t-tit">{{ titulo(t) }}</div>
                  <div class="t-sub">
                    <span><i class="ph ph-clock"></i> {{ t.horario || t.descripcion }}</span>
                    <span class="canales">@for (d of t.delivery; track d.channel + (d.target || '')) { <i class="ph" [class]="'ph ' + iconoCanal(d.channel)" [title]="etiquetaCanal(d.channel) + (d.target ? ' · ' + d.target : '')"></i> }</span>
                    @if (t.autonomous === 1 && t.model) { <span class="chip-m" [title]="t.model">{{ modeloCorto(t.model) }}</span> }
                  </div>
                </div>

                <div class="t-next">
                  @if (t.status === 'active' && t.next_run_at) { <small>Próxima</small><b [title]="fecha(t.next_run_at)">{{ relativo(t.next_run_at) }}</b> }
                  @else if (t.status === 'paused') { <span class="badge warn">Pausada</span> }
                  @else if (t.status === 'done') { <small>Ejecutada</small><b>{{ t.last_run_at ? (t.last_run_at | friendlyDate) : '—' }}</b> }
                </div>

                <div class="t-last">
                  @if (t.ultima; as u) {
                    <span class="ult" [class.err]="u.status === 'error'" [title]="(u.status === 'success' ? 'Última ejecución OK' : 'Última ejecución con error') + ' · ' + (u.trigger === 'manual' ? 'manual' : 'programada') + ' · ' + duracion(u.duration_ms)">
                      <i class="ph" [class.ph-check-circle]="u.status === 'success'" [class.ph-warning-circle]="u.status === 'error'"></i> {{ u.started_at | friendlyDate }}
                    </span>
                  } @else { <span class="ult nunca">sin ejecutar</span> }
                </div>

                <div class="t-acts" (click)="$event.stopPropagation()">
                  <button class="ta run" title="Ejecutar ahora" [disabled]="ejecutando() === t.id" (click)="ejecutar(t)">
                    @if (ejecutando() === t.id) { <span class="spinner"></span> } @else { <i class="ph ph-play"></i> }
                  </button>
                  <div class="menu-wrap">
                    <button class="ta" [class.on]="menu() === t.id" title="Más acciones" (click)="toggleMenu(t.id, $event)"><i class="ph ph-dots-three"></i></button>
                    @if (menu() === t.id) {
                      <div class="menu" (click)="$event.stopPropagation()">
                        <button (click)="menuAccion(() => abrirEdicion(t))"><i class="ph ph-pencil-simple"></i> Editar</button>
                        @if (t.autonomous !== 2) { <button (click)="menuAccion(() => duplicar(t))"><i class="ph ph-copy"></i> Duplicar</button> }
                        <button (click)="menuAccion(() => toggleDetalle(t))"><i class="ph ph-clock-counter-clockwise"></i> Historial</button>
                        <button class="danger" (click)="menuAccion(() => eliminar(t))"><i class="ph ph-trash"></i> Eliminar</button>
                      </div>
                    }
                  </div>
                </div>
              </div>

              @if (abierta() === t.id) {
                <div class="t-det">
                  <div class="t-msg">
                    <div class="lbl">{{ t.autonomous === 2 ? 'Qué hace' : t.autonomous ? 'Instrucción para el agente' : 'Mensaje' }}</div>
                    <div class="msg">{{ t.integrada ? t.integrada.descripcion : t.message }}</div>
                    <div class="meta">
                      {{ t.descripcion }}
                      @if (t.next_run_at && t.status === 'active') { · próxima {{ fecha(t.next_run_at) }} }
                    </div>
                    <div class="row" style="margin-top:10px">
                      <button class="btn-secondary sm" (click)="abrirEdicion(t)"><i class="ph ph-pencil-simple"></i> Editar</button>
                    </div>
                  </div>
                  <div class="t-hist">
                    <div class="lbl">Historial</div>
                    @if (!runs()) { <div class="empty">Cargando…</div> }
                    @else if (runs()!.length === 0) { <div class="empty">Todavía no se ha ejecutado.</div> }
                    @else {
                      @for (r of runs(); track r.id + '-' + r.started_at) {
                        <div class="run" [class.err]="r.status === 'error'" [class.open]="abierto(r)">
                          <button class="run-head" (click)="toggleVer(r)">
                            <i class="ph" [class.ph-check-circle]="r.status === 'success'" [class.ph-warning-circle]="r.status === 'error'"></i>
                            <span>{{ r.started_at | friendlyDate }}</span>
                            <small>{{ r.trigger === 'manual' ? 'manual' : 'programada' }} · {{ duracion(r.duration_ms) }}</small>
                            <span class="spacer"></span>
                            <span class="prev">{{ abierto(r) ? '' : preview(r.result) }}</span>
                            <i class="ph" [class.ph-caret-down]="!abierto(r)" [class.ph-caret-up]="abierto(r)"></i>
                          </button>
                          @if (abierto(r)) { <div class="run-body md" [innerHTML]="(r.result || '—') | markdown"></div> }
                        </div>
                      }
                    }
                  </div>
                </div>
              }
            </div>
          }
        </div>
      }
    </div>

    <!-- ─── Modal: crear / editar / duplicar ─────────────────────────────── -->
    @if (modal()) {
      <div class="modal-backdrop" (click)="cerrarModal()">
        <div class="modal ancho" (click)="$event.stopPropagation()">
          <div class="modal-head">
            <h3>{{ form.id ? 'Editar tarea' : 'Nueva tarea' }}</h3>
            <button class="btn-icon" (click)="cerrarModal()"><i class="ph ph-x"></i></button>
          </div>
          <div class="modal-body">
            <div class="sec">1 · Qué hace</div>
            <div class="modos">
              <button type="button" class="modo" [class.on]="form.modo === 'recordatorio'" [disabled]="bloqueaModo()" (click)="setModo('recordatorio')">
                <i class="ph ph-bell"></i><b>Recordatorio</b><small>Te llega el texto tal cual, a la hora que digas.</small>
              </button>
              <button type="button" class="modo" [class.on]="form.modo === 'agente'" [disabled]="bloqueaModo()" (click)="setModo('agente')">
                <i class="ph ph-robot"></i><b>Acción del agente</b><small>Yisus la trabaja con sus herramientas y te reporta.</small>
              </button>
              @if (integradasDisponibles().length || form.modo === 'rutina') {
                <button type="button" class="modo" [class.on]="form.modo === 'rutina'" [disabled]="bloqueaModo()" (click)="setModo('rutina')">
                  <i class="ph ph-puzzle-piece"></i><b>Rutina del sistema</b><small>Digest, compromisos, sync de Meet…</small>
                </button>
              }
            </div>

            @if (form.modo === 'rutina') {
              <label class="field">
                <span>Rutina</span>
                <select [(ngModel)]="form.integrada" [disabled]="!!form.id">
                  @for (i of rutinasParaForm(); track i.key) { <option [value]="i.key">{{ i.titulo }}</option> }
                </select>
              </label>
              <p class="hint" style="margin-top:-6px">{{ descripcionIntegrada(form.integrada) }}</p>
            } @else {
              <label class="field">
                <span>{{ form.modo === 'agente' ? 'Instrucción para el agente' : 'Mensaje que te va a llegar' }}</span>
                <textarea rows="3" [(ngModel)]="form.message" [placeholder]="form.modo === 'agente' ? 'Qué debe hacer y qué quieres recibir' : 'Ej: Llamar a Pablo por la renovación'"></textarea>
              </label>
              @if (form.modo === 'agente' && !form.message.trim()) {
                <div class="ejemplos">
                  @for (e of ejemplos; track e) { <button type="button" class="ej" (click)="form.message = e">{{ e }}</button> }
                </div>
              }
            }

            <div class="sec">2 · Cuándo</div>
            <div class="seg presets">
              @for (p of presets; track p.id) { <button type="button" [class.on]="form.preset === p.id" (click)="setPreset(p.id)">{{ p.l }}</button> }
            </div>
            <div class="cuando">
              @switch (form.preset) {
                @case ('once') {
                  <input type="datetime-local" [(ngModel)]="form.run_at" (ngModelChange)="previewLuego()" />
                  <div class="rapidos">
                    @for (r of rapidos; track r.l) { <button type="button" class="ej sm" (click)="rapido(r.f)">{{ r.l }}</button> }
                  </div>
                }
                @case ('daily') {
                  <label class="inline">Todos los días a las <input type="time" [(ngModel)]="form.time" (ngModelChange)="previewLuego()" /></label>
                }
                @case ('weekly') {
                  <div class="dias">
                    @for (d of dias; track d.n) { <button type="button" [class.on]="form.dias.includes(d.n)" (click)="toggleDia(d.n)">{{ d.l }}</button> }
                    <button type="button" class="ej sm" (click)="setDias([1, 2, 3, 4, 5])">Días hábiles</button>
                  </div>
                  <label class="inline">a las <input type="time" [(ngModel)]="form.time" (ngModelChange)="previewLuego()" /></label>
                }
                @case ('interval') {
                  <label class="inline">Cada <input type="number" min="1" class="num" [(ngModel)]="form.cada" (ngModelChange)="previewLuego()" />
                    <select [(ngModel)]="form.unidad" (ngModelChange)="previewLuego()"><option value="min">minutos</option><option value="h">horas</option></select>
                  </label>
                  <small class="hint">Para "cada hora pero solo en horario laboral", usa Avanzado: <code>0 9-18 * * 1-5</code>.</small>
                }
                @case ('cron') {
                  <input type="text" class="mono" [(ngModel)]="form.cron" (ngModelChange)="previewLuego()" placeholder="0 9 * * 1-5" />
                  <small class="hint">minuto · hora · día del mes · mes · día de la semana (0 = domingo).</small>
                }
              }
              <div class="preview" [class.err]="!!prev()?.error">
                @if (prev(); as p) {
                  @if (p.error) { <i class="ph ph-warning"></i> {{ p.error }} }
                  @else {
                    <i class="ph ph-calendar-check"></i>
                    <div><b>{{ p.descripcion }}</b><br /><small>Próximas: {{ p.proximas.length ? proximasTxt(p.proximas) : '—' }}</small></div>
                  }
                } @else { <small class="dim">Elige el horario para ver las próximas ejecuciones.</small> }
              </div>
            </div>

            <div class="sec">3 · Dónde te llega</div>
            <app-delivery-picker [value]="form.delivery" (valueChange)="form.delivery = $event" />

            @if (form.modo === 'agente') {
              <details class="avz" [open]="!!form.model">
                <summary>Opciones avanzadas</summary>
                <div class="field"><span>Modelo que procesa la tarea</span></div>
                <app-model-picker [value]="form.model" (valueChange)="form.model = $event" />
                <small class="hint">Vacío = el del Coordinator (Ajustes → Modelos por agente). Usa uno más barato para tareas simples.</small>
              </details>
            }
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="cerrarModal()">Cancelar</button>
            @if (form.modo !== 'recordatorio') { <button class="btn-secondary" [disabled]="!formValido() || guardando()" (click)="guardar(true)" title="Guarda y la ejecuta una vez para ver el resultado"><i class="ph ph-play"></i> Guardar y probar</button> }
            <button class="btn-primary" [disabled]="!formValido() || guardando()" (click)="guardar(false)">{{ form.id ? 'Guardar cambios' : 'Programar' }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .agenda { display: flex; gap: 8px; align-items: center; overflow-x: auto; padding-bottom: 4px; margin-bottom: 14px; }
    .ag-lbl { font-size: 12px; color: var(--text-dim); display: inline-flex; gap: 5px; align-items: center; white-space: nowrap; }
    .ag-item { display: inline-flex; gap: 8px; align-items: baseline; border: 1px solid var(--border-light); background: var(--bg-card); color: var(--text-main); border-radius: 999px; padding: 6px 12px; cursor: pointer; font-size: 12.5px; white-space: nowrap; max-width: 320px; }
    .ag-item b { color: var(--accent-primary); font-weight: 600; }
    .ag-item span { overflow: hidden; text-overflow: ellipsis; }
    .ag-item:hover { border-color: var(--accent-primary); }
    .barra-top { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--border-light); }
    .tabs { display: flex; gap: 4px; overflow-x: auto; flex: 1; }
    .tab { display: inline-flex; align-items: center; gap: 8px; padding: 10px 12px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--text-dim); font-size: 14px; cursor: pointer; white-space: nowrap; margin-bottom: -1px; }
    .tab:hover { color: var(--text-main); }
    .tab.on { color: var(--accent-primary); border-bottom-color: var(--accent-primary); }
    .tab .cnt { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--bg-main); color: var(--text-dim); }
    .tab.on .cnt { background: rgba(129,140,248,.18); color: var(--accent-primary); }
    .buscar { width: 200px; margin-bottom: 6px; padding: 7px 10px; font-size: 13px; }

    .lista { padding: 0; overflow: visible; }
    .t { border-bottom: 1px solid var(--border-light); transition: background .3s; }
    .t:last-child { border-bottom: 0; }
    .t.open { background: rgba(129,140,248,.04); }
    .t.flash { background: rgba(129,140,248,.14); }
    .t.paused .t-tit, .t.paused .t-ico { opacity: .55; }
    .t.done { opacity: .75; }
    .t-row { display: grid; grid-template-columns: 40px 34px minmax(0, 1fr) 118px 130px auto; align-items: center; gap: 12px; padding: 12px 16px; cursor: pointer; }
    .t-row:hover { background: rgba(129,140,248,.05); }
    .sw { position: relative; width: 36px; height: 20px; display: inline-block; }
    .sw input { opacity: 0; width: 0; height: 0; }
    .sw span { position: absolute; inset: 0; border-radius: 999px; background: var(--border-light); transition: background .15s; cursor: pointer; }
    .sw span::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .sw input:checked + span { background: var(--ok); }
    .sw input:checked + span::after { transform: translateX(16px); }
    .sw-ph { color: var(--ok); font-size: 20px; text-align: center; }
    .t-ico { width: 34px; height: 34px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 17px; background: var(--bg-main); color: var(--text-dim); }
    .t-ico[data-modo=agente] { background: rgba(129,140,248,.16); color: #a5b4fc; }
    .t-ico[data-modo=rutina] { background: rgba(168,85,247,.14); color: #c084fc; }
    .t-ico[data-modo=recordatorio] { background: rgba(245,158,11,.14); color: var(--warn); }
    .t-tit { font-weight: 600; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .t-sub { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 12.5px; color: var(--text-dim); margin-top: 3px; }
    .t-sub > span { display: inline-flex; gap: 5px; align-items: center; }
    .canales i { color: var(--accent-primary); font-size: 14px; }
    .chip-m { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: rgba(56,189,248,.14); color: #7dd3fc; }
    .t-next { display: flex; flex-direction: column; font-size: 13px; }
    .t-next small, .lbl { font-size: 11px; color: var(--text-dim); }
    .t-last { font-size: 12.5px; }
    .ult { display: inline-flex; gap: 5px; align-items: center; color: var(--ok); }
    .ult.err { color: var(--danger); }
    .ult.nunca { color: var(--text-dim); }
    .t-acts { display: flex; gap: 4px; align-items: center; }
    .ta { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border-light); background: var(--bg-main); color: var(--text-dim); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; }
    .ta:hover, .ta.on { border-color: var(--accent-primary); color: var(--accent-primary); }
    .ta.run { color: var(--ok); } .ta.run:hover { border-color: var(--ok); }
    .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(16,185,129,.25); border-top-color: var(--ok); animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .menu-wrap { position: relative; }
    .menu { position: absolute; right: 0; top: 36px; z-index: 30; min-width: 170px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 10px; box-shadow: 0 12px 30px rgba(0,0,0,.35); padding: 6px; display: flex; flex-direction: column; }
    .menu button { display: flex; gap: 9px; align-items: center; border: none; background: none; color: var(--text-main); padding: 8px 10px; border-radius: 7px; cursor: pointer; font-size: 13px; text-align: left; }
    .menu button:hover { background: var(--bg-main); }
    .menu button.danger { color: var(--danger); }

    .t-det { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 18px; padding: 4px 16px 16px 102px; }
    .t-msg .msg { margin-top: 4px; padding: 10px 12px; border-radius: 10px; background: var(--bg-main); font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; }
    .t-msg .meta { font-size: 12px; color: var(--text-dim); margin-top: 8px; }
    .btn-secondary.sm { padding: 6px 11px; font-size: 12.5px; }
    .t-hist .lbl { margin-bottom: 4px; }
    .run { border: 1px solid var(--border-light); border-left: 3px solid var(--ok); border-radius: 8px; margin-bottom: 6px; background: var(--bg-main); }
    .run.err { border-left-color: var(--danger); }
    .run-head { width: 100%; display: flex; gap: 8px; align-items: center; background: none; border: none; color: var(--text-main); padding: 7px 10px; cursor: pointer; font-size: 12.5px; text-align: left; }
    .run-head small { color: var(--text-dim); white-space: nowrap; }
    .run-head .ph-check-circle { color: var(--ok); } .run-head .ph-warning-circle { color: var(--danger); }
    .prev { color: var(--text-dim); font-size: 12px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-body { padding: 4px 12px 10px; font-size: 13px; max-height: 360px; overflow: auto; }

    .empty-state { text-align: center; padding: 44px 24px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .empty-state > i { font-size: 38px; color: var(--accent-primary); }
    .empty-state p { color: var(--text-dim); max-width: 56ch; margin: 0 0 8px; }

    .modal.ancho { max-width: 680px; }
    .sec { font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--text-dim); margin: 6px 0 8px; }
    .sec:not(:first-child) { margin-top: 18px; }
    .modos { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; margin-bottom: 12px; }
    .modo { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border-light); background: var(--bg-main); color: var(--text-main); cursor: pointer; }
    .modo i { font-size: 18px; color: var(--text-dim); }
    .modo small { font-size: 12px; color: var(--text-dim); }
    .modo.on { border-color: var(--accent-primary); box-shadow: inset 0 0 0 1px var(--accent-primary); }
    .modo.on i { color: var(--accent-primary); }
    .modo:disabled:not(.on) { opacity: .45; cursor: default; }
    .ejemplos { display: flex; flex-wrap: wrap; gap: 6px; margin: -4px 0 6px; }
    .ej { border: 1px dashed var(--border-light); background: none; color: var(--text-dim); border-radius: 8px; padding: 6px 9px; font-size: 12px; cursor: pointer; text-align: left; }
    .ej:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
    .ej.sm { padding: 4px 8px; }
    .seg { display: inline-flex; border: 1px solid var(--border-light); border-radius: 8px; overflow: hidden; flex-wrap: wrap; }
    .seg button { padding: 7px 12px; border: none; background: var(--bg-card); color: var(--text-dim); cursor: pointer; font-size: 13px; }
    .seg button.on { background: var(--accent-primary); color: #fff; }
    .cuando { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
    .cuando input[type=datetime-local], .cuando input.mono { max-width: 300px; }
    .inline { display: inline-flex; gap: 8px; align-items: center; font-size: 13.5px; }
    .inline input[type=time] { width: auto; }
    .inline .num { width: 80px; }
    .inline select { width: auto; }
    .rapidos, .dias { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .dias > button:not(.ej) { width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--border-light); background: var(--bg-main); color: var(--text-dim); cursor: pointer; font-weight: 600; }
    .dias > button.on { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }
    .preview { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 10px; background: rgba(129,140,248,.08); border: 1px solid rgba(129,140,248,.3); font-size: 13px; }
    .preview i { color: var(--accent-primary); font-size: 18px; margin-top: 1px; }
    .preview small { color: var(--text-dim); }
    .preview.err { background: rgba(239,68,68,.08); border-color: rgba(239,68,68,.35); color: var(--danger); }
    .preview.err i { color: var(--danger); }
    .avz { margin-top: 16px; }
    .avz summary { cursor: pointer; font-size: 13px; color: var(--text-dim); margin-bottom: 8px; }
    .hint { display: block; color: var(--text-dim); font-size: 12px; }
    .hint code { background: var(--bg-input); padding: 1px 5px; border-radius: 4px; }
    .dim { color: var(--text-dim); }

    @media (max-width: 860px) {
      .t-row { grid-template-columns: 40px minmax(0, 1fr) auto; grid-template-areas: 'sw main acts' 'sw next last'; row-gap: 4px; padding: 12px; }
      .sw, .sw-ph { grid-area: sw; } .t-ico { display: none; } .t-main { grid-area: main; } .t-acts { grid-area: acts; }
      .t-next { grid-area: next; flex-direction: row; gap: 6px; align-items: baseline; } .t-last { grid-area: last; text-align: right; }
      .t-det { grid-template-columns: 1fr; padding: 4px 12px 14px; }
      .t-tit { white-space: normal; }
      .barra-top { flex-wrap: wrap; } .buscar { width: 100%; }
      .prev { display: none; }
    }
  `],
})
export class TasksComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  readonly dias = DIAS;
  readonly ejemplos = EJEMPLOS;
  readonly presets: Array<{ id: Preset; l: string }> = [
    { id: 'once', l: 'Una vez' }, { id: 'daily', l: 'Diaria' }, { id: 'weekly', l: 'Semanal' }, { id: 'interval', l: 'Cada…' }, { id: 'cron', l: 'Avanzado' },
  ];
  readonly rapidos: Array<{ l: string; f: () => Date }> = [
    { l: 'En 1 hora', f: () => new Date(Date.now() + 3600_000) },
    { l: 'Hoy 18:00', f: () => { const d = new Date(); d.setHours(18, 0, 0, 0); return d; } },
    { l: 'Mañana 09:00', f: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
    { l: 'Lunes 09:00', f: () => { const d = new Date(); d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); d.setHours(9, 0, 0, 0); return d; } },
  ];

  items = signal<ScheduledTask[]>([]);
  integradas = signal<TareaIntegrada[]>([]);
  cargado = signal(false);
  pestana = signal<Pestana>(((): Pestana => { try { return (localStorage.getItem('yisus_tasks_tab') as Pestana) || 'mias'; } catch { return 'mias'; } })());
  q = signal('');
  abierta = signal<string | null>(null);
  menu = signal<string | null>(null);
  flash = signal<string | null>(null);
  ejecutando = signal<string | null>(null);
  runs = signal<TaskRun[] | null>(null);
  private abiertos = new Set<string>();

  modal = signal(false);
  guardando = signal(false);
  form: Form = this.formVacio();
  prev = signal<{ descripcion: string; proximas: number[]; error?: string } | null>(null);
  private tPrev: any = null;

  private coincide = (t: ScheduledTask) => { const f = this.q().trim().toLowerCase(); return !f || [this.titulo(t), t.message, t.descripcion].some((x) => (x || '').toLowerCase().includes(f)); };
  mias = computed(() => this.items().filter((t) => t.autonomous !== 2 && t.status !== 'done'));
  sistema = computed(() => this.items().filter((t) => t.autonomous === 2 && t.status !== 'done'));
  finalizadas = computed(() => this.items().filter((t) => t.status === 'done'));
  visibles = computed(() => {
    const p = this.pestana();
    const base = p === 'mias' ? this.mias() : p === 'sistema' ? this.sistema() : this.finalizadas();
    const lista = base.filter(this.coincide);
    // Activas primero por próxima ejecución; pausadas al final; finalizadas por fecha desc.
    return [...lista].sort((a, b) => p === 'finalizadas'
      ? (b.last_run_at || 0) - (a.last_run_at || 0)
      : (a.status === b.status ? (a.next_run_at || Infinity) - (b.next_run_at || Infinity) : a.status === 'active' ? -1 : 1));
  });
  /** Próximas ejecuciones de todas las tareas activas (24 h). */
  agenda = computed(() => {
    const limite = Date.now() + 24 * 3600_000;
    return this.items().filter((t) => t.status === 'active' && t.next_run_at && t.next_run_at <= limite)
      .map((t) => ({ t, at: t.next_run_at! })).sort((a, b) => a.at - b.at).slice(0, 8);
  });
  integradasDisponibles = computed(() => this.integradas().filter((i) => !this.items().some((t) => t.autonomous === 2 && t.message === i.key)));

  constructor() { this.load(); }

  load() {
    this.api.getTasks().subscribe({
      next: (r) => { this.items.set(r.tasks || []); this.integradas.set(r.integradas || []); this.cargado.set(true); },
      error: () => { this.cargado.set(true); this.toast.error('No se pudieron cargar las tareas'); },
    });
  }
  ir(p: Pestana) { this.pestana.set(p); this.abierta.set(null); try { localStorage.setItem('yisus_tasks_tab', p); } catch {} }

  // ─── Presentación ────────────────────────────────────────────────────
  modoDe(t: ScheduledTask): Modo { return t.autonomous === 2 ? 'rutina' : t.autonomous ? 'agente' : 'recordatorio'; }
  iconoModo(m: Modo) { return m === 'rutina' ? 'ph-puzzle-piece' : m === 'agente' ? 'ph-robot' : 'ph-bell'; }
  titulo(t: ScheduledTask): string {
    if (t.integrada) return t.integrada.titulo;
    if (t.autonomous === 2) return `Rutina: ${t.message} (no registrada)`;
    const m = t.message.trim().replace(/\s+/g, ' ');
    return m.length > 90 ? m.slice(0, 90).replace(/\s\S*$/, '') + '…' : m;
  }
  modeloCorto(m: string) { const i = m.indexOf('/'); return i > 0 ? m.slice(i + 1) : m; }
  descripcionIntegrada(key: string) { return this.integradas().find((i) => i.key === key)?.descripcion || ''; }
  etiquetaCanal(c: TaskChannel) { return ({ telegram: 'Telegram', chat: 'Google Chat', buzz: 'Buzz', email: 'Email', a2a: 'Agente A2A' } as Record<string, string>)[c || 'telegram']; }
  iconoCanal(c: TaskChannel) { return ({ telegram: 'ph-telegram-logo', chat: 'ph-chats-circle', buzz: 'ph-broadcast', email: 'ph-envelope-simple', a2a: 'ph-robot' } as Record<string, string>)[c || 'telegram']; }
  fecha(ms: number) { return new Date(ms).toLocaleString('es-CL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  duracion(ms: number) { return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${Math.round(ms / 60_000)} min`; }
  preview(r: string) { return (r || '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').slice(0, 80); }
  /** "en 25 min", "hoy 18:00", "mañana 09:00", "lun 09:00", "12 oct 09:00". */
  relativo(ms: number) {
    const diff = ms - Date.now();
    if (diff < 0) return 'ahora';
    if (diff < 60 * 60_000) return `en ${Math.max(1, Math.round(diff / 60_000))} min`;
    return this.cuandoCorto(ms);
  }
  cuandoCorto(ms: number) {
    const d = new Date(ms), hoy = new Date();
    const hora = d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
    const dias = Math.round((new Date(d.toDateString()).getTime() - new Date(hoy.toDateString()).getTime()) / 86400000);
    if (dias === 0) return `hoy ${hora}`;
    if (dias === 1) return `mañana ${hora}`;
    if (dias < 7) return `${d.toLocaleDateString('es-CL', { weekday: 'short' })} ${hora}`;
    return `${d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })} ${hora}`;
  }
  proximasTxt(p: number[]) { return p.map((x) => this.cuandoCorto(x)).join(' · '); }

  // ─── Lista ───────────────────────────────────────────────────────────
  toggleMenu(id: string, ev: Event) { ev.stopPropagation(); this.menu.set(this.menu() === id ? null : id); }
  menuAccion(f: () => void) { this.menu.set(null); f(); }
  toggleDetalle(t: ScheduledTask) {
    if (this.abierta() === t.id) { this.abierta.set(null); return; }
    this.abierta.set(t.id); this.runs.set(null); this.cargarRuns(t.id);
  }
  enfocar(t: ScheduledTask) {
    this.ir(t.autonomous === 2 ? 'sistema' : 'mias');
    this.q.set('');
    setTimeout(() => {
      document.getElementById('t-' + t.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.flash.set(t.id); setTimeout(() => this.flash.set(null), 1200);
    }, 50);
  }
  private cargarRuns(id: string) {
    this.api.getTaskRuns(id, 20).subscribe({ next: (r) => this.runs.set(r.runs || []), error: () => this.runs.set([]) });
  }
  toggleVer(r: TaskRun) { const k = `${r.id}-${r.started_at}`; this.abiertos.has(k) ? this.abiertos.delete(k) : this.abiertos.add(k); this.runs.update((x) => (x ? [...x] : x)); }
  abierto(r: TaskRun) { return this.abiertos.has(`${r.id}-${r.started_at}`); }

  ejecutar(t: ScheduledTask) {
    this.ejecutando.set(t.id);
    this.api.runTask(t.id).subscribe({
      next: (r) => {
        this.ejecutando.set(null);
        r.run.status === 'success' ? this.toast.ok('Ejecutada. Resultado enviado por ' + t.delivery.map((d) => this.etiquetaCanal(d.channel)).join(' + ') + '.') : this.toast.error(`Falló: ${r.run.result?.slice(0, 120)}`);
        this.load();
        if (this.abierta() === t.id) this.cargarRuns(t.id);
      },
      error: (e) => { this.ejecutando.set(null); this.toast.error(e?.error?.error || 'No se pudo ejecutar'); },
    });
  }
  alternar(t: ScheduledTask) {
    const status = t.status === 'paused' ? 'active' : 'paused';
    this.api.updateTask(t.id, { status }).subscribe({
      next: () => { this.load(); this.toast.ok(status === 'paused' ? 'Tarea pausada' : 'Tarea reanudada'); },
      error: (e) => { this.toast.error(e?.error?.error || 'No se pudo cambiar el estado'); this.load(); },
    });
  }
  eliminar(t: ScheduledTask) {
    if (!confirm(t.autonomous === 2 ? `¿Eliminar la rutina "${t.integrada?.titulo || t.message}"? Podrás volver a programarla desde "Nueva tarea".` : `¿Eliminar esta tarea?\n\n"${t.message.slice(0, 120)}"`)) return;
    this.api.deleteTask(t.id).subscribe({
      next: () => { if (this.abierta() === t.id) this.abierta.set(null); this.load(); this.toast.ok('Tarea eliminada'); },
      error: () => this.toast.error('No se pudo eliminar'),
    });
  }
  limpiarFinalizadas() {
    const lista = this.finalizadas();
    if (!lista.length || !confirm(`¿Eliminar ${lista.length} tarea(s) finalizada(s) y su historial?`)) return;
    let pend = lista.length;
    for (const t of lista) this.api.deleteTask(t.id).subscribe({ next: () => { if (--pend === 0) { this.toast.ok('Finalizadas eliminadas'); this.load(); } }, error: () => { if (--pend === 0) this.load(); } });
  }

  // ─── Formulario ──────────────────────────────────────────────────────
  private formVacio(): Form {
    return { id: null, modo: 'recordatorio', integrada: '', message: '', model: '', preset: 'once', run_at: '', time: '09:00', dias: [1, 2, 3, 4, 5], cada: 60, unidad: 'min', cron: '', delivery: [{ channel: 'telegram' }] };
  }
  private aLocal(d: Date) { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }

  abrirNueva() {
    this.form = this.formVacio();
    if (this.pestana() === 'sistema' && this.integradasDisponibles().length) { this.form.modo = 'rutina'; this.form.integrada = this.integradasDisponibles()[0].key; this.form.preset = 'daily'; }
    this.prev.set(null); this.modal.set(true);
    if (this.form.preset !== 'once') this.previewLuego();
  }
  abrirEdicion(t: ScheduledTask) { this.form = this.desdeTarea(t, t.id); this.prev.set(null); this.modal.set(true); this.previewLuego(); }
  duplicar(t: ScheduledTask) {
    this.form = this.desdeTarea(t, null);
    if (this.form.preset === 'once') this.form.run_at = '';
    this.prev.set(null); this.modal.set(true); this.previewLuego();
  }
  private desdeTarea(t: ScheduledTask, id: string | null): Form {
    const f = this.formVacio();
    f.id = id;
    f.modo = this.modoDe(t);
    f.integrada = t.autonomous === 2 ? t.message : '';
    f.message = t.autonomous === 2 ? '' : t.message;
    f.model = t.model || '';
    f.delivery = (t.delivery || []).map((d) => ({ ...d }));
    switch (t.kind) {
      case 'once': f.preset = 'once'; f.run_at = t.run_at ? this.aLocal(new Date(t.run_at)) : ''; break;
      case 'daily': f.preset = 'daily'; f.time = t.time_of_day || '09:00'; break;
      case 'interval': { const m = t.interval_minutes || 60; f.preset = 'interval'; if (m % 60 === 0) { f.cada = m / 60; f.unidad = 'h'; } else { f.cada = m; f.unidad = 'min'; } break; }
      case 'cron': {
        const m = (t.cron_expr || '').trim().match(/^(\d{1,2}) (\d{1,2}) \* \* ([\d,\-]+)$/);
        if (m) {
          f.preset = 'weekly'; f.time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
          const set = new Set<number>();
          for (const p of m[3].split(',')) { const [a, b] = p.split('-').map(Number); for (let v = a; v <= (b ?? a); v++) set.add(v === 7 ? 0 : v); }
          f.dias = [...set];
        } else { f.preset = 'cron'; f.cron = t.cron_expr || ''; }
      }
    }
    return f;
  }
  cerrarModal() { if (!this.guardando()) this.modal.set(false); }
  bloqueaModo() { return !!this.form.id; }
  rutinasParaForm() {
    const actual = this.form.integrada ? this.integradas().filter((i) => i.key === this.form.integrada) : [];
    return [...actual, ...this.integradasDisponibles().filter((i) => i.key !== this.form.integrada)];
  }
  setModo(m: Modo) {
    this.form.modo = m;
    if (m === 'rutina' && !this.form.integrada) this.form.integrada = this.integradasDisponibles()[0]?.key || '';
  }
  setPreset(p: Preset) {
    const cronPrevio = this.cronDeForm();
    this.form.preset = p;
    if (p === 'cron' && !this.form.cron) this.form.cron = cronPrevio || '0 9 * * 1-5';
    this.previewLuego();
  }
  setDias(d: number[]) { this.form.dias = [...d]; this.previewLuego(); }
  toggleDia(n: number) {
    const s = new Set(this.form.dias);
    s.has(n) ? s.delete(n) : s.add(n);
    this.form.dias = [...s];
    this.previewLuego();
  }
  rapido(f: () => Date) { this.form.run_at = this.aLocal(f()); this.previewLuego(); }

  /** Semanal → cron "m h * * d,d". */
  private cronDeForm(): string | null {
    if (this.form.preset !== 'weekly') return null;
    const [h, m] = (this.form.time || '09:00').split(':').map(Number);
    const d = [...this.form.dias].sort((a, b) => a - b);
    return `${m} ${h} * * ${d.join(',')}`;
  }
  private horario(): Partial<TaskInput> | null {
    const f = this.form;
    switch (f.preset) {
      case 'once': return f.run_at ? { kind: 'once', run_at: new Date(f.run_at).toISOString() } : null;
      case 'daily': return /^\d{2}:\d{2}$/.test(f.time) ? { kind: 'daily', time_of_day: f.time } : null;
      case 'weekly':
        if (!f.dias.length || !/^\d{2}:\d{2}$/.test(f.time)) return null;
        return f.dias.length === 7 ? { kind: 'daily', time_of_day: f.time } : { kind: 'cron', cron_expr: this.cronDeForm()! };
      case 'interval': return f.cada && f.cada >= 1 ? { kind: 'interval', interval_minutes: Math.round(f.cada * (f.unidad === 'h' ? 60 : 1)) } : null;
      case 'cron': return f.cron.trim().split(/\s+/).length === 5 ? { kind: 'cron', cron_expr: f.cron.trim() } : null;
    }
  }
  previewLuego() {
    clearTimeout(this.tPrev);
    this.tPrev = setTimeout(() => {
      const h = this.horario();
      if (!h) { this.prev.set(null); return; }
      this.api.previewTask(h).subscribe({
        next: (p) => this.prev.set(p),
        error: (e) => this.prev.set({ descripcion: '', proximas: [], error: e?.error?.error || 'Horario inválido' }),
      });
    }, 250);
  }
  formValido(): boolean {
    const f = this.form;
    if (f.modo === 'rutina' ? !f.integrada : !f.message.trim()) return false;
    if (!DeliveryPickerComponent.valida(f.delivery)) return false;
    const h = this.horario();
    if (!h) return false;
    if (h.kind === 'once' && new Date(h.run_at as string).getTime() <= Date.now()) return false;
    return !this.prev()?.error;
  }
  private limpia(d: TaskDelivery[]) { return d.map((x) => ({ channel: x.channel, target: x.channel === 'telegram' ? null : ((x.target || '').trim() || null) })); }

  guardar(probar: boolean) {
    const f = this.form;
    const h = this.horario()!;
    const base: Partial<TaskInput> = { ...h, delivery: this.limpia(f.delivery) };
    let req;
    if (f.id) {
      const t = this.items().find((x) => x.id === f.id)!;
      req = this.api.updateTask(f.id, { ...base, ...(t.autonomous === 2 ? {} : { message: f.message.trim() }), ...(t.autonomous === 1 ? { model: f.model || null } : {}) });
    } else {
      const datos: TaskInput = f.modo === 'rutina'
        ? { ...(base as any), message: f.integrada, autonomous: 2 }
        : { ...(base as any), message: f.message.trim(), autonomous: f.modo === 'agente', ...(f.modo === 'agente' && f.model ? { model: f.model } : {}) };
      req = this.api.createTask(datos);
    }
    this.guardando.set(true);
    req.subscribe({
      next: (r) => {
        this.guardando.set(false); this.modal.set(false);
        this.toast.ok(f.id ? 'Tarea actualizada' : 'Tarea programada');
        this.load();
        const tarea = (r as any)?.task as ScheduledTask | undefined;
        if (probar && tarea) { this.abierta.set(null); this.ejecutar(tarea); setTimeout(() => this.toggleDetalle(tarea), 400); }
      },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); },
    });
  }
}
