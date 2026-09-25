import { ChangeDetectorRef, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, BackfillEstado, Commitment, CommitmentMsgTipo, CommitmentPerson, CommitmentStatus, CommitmentUpdate, TaskDelivery } from '../../services/api.service';
import { DeliveryPickerComponent } from '../tasks/delivery-picker';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';

type Vista = 'propuestos' | 'abiertos' | 'vencidos' | 'hechos' | 'todos';
type Orden = 'auto' | 'fecha_asc' | 'fecha_desc' | 'actividad_desc' | 'creado_desc' | 'creado_asc' | 'prioridad';
const ORDENES: Array<{ id: Orden; label: string }> = [
  { id: 'auto', label: 'Estado y fecha' },
  { id: 'fecha_asc', label: 'Fecha ↑ (más próxima)' },
  { id: 'fecha_desc', label: 'Fecha ↓ (más lejana)' },
  { id: 'actividad_desc', label: 'Última actividad' },
  { id: 'creado_desc', label: 'Creados: recientes' },
  { id: 'creado_asc', label: 'Creados: antiguos' },
  { id: 'prioridad', label: 'Prioridad' },
];
const PRIO: Record<string, number> = { alta: 0, media: 1, baja: 2 };

/** Estado del modal de mensajes (avisos, reminders y mensajes a involucrados). */
interface Envio {
  c: Commitment;
  kind: 'aviso' | 'recordatorio' | 'mensaje';
  status: CommitmentStatus | null;
  personas: CommitmentPerson[];
  para: string;                 // nombre del destinatario ('' mientras se escribe uno nuevo)
  nuevo: boolean;               // destinatario que aún no está en el compromiso
  rol: string;
  message: string;
  generado: string;             // último texto que salió de la IA (o ya corregido)
  redactando: boolean;
  delivery: TaskDelivery[];
  auto?: boolean;
  corregido: string | null;     // propuesta del corrector pendiente de confirmar
  corrigiendo: boolean;
  opciones: boolean;             // panel "¿qué generar?" abierto
}

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
          <button class="btn-secondary" (click)="completarContexto()" [disabled]="enriqueciendo()" title="Escribe 1-2 frases de contexto a los compromisos que no lo tienen, desde su reunión o hilo de origen"><i class="ph" [class.ph-text-align-left]="!enriqueciendo()" [class.ph-spinner]="enriqueciendo()"></i> Completar contexto</button>
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
        <label class="orden" title="Orden de la lista">
          <i class="ph ph-sort-ascending"></i>
          <select [ngModel]="orden()" (ngModelChange)="setOrden($event)">
            @for (o of ordenes; track o.id) { <option [value]="o.id">{{ o.label }}</option> }
          </select>
        </label>
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
                @if (c.reminder_auto) { <span class="tb rem" title="Friendly reminder automático: 1 día antes y cada día vencido"><i class="ph ph-bell-ringing"></i> reminder</span> }
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
                  @if (!c.mine) {
                    <button class="ta rem" [class.on]="!!c.reminder_auto" [title]="c.reminder_auto ? 'Friendly reminder (automático activo)' : 'Friendly reminder a ' + c.owner" (click)="abrirRecordatorio(c)"><i class="ph" [class.ph-bell-ringing]="!!c.reminder_auto" [class.ph-bell]="!c.reminder_auto"></i></button>
                  }
                  <button class="ta" title="Escribir a alguien sobre este compromiso (con todo el contexto)" (click)="abrirMensaje(c)"><i class="ph ph-paper-plane-tilt"></i></button>
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
              @if (c.detail) { <div class="cm-detail"><i class="ph ph-info"></i><span>{{ c.detail }}</span></div> }
              @else if (c.source_type && c.source_type !== 'manual') { <div class="cm-detail vacio"><i class="ph ph-info"></i><span>Sin contexto todavía — usa "Completar contexto" arriba.</span></div> }

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

                  <div class="personas">
                    <span class="lbl"><i class="ph ph-users-three"></i> Personas</span>
                    @for (p of personas(); track p.nombre) {
                      <span class="persona" [attr.data-rel]="p.relacion">
                        <button class="p-nombre" (click)="abrirMensaje(c, p.nombre)" [title]="'Escribir a ' + p.nombre + (p.delivery.length ? ' (' + canales(p.delivery) + ')' : '')">
                          <i class="ph ph-paper-plane-tilt"></i> {{ p.nombre }}
                        </button>
                        <small>{{ p.rol || relLabel(p.relacion) }}</small>
                        @if (p.relacion === 'involucrado') { <button class="p-x" title="Quitar" (click)="quitarPersona(c, p.nombre)"><i class="ph ph-x"></i></button> }
                      </span>
                    }
                    <span class="p-add">
                      <input type="text" [(ngModel)]="personaNueva" placeholder="Sumar persona (p. ej. Fabricio)" (keydown.enter)="agregarPersona(c)" />
                      <input type="text" [(ngModel)]="rolNuevo" placeholder="Rol (opcional)" class="rol" (keydown.enter)="agregarPersona(c)" />
                      <button class="btn-secondary sm" [disabled]="!personaNueva.trim()" (click)="agregarPersona(c)"><i class="ph ph-user-plus"></i></button>
                    </span>
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
            <h3>{{ tituloEnvio(z) }}</h3>
            <button class="btn-icon" (click)="cierre.set(null)"><i class="ph ph-x"></i></button>
          </div>
          <div class="modal-body">
            <p class="card-sub"><strong>{{ z.c.title }}</strong>@if (z.c.counterpart) { · con {{ z.c.counterpart }} }</p>

            <label class="field">
              <span>Para</span>
              <div class="para">
                <select [ngModel]="z.nuevo ? '__otra' : z.para" (ngModelChange)="elegirPara($event)">
                  @for (p of z.personas; track p.nombre) { <option [value]="p.nombre">{{ p.nombre }} · {{ p.rol || relLabel(p.relacion) }}</option> }
                  <option value="__otra">Otra persona…</option>
                </select>
                @if (z.nuevo) {
                  <input type="text" [ngModel]="z.para" (ngModelChange)="patch({ para: $event })" placeholder="Nombre (p. ej. Fabricio)" />
                  <input type="text" [ngModel]="z.rol" (ngModelChange)="patch({ rol: $event })" placeholder="Rol (opcional)" />
                }
              </div>
              @if (z.nuevo) { <small class="hint">Queda sumada al compromiso como involucrada, con el canal que elijas.</small> }
            </label>

            <label class="field">
              <span class="msg-head">
                Mensaje
                <span class="spacer"></span>
                <button class="lnk" [class.on]="z.opciones" [disabled]="z.redactando || !z.para.trim()" (click)="patch({ opciones: !z.opciones })" title="Redacta el texto con IA a partir del historial del compromiso">
                  <i class="ph" [class.ph-sparkle]="!z.redactando" [class.ph-spinner]="z.redactando"></i> {{ z.redactando ? 'Generando con el contexto…' : (z.message.trim() ? 'Generar de nuevo…' : 'Generar texto…') }}
                </button>
                <button class="lnk" [disabled]="z.corrigiendo || !z.message.trim()" (click)="corregir()" title="Ortografía, tildes y puntuación">
                  <i class="ph" [class.ph-spell-check]="!z.corrigiendo" [class.ph-spinner]="z.corrigiendo"></i> Corregir
                </button>
              </span>
              @if (z.opciones) {
                <div class="gen">
                  <div class="gen-row">
                    <span>Contenido</span>
                    <div class="seg sm">
                      <button type="button" [class.on]="gen.enfoque === 'reciente'" (click)="setGen('enfoque', 'reciente')" title="Novedades de los últimos días y lo que falta ahora">Contexto reciente</button>
                      <button type="button" [class.on]="gen.enfoque === 'general'" (click)="setGen('enfoque', 'general')" title="Toda la historia: de dónde viene, qué se hizo, dónde está y qué falta">Resumen general</button>
                    </div>
                  </div>
                  <div class="gen-row">
                    <span>Formato</span>
                    <div class="seg sm">
                      <button type="button" [class.on]="gen.formato === 'mensaje'" (click)="setGen('formato', 'mensaje')">Mensaje de chat</button>
                      <button type="button" [class.on]="gen.formato === 'ejecutivo'" (click)="setGen('formato', 'ejecutivo')" title="Para un C-level: estado, avance, pendiente, riesgos y próximo paso">Resumen ejecutivo</button>
                    </div>
                  </div>
                  <div class="gen-row fin">
                    <small class="hint">{{ gen.formato === 'ejecutivo' ? 'Estado, avance, pendiente, riesgos y próximo paso; tono institucional.' : gen.enfoque === 'general' ? 'Cuenta la historia completa en pocas frases.' : 'Se centra en lo último que pasó y lo que falta.' }}</small>
                    <button type="button" class="btn-primary sm" (click)="redactar()"><i class="ph ph-sparkle"></i> Generar</button>
                  </div>
                </div>
              }
              <textarea [rows]="gen.formato === 'ejecutivo' && z.message.length > 300 ? 9 : 5" [ngModel]="z.message" (ngModelChange)="patch({ message: $event, corregido: null })" [disabled]="z.redactando"></textarea>
              <small class="hint">Escríbelo tú o usa "Generar texto" (usa el historial: notas, avisos y respuestas). Lo que escribas o edites se revisa con el corrector antes de enviar.</small>
            </label>

            @if (z.corregido) {
              <div class="corregido">
                <div class="c-head"><i class="ph ph-spell-check"></i> Versión corregida</div>
                <div class="c-text">{{ z.corregido }}</div>
                <div class="row">
                  <button class="btn-secondary sm" (click)="patch({ corregido: null })">Seguir editando</button>
                  <span class="spacer"></span>
                  <button class="btn-secondary sm" [disabled]="enviando()" (click)="enviar(true)">Enviar mi versión</button>
                  <button class="btn-primary sm" [disabled]="enviando()" (click)="usarCorreccion(true)"><i class="ph ph-paper-plane-tilt"></i> Enviar corregido</button>
                </div>
              </div>
            }

            <label class="field"><span>{{ z.kind === 'recordatorio' ? 'Recordar por' : 'Enviar por' }}</span></label>
            <app-delivery-picker [value]="z.delivery" (valueChange)="patch({ delivery: $event })" />
            @if (z.kind === 'recordatorio' && esResponsable(z)) {
              <label class="check" style="margin-top:12px">
                <input type="checkbox" [checked]="z.auto" (change)="patch({ auto: $any($event.target).checked })" />
                <span><strong>Recordar automáticamente</strong> a {{ z.c.owner }} por estos canales: 1 día antes de la fecha y cada día que siga vencido, con un mensaje redactado con el contexto del momento.</span>
              </label>
            }
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="cierre.set(null)">Cancelar</button>
            @if (z.status) { <button class="btn-secondary" (click)="soloEstado()">Solo {{ z.status === 'hecho' ? 'marcar hecho' : 'cancelar' }}</button> }
            @if (z.kind === 'recordatorio' && esResponsable(z)) { <button class="btn-secondary" [disabled]="enviando()" (click)="guardarRecordatorio()">Solo guardar ajuste</button> }
            <button class="btn-primary" [disabled]="!z.delivery.length || !z.para.trim() || !z.message.trim() || z.redactando || enviando() || !!z.corregido" (click)="enviar(false)">
              <i class="ph" [class.ph-spinner]="z.corrigiendo" [class.ph-paper-plane-tilt]="!z.corrigiendo"></i> {{ z.corrigiendo ? 'Revisando…' : textoEnviar(z) }}
            </button>
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
    .tb.rem { background: rgba(245,158,11,.14); color: var(--warn); text-transform: none; letter-spacing: 0; }
    .ta.rem.on { border-color: var(--warn); color: var(--warn); }
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
    .cm-detail { margin-top: 8px; font-size: 13.5px; color: var(--text-main); white-space: pre-wrap; display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: 8px; background: var(--bg-main); border-left: 3px solid var(--accent-primary); }
    .cm-detail i { color: var(--accent-primary); margin-top: 2px; flex-shrink: 0; }
    .cm-detail.vacio { color: var(--text-dim); border-left-color: var(--border-light); font-style: italic; }
    .detalle { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--border-light); }
    .campos { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0 12px; }
    .campos .detalle-txt { grid-column: 1 / -1; }
    .nota-row { display: flex; gap: 8px; margin-bottom: 10px; }
    .hist-item { display: grid; grid-template-columns: 110px auto 1fr auto; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border-light); font-size: 13px; }
    .hist-when, .hist-by { color: var(--text-dim); font-size: 12px; }
    .dos { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
    .check { display: flex; align-items: flex-start; gap: 10px; margin: 4px 0 4px; cursor: pointer; font-size: 13.5px; }
    .check input { margin-top: 3px; width: 15px; height: 15px; accent-color: var(--accent-primary); }
    .bf { margin-top: 6px; padding: 10px 12px; border-radius: 8px; background: var(--bg-main); font-size: 13px; }
    .dim { color: var(--text-dim); }
    .orden { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); }
    .orden select { width: auto; padding: 7px 10px; font-size: 13px; }
    .personas { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
    .personas .lbl { font-size: 12px; color: var(--text-dim); display: inline-flex; gap: 5px; align-items: center; margin-right: 2px; }
    .persona { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 3px; border: 1px solid var(--border-light); border-radius: 999px; background: var(--bg-main); }
    .persona[data-rel=responsable] { border-color: rgba(245,158,11,.45); }
    .persona[data-rel=contraparte] { border-color: rgba(129,140,248,.45); }
    .persona small { font-size: 11px; color: var(--text-dim); }
    .p-nombre { border: none; background: var(--bg-card); color: var(--text-main); border-radius: 999px; padding: 4px 10px; cursor: pointer; font-size: 13px; display: inline-flex; gap: 5px; align-items: center; }
    .p-nombre:hover { color: var(--accent-primary); }
    .p-x { border: none; background: none; color: var(--text-dim); cursor: pointer; padding: 2px 6px; }
    .p-x:hover { color: var(--danger); }
    .p-add { display: inline-flex; gap: 6px; align-items: center; }
    .p-add input { width: 190px; padding: 6px 9px; font-size: 13px; } .p-add input.rol { width: 130px; }
    .para { display: flex; gap: 8px; flex-wrap: wrap; } .para select { flex: 1; min-width: 200px; } .para input { flex: 1; min-width: 140px; }
    .msg-head { display: flex; align-items: center; gap: 12px; }
    .lnk { border: none; background: none; color: var(--accent-primary); cursor: pointer; font-size: 12.5px; display: inline-flex; gap: 5px; align-items: center; padding: 0; }
    .lnk:disabled { color: var(--text-dim); cursor: default; }
    .lnk.on { text-decoration: underline; }
    .gen { border: 1px solid var(--border-light); background: var(--bg-main); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 8px; }
    .gen-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px; }
    .gen-row > span { width: 72px; color: var(--text-dim); }
    .gen-row.fin { justify-content: space-between; } .gen-row.fin .hint { flex: 1; min-width: 180px; }
    .seg.sm button { padding: 6px 10px; font-size: 12.5px; }
    .corregido { border: 1px solid rgba(16,185,129,.45); background: rgba(16,185,129,.07); border-radius: 10px; padding: 10px 12px; margin: -4px 0 14px; }
    .c-head { font-size: 12px; font-weight: 700; color: var(--ok); display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
    .c-text { white-space: pre-wrap; font-size: 13.5px; margin-bottom: 10px; }
    .spin, .ph-spinner { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 640px) { .p-add { flex-wrap: wrap; } .p-add input, .p-add input.rol { width: 100%; } .cm-head { flex-direction: column; } .dos { grid-template-columns: 1fr; } .hist-item { grid-template-columns: 1fr; gap: 2px; } }
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
  enriqueciendo = signal(false);
  private pollEnrich: any = null;
  cierre = signal<Envio | null>(null);
  personas = signal<CommitmentPerson[]>([]);
  personaNueva = '';
  rolNuevo = '';
  ordenes = ORDENES;
  orden = signal<Orden>(this.leerOrden());
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
    const lista = this.items().filter((c) =>
      (quien === '' || String(c.mine) === quien) &&
      (!f || [c.title, c.detail, c.owner, c.counterpart, c.source_title, c.id, c.participants].some((x) => (x || '').toLowerCase().includes(f))));
    return this.ordenar(lista, this.orden());
  });

  /** 'auto' respeta el orden del backend (estado y fecha). Sin fecha va siempre al final. */
  private ordenar(lista: Commitment[], orden: Orden): Commitment[] {
    if (orden === 'auto') return lista;
    const fecha = (c: Commitment) => c.due_date || c.proposed_due || '';
    const porFecha = (dir: 1 | -1) => (a: Commitment, b: Commitment) => {
      const fa = fecha(a), fb = fecha(b);
      if (!fa || !fb) return fa ? -1 : fb ? 1 : 0;
      return fa < fb ? -dir : fa > fb ? dir : 0;
    };
    const cmp: Record<Exclude<Orden, 'auto'>, (a: Commitment, b: Commitment) => number> = {
      fecha_asc: porFecha(1),
      fecha_desc: porFecha(-1),
      actividad_desc: (a, b) => b.updated_at - a.updated_at,
      creado_desc: (a, b) => b.created_at - a.created_at,
      creado_asc: (a, b) => a.created_at - b.created_at,
      prioridad: (a, b) => (PRIO[a.priority] ?? 1) - (PRIO[b.priority] ?? 1) || porFecha(1)(a, b),
    };
    return [...lista].sort(cmp[orden]);
  }
  private leerOrden(): Orden {
    try { const v = localStorage.getItem('yisus_commitments_orden') as Orden; return ORDENES.some((o) => o.id === v) ? v : 'auto'; } catch { return 'auto'; }
  }
  setOrden(o: Orden) { this.orden.set(o); try { localStorage.setItem('yisus_commitments_orden', o); } catch {} }

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
  // ─── Mensajes: avisos, reminders y mensajes a involucrados ───────────
  relLabel(r: CommitmentPerson['relacion']) { return r === 'responsable' ? 'responsable' : r === 'contraparte' ? 'contraparte' : 'involucrado'; }
  canales(d: TaskDelivery[]) { return d.map((x) => x.channel).join(' + '); }
  esResponsable(z: Envio) { return !z.c.mine && !z.nuevo && z.para.trim().toLowerCase() === z.c.owner.trim().toLowerCase(); }
  tituloEnvio(z: Envio) {
    if (z.status === 'hecho') return 'Marcar como hecho';
    if (z.status === 'cancelado') return 'Cancelar compromiso';
    return z.kind === 'recordatorio' ? 'Friendly reminder' : 'Escribir sobre este compromiso';
  }
  textoEnviar(z: Envio) {
    if (z.status) return z.status === 'hecho' ? 'Marcar y avisar' : 'Cancelar y avisar';
    return z.kind === 'recordatorio' && this.esResponsable(z) ? 'Enviar reminder ahora' : `Enviar${z.para.trim() ? ' a ' + z.para.trim().split(' ')[0] : ''}`;
  }
  patch(cambios: Partial<Envio>) { const z = this.cierre(); if (z) this.cierre.set({ ...z, ...cambios }); }

  abrirRecordatorio(c: Commitment) { this.abrirEnvio(c, 'recordatorio', null, c.owner); }
  abrirMensaje(c: Commitment, para?: string) { this.abrirEnvio(c, 'mensaje', null, para); }
  abrirCierre(c: Commitment, status: CommitmentStatus | null) { this.abrirEnvio(c, status ? 'aviso' : 'mensaje', status); }

  private abrirEnvio(c: Commitment, kind: Envio['kind'], status: CommitmentStatus | null, para?: string) {
    this.cierre.set({ c, kind, status, personas: [], para: para || '', nuevo: false, rol: '', message: '', generado: '', redactando: false, delivery: [], auto: !!c.reminder_auto, corregido: null, corrigiendo: false, opciones: false });
    this.api.getCommitmentPeople(c.id).subscribe({
      next: (r) => {
        const z = this.cierre(); if (!z || z.c.id !== c.id) return;
        const destino = para || (kind === 'recordatorio' ? c.owner : status ? (c.counterpart || r.people[0]?.nombre) : r.people[0]?.nombre) || '';
        const p = r.people.find((x) => x.nombre.toLowerCase() === destino.toLowerCase());
        if (!p && !r.people.length) { this.cierre.set({ ...z, personas: r.people, nuevo: true, para: '' }); return; }
        // El texto NO se genera solo: se escribe a mano o con "Generar texto".
        this.cierre.set({ ...z, personas: r.people, para: p?.nombre || destino, delivery: p?.delivery || [] });
      },
      error: () => {},
    });
  }

  elegirPara(nombre: string) {
    const z = this.cierre(); if (!z) return;
    if (nombre === '__otra') { this.cierre.set({ ...z, nuevo: true, para: '', rol: '', message: '', generado: '', delivery: [], corregido: null }); return; }
    const p = z.personas.find((x) => x.nombre === nombre);
    this.cierre.set({ ...z, nuevo: false, para: nombre, delivery: p?.delivery || [], corregido: null });
  }

  private tipoPara(z: Envio): CommitmentMsgTipo | undefined {
    if (z.status === 'hecho' || z.status === 'cancelado') return z.status;
    if (z.nuevo) return 'seguimiento';
    if (z.kind === 'recordatorio') return this.esResponsable(z) ? 'recordatorio' : 'seguimiento';
    return undefined; // el backend lo deduce de la relación con el compromiso
  }

  /** Última elección de "qué generar" (se recuerda por navegador). */
  gen: { enfoque: 'reciente' | 'general'; formato: 'mensaje' | 'ejecutivo' } = this.leerGen();
  private leerGen(): { enfoque: 'reciente' | 'general'; formato: 'mensaje' | 'ejecutivo' } {
    try { const v = JSON.parse(localStorage.getItem('yisus_commitments_gen') || '{}'); return { enfoque: v.enfoque === 'general' ? 'general' : 'reciente', formato: v.formato === 'ejecutivo' ? 'ejecutivo' : 'mensaje' }; }
    catch { return { enfoque: 'reciente', formato: 'mensaje' }; }
  }
  setGen<K extends 'enfoque' | 'formato'>(k: K, v: (typeof this.gen)[K]) {
    this.gen = { ...this.gen, [k]: v };
    try { localStorage.setItem('yisus_commitments_gen', JSON.stringify(this.gen)); } catch {}
  }

  redactar() {
    const z = this.cierre(); if (!z || !z.para.trim()) return;
    if (z.message.trim() && z.message.trim() !== z.generado.trim() && !confirm('¿Reemplazar lo que escribiste por un texto generado?')) return;
    this.patch({ redactando: true, corregido: null, opciones: false });
    this.api.draftCommitmentMessage(z.c.id, { para: z.para.trim(), tipo: this.tipoPara(z), status: z.status, enfoque: this.gen.enfoque, formato: this.gen.formato }).subscribe({
      next: (r) => { const a = this.cierre(); if (a && a.c.id === z.c.id) this.cierre.set({ ...a, message: r.message, generado: r.message, redactando: false }); },
      error: (e) => { this.patch({ redactando: false }); this.toast.error(e?.error?.error || 'No se pudo redactar'); },
    });
  }

  corregir(despues?: () => void) {
    const z = this.cierre(); if (!z?.message.trim()) return;
    this.patch({ corrigiendo: true });
    this.api.correctText(z.message).subscribe({
      next: (r) => {
        const a = this.cierre(); if (!a) return;
        if (r.cambiado) { this.cierre.set({ ...a, corrigiendo: false, corregido: r.texto }); return; }
        this.cierre.set({ ...a, corrigiendo: false, generado: a.message });
        if (despues) despues(); else this.toast.ok('Sin correcciones');
      },
      error: () => { this.patch({ corrigiendo: false }); if (despues) despues(); else this.toast.error('No se pudo corregir'); },
    });
  }

  usarCorreccion(enviar: boolean) {
    const z = this.cierre(); if (!z?.corregido) return;
    this.cierre.set({ ...z, message: z.corregido, generado: z.corregido, corregido: null });
    if (enviar) this.enviar(true);
  }

  /** Si el texto lo editó Jesús (difiere de lo redactado), pasa por el corrector antes de enviar. */
  enviar(saltarCorreccion: boolean) {
    const z = this.cierre(); if (!z) return;
    if (!saltarCorreccion && z.message.trim() !== z.generado.trim()) { this.corregir(() => this.enviar(true)); return; }
    this.patch({ corregido: null });
    this.enviando.set(true);
    const para = z.para.trim();
    const fin = () => { this.enviando.set(false); this.cierre.set(null); this.load(); if (this.abierto() === z.c.id) this.cargarDetalle(z.c.id); };
    const notificar = () => this.api.notifyCommitment(z.c.id, z.delivery, z.message, para).subscribe({
      next: (r) => { this.toast.ok(`Enviado a ${para} por ${r.enviados.join(' + ')}${r.fallos.length ? ' · fallos: ' + r.fallos.join(' · ') : ''}`); fin(); },
      error: (e) => { this.toast.error(e?.error?.error || 'No se pudo enviar'); fin(); },
    });
    const pasos: Array<() => Promise<unknown>> = [];
    if (z.nuevo) pasos.push(() => firstValueFrom(this.api.addCommitmentPerson(z.c.id, { nombre: para, rol: z.rol.trim() || null, delivery: z.delivery })));
    if (z.kind === 'recordatorio' && this.esResponsable(z)) pasos.push(() => firstValueFrom(this.api.setCommitmentReminder(z.c.id, !!z.auto, z.delivery)));
    if (z.status) pasos.push(() => firstValueFrom(this.api.updateCommitment(z.c.id, { status: z.status! })));
    pasos.reduce((p, f) => p.then(f), Promise.resolve() as Promise<unknown>)
      .then(() => notificar())
      .catch((e) => { this.toast.error(e?.error?.error || 'No se pudo guardar'); this.enviando.set(false); });
  }

  soloEstado() {
    const z = this.cierre(); if (!z?.status) return;
    this.api.updateCommitment(z.c.id, { status: z.status }).subscribe({
      next: () => { this.toast.ok(`${z.c.id}: ${ESTADO_LABEL[z.status!]}`); this.cierre.set(null); this.load(); if (this.abierto() === z.c.id) this.cargarDetalle(z.c.id); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo cambiar'),
    });
  }

  guardarRecordatorio() {
    const z = this.cierre(); if (!z) return;
    this.enviando.set(true);
    this.api.setCommitmentReminder(z.c.id, !!z.auto, z.delivery.length ? z.delivery : null).subscribe({
      next: () => { this.toast.ok(z.auto ? 'Reminder automático activado' : 'Ajuste guardado'); this.enviando.set(false); this.cierre.set(null); this.load(); if (this.abierto() === z.c.id) this.cargarDetalle(z.c.id); },
      error: (e) => { this.toast.error(e?.error?.error || 'No se pudo guardar'); this.enviando.set(false); },
    });
  }

  // ─── Personas del compromiso ──────────────────────────────────────────
  agregarPersona(c: Commitment) {
    const nombre = this.personaNueva.trim(); if (!nombre) return;
    this.api.addCommitmentPerson(c.id, { nombre, rol: this.rolNuevo.trim() || null }).subscribe({
      next: (r) => { this.personas.set(r.people); this.historial.set(r.updates); this.personaNueva = ''; this.rolNuevo = ''; this.cdr.markForCheck(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo agregar'),
    });
  }
  quitarPersona(c: Commitment, nombre: string) {
    this.api.removeCommitmentPerson(c.id, nombre).subscribe({
      next: (r) => { this.personas.set(r.people); this.historial.set(r.updates); this.cdr.markForCheck(); },
      error: () => this.toast.error('No se pudo quitar'),
    });
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
    this.api.updateCommitment(c.id, p).subscribe({ next: () => { delete this.pend[c.id]; this.toast.ok('Guardado'); this.load(); this.cargarDetalle(c.id); }, error: (e) => this.toast.error(e?.error?.error || 'No se pudo guardar') });
  }
  eliminar(c: Commitment) {
    if (!confirm(`¿Eliminar "${c.title}"? Se pierde su historial.`)) return;
    this.api.deleteCommitment(c.id).subscribe({ next: () => { this.toast.ok('Eliminado'); this.load(); }, error: () => this.toast.error('No se pudo eliminar') });
  }
  toggleDetalle(c: Commitment) {
    if (this.abierto() === c.id) { this.abierto.set(null); return; }
    this.abierto.set(c.id); this.notaNueva = ''; this.personas.set([]); this.cargarDetalle(c.id);
  }
  private cargarHistorial(id: string) {
    this.api.getCommitment(id).subscribe({ next: (r) => { this.historial.set(r.updates); this.cdr.markForCheck(); }, error: () => {} });
  }
  private cargarDetalle(id: string) {
    this.cargarHistorial(id);
    this.api.getCommitmentPeople(id).subscribe({ next: (r) => { this.personas.set(r.people); this.cdr.markForCheck(); }, error: () => {} });
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

  completarContexto() {
    this.enriqueciendo.set(true);
    this.api.enrichCommitments().subscribe({
      next: () => {
        clearInterval(this.pollEnrich);
        this.pollEnrich = setInterval(() => this.api.getCommitmentsEnrich().subscribe({ next: (e) => {
          if (!e.corriendo) { clearInterval(this.pollEnrich); this.enriqueciendo.set(false); this.toast.ok(`Contexto completado en ${e.hechos} compromiso(s)${e.sinFuente ? ` · ${e.sinFuente} sin fuente` : ''}`); this.load(); }
        } }), 3000);
      },
      error: (e) => { this.enriqueciendo.set(false); this.toast.error(e?.error?.error || 'No se pudo'); },
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
