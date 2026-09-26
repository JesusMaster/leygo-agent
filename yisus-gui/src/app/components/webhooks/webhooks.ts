import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, CustomWebhook, CustomWebhookLog, TaskDelivery, WebhookProvider, WebhookTestResult } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { DeliveryPickerComponent } from '../tasks/delivery-picker';
import { ModelPickerComponent } from '../model-picker/model-picker';
import { CodeEditorComponent } from '../code-editor/code-editor';

type Modo = 'siempre' | 'importante';
type FiltroLog = 'todos' | 'error' | 'silenced' | 'prueba';

const ICONO_CANAL: Record<string, string> = { telegram: 'ph-telegram-logo', chat: 'ph-chats-circle', buzz: 'ph-broadcast', email: 'ph-envelope-simple', a2a: 'ph-robot' };
const NOMBRE_CANAL: Record<string, string> = { telegram: 'Telegram', chat: 'Google Chat', buzz: 'Buzz', email: 'Correo', a2a: 'A2A' };

const PLANTILLAS: Array<{ nombre: string; payload: any }> = [
  { nombre: 'Genérico', payload: { evento: 'prueba', mensaje: 'Hola desde Yisus', fecha: new Date().toISOString() } },
  { nombre: 'SonarQube', payload: { project: { key: 'yisus-agent', name: 'yisus-agent' }, branch: { name: 'main' }, qualityGate: { status: 'ERROR', conditions: [{ metric: 'new_bugs', status: 'ERROR', value: '3' }, { metric: 'new_coverage', status: 'OK', value: '82.4' }] } } },
  { nombre: 'Alerta GCP', payload: { incident: { policy_name: 'Cloud Run 5xx > 2%', state: 'open', resource_display_name: 'api-canjes', summary: 'Tasa de error 4,1% en los últimos 5 minutos', url: 'https://console.cloud.google.com/monitoring/alerting' } } },
  { nombre: 'GitHub push', payload: { ref: 'refs/heads/main', repository: { full_name: 'apprecio/yisus-agent' }, pusher: { name: 'jleiva' }, head_commit: { message: 'fix: entrega de webhooks por canal', url: 'https://github.com/apprecio/yisus-agent/commit/abc123' } } },
  { nombre: 'Sentry', payload: { action: 'created', data: { issue: { title: 'TypeError: cannot read properties of undefined', culprit: 'canjes.service.ts', level: 'error', count: '37' } } } },
];

/**
 * Smart Webhooks: cada POST que llega se procesa con IA según sus instrucciones y
 * se avisa por los canales elegidos (o se descarta si no es importante).
 * Tarjetas con estado y actividad, editor lateral, prueba con payloads de ejemplo
 * y logs filtrables.
 */
@Component({
  selector: 'app-webhooks',
  imports: [FormsModule, FriendlyDatePipe, MarkdownPipe, DeliveryPickerComponent, ModelPickerComponent, CodeEditorComponent],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Smart Webhooks</h2>
          <p class="sub">Apunta tus sistemas (SonarQube, GCP, GitHub, n8n…) a una URL: cada payload lo procesa la IA con tus instrucciones y te avisa donde elijas, o lo descarta si no importa.</p>
        </div>
        <div class="row">
          <button class="btn-secondary" (click)="verEjecuciones()"><i class="ph ph-terminal"></i> Ejecuciones</button>
          <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Nuevo webhook</button>
        </div>
      </div>

      @if (!cargado()) {
        <div class="card"><div class="empty">Cargando webhooks…</div></div>
      } @else if (items().length === 0) {
        <div class="card vacio">
          <span class="vacio-ico"><i class="ph ph-share-network"></i></span>
          <h3>Todavía no hay webhooks</h3>
          <p>Crea uno, copia su URL y apúntale desde tu sistema. Por ejemplo: "resume el análisis de SonarQube y avísame en Google Chat solo si falla el quality gate".</p>
          <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Crear el primero</button>
        </div>
      } @else {
        @let r = resumen();
        <div class="resumen">
          <span><b>{{ r.activos }}</b> activo{{ r.activos === 1 ? '' : 's' }} de {{ items().length }}</span>
          <span><b>{{ r.semana }}</b> ejecuciones esta semana</span>
          @if (r.silenciados) { <span><b>{{ r.silenciados }}</b> descartadas por no importantes</span> }
          @if (r.errores) { <span class="bad"><i class="ph ph-warning-circle"></i> <b>{{ r.errores }}</b> con error</span> }
        </div>

        <div class="wh-grid">
          @for (w of items(); track w.id) {
            @let st = w.stats;
            <article class="wh" [class.off]="w.paused === 1">
              <header class="wh-top">
                <span class="wh-ico"><i class="ph ph-share-network"></i></span>
                <div class="wh-tit">
                  <h3 [title]="w.titulo">{{ w.titulo }}</h3>
                  <small class="dim">{{ w.paused === 1 ? 'Pausado: responde 403 y no procesa' : 'Activo' }}</small>
                </div>
                <label class="switch" [title]="w.paused === 1 ? 'Pausado: clic para activar' : 'Activo: clic para pausar'">
                  <input type="checkbox" [checked]="w.paused !== 1" (change)="alternar(w)" /><span></span>
                </label>
              </header>

              <p class="wh-desc" [title]="w.instrucciones">{{ w.instrucciones }}</p>

              <div class="chips">
                <span class="tag" [class.acc]="w.modo === 'importante'" [title]="w.modo === 'importante' ? 'La IA descarta lo rutinario y solo avisa lo que importa' : 'Avisa por cada payload'">
                  <i class="ph" [class.ph-funnel]="w.modo === 'importante'" [class.ph-bell-ringing]="w.modo !== 'importante'"></i> {{ w.modo === 'importante' ? 'Solo si importa' : 'Avisa siempre' }}
                </span>
                @for (d of destinos(w); track $index) {
                  <span class="tag" [title]="d.target || ''"><i class="ph {{ icono(d.channel) }}"></i> {{ nombreCanal(d.channel) }}@if (d.target && d.channel !== 'telegram') { <em>{{ corto(d.target) }}</em> }</span>
                }
                @if (!w.delivery?.length) { <span class="tag dimtag" title="Sin destinos configurados: avisa por Telegram">por defecto</span> }
                <span class="tag" [title]="w.modelo"><i class="ph ph-cpu"></i> {{ modeloCorto(w.modelo) }}</span>
                @if (w.tieneSecreto) { <span class="tag ok" title="Exige X-Webhook-Secret"><i class="ph ph-lock-simple"></i> con secreto</span> }
                @else { <span class="tag warn" title="Cualquiera con la URL puede dispararlo"><i class="ph ph-lock-simple-open"></i> sin secreto</span> }
              </div>

              <div class="actividad">
                @if (st?.ultimo) {
                  <span class="estado" [class.ok]="st!.ultimoEstado === 'success'" [class.bad]="st!.ultimoEstado === 'error'" [class.sil]="st!.ultimoEstado === 'silenced'">
                    <i class="ph" [class.ph-check-circle]="st!.ultimoEstado === 'success'" [class.ph-x-circle]="st!.ultimoEstado === 'error'" [class.ph-bell-slash]="st!.ultimoEstado === 'silenced'" [class.ph-pause-circle]="st!.ultimoEstado === 'skipped'"></i>
                    Última {{ st!.ultimo | friendlyDate }}
                  </span>
                  <span class="dim">{{ st!.semana }} esta semana</span>
                  @if (st!.errores) { <span class="bad">{{ st!.errores }} error{{ st!.errores === 1 ? '' : 'es' }}</span> }
                  @if (st!.silenciados) { <span class="dim">{{ st!.silenciados }} descartada{{ st!.silenciados === 1 ? '' : 's' }}</span> }
                } @else {
                  <span class="dim"><i class="ph ph-hourglass"></i> Aún no recibe nada: pruébalo o apunta tu sistema a la URL</span>
                }
              </div>

              <div class="url">
                <code [title]="url(w)">{{ url(w) }}</code>
                <button class="btn-icon" title="Copiar URL" (click)="copiar(url(w), 'URL copiada')"><i class="ph ph-copy"></i></button>
                <button class="btn-icon" title="Copiar ejemplo curl" (click)="copiar(curl(w), 'Ejemplo curl copiado')"><i class="ph ph-terminal-window"></i></button>
              </div>

              <footer class="wh-pie">
                <button class="btn-secondary sm" (click)="abrirPrueba(w)"><i class="ph ph-play"></i> Probar</button>
                <button class="btn-secondary sm" (click)="verLogs(w)"><i class="ph ph-list-magnifying-glass"></i> Logs@if (st?.total) { <span class="n">{{ st!.total }}</span> }</button>
                <span class="spacer"></span>
                <button class="btn-secondary sm" (click)="editar(w)"><i class="ph ph-pencil-simple"></i> Editar</button>
              </footer>
            </article>
          }
        </div>
      }
    </div>

    <!-- ═══ Editor lateral ═══ -->
    @if (editor(); as ed) {
      <div class="drawer-backdrop" (click)="cerrarEditor()"></div>
      <aside class="drawer">
        <div class="drawer-head">
          <div>
            <h3><i class="ph ph-share-network"></i> {{ ed.creado ? 'Webhook creado' : ed.id ? 'Editar webhook' : 'Nuevo webhook' }}</h3>
            <div class="sub">{{ ed.creado ? form.titulo : 'Qué hacer con cada payload y dónde avisarte' }}</div>
          </div>
          <button class="btn-icon" title="Cerrar" (click)="cerrarEditor()"><i class="ph ph-x"></i></button>
        </div>

        @if (ed.creado; as c) {
          <div class="drawer-body">
            <div class="listo">
              <i class="ph ph-check-circle"></i>
              <div><b>Listo para recibir payloads</b><small>Copia la URL en tu sistema (SonarQube, GCP, GitHub…) como webhook HTTP POST con JSON.</small></div>
            </div>
            <label class="field"><span>URL</span></label>
            <div class="url grande"><code>{{ url(c) }}</code><button class="btn-secondary sm" (click)="copiar(url(c), 'URL copiada')"><i class="ph ph-copy"></i> Copiar</button></div>
            <div class="field" style="margin-top:14px"><span>Ejemplo</span></div>
            <pre class="code">{{ curl(c) }}</pre>
            <small class="hint">Recomendado: activa un secreto en Editar → Seguridad para que solo tu sistema pueda dispararlo.</small>
          </div>
          <div class="drawer-foot">
            <button class="btn-secondary" (click)="cerrarEditor()">Cerrar</button>
            <span class="spacer"></span>
            <button class="btn-primary" (click)="cerrarEditor(); abrirPrueba(c)"><i class="ph ph-play"></i> Probar ahora</button>
          </div>
        } @else {
          <div class="drawer-body">
            <label class="field"><span>Nombre</span><input type="text" [(ngModel)]="form.titulo" placeholder="ej: Quality gate de SonarQube" /></label>

            <div class="field">
              <span>Instrucciones para la IA <em>qué resaltar, qué ignorar, con qué formato</em></span>
              @defer (on immediate) {
                <app-code-editor lenguaje="markdown" [value]="form.instrucciones" (valueChange)="form.instrucciones = $event" minAlto="160px" maxAlto="360px"
                  placeholder="Resume el análisis: proyecto, rama, estado del quality gate y las condiciones que fallaron. Si falla, di qué revisar primero." />
              } @placeholder { <textarea rows="7" [(ngModel)]="form.instrucciones"></textarea> }
            </div>

            <div class="field">
              <span>Cuando llega un payload</span>
              <div class="modos">
                <button type="button" class="modo" [class.on]="form.modo === 'siempre'" (click)="form.modo = 'siempre'">
                  <i class="ph ph-bell-ringing"></i>
                  <span><b>Avisar siempre</b><small>Cada payload genera un aviso con el resumen.</small></span>
                </button>
                <button type="button" class="modo" [class.on]="form.modo === 'importante'" (click)="form.modo = 'importante'">
                  <i class="ph ph-funnel"></i>
                  <span><b>Solo si importa</b><small>La IA descarta lo rutinario (todo OK, ruido) según tus instrucciones. Queda en los logs.</small></span>
                </button>
              </div>
            </div>

            <div class="field">
              <span>Avisarme en <em>vacío = Telegram</em></span>
              <app-delivery-picker [value]="form.delivery" (valueChange)="form.delivery = $event" />
            </div>

            <div class="field">
              <span>Modelo <em>corre en segundo plano: conviene uno barato o local</em></span>
              <app-model-picker [value]="form.modelo" [permitirDefecto]="false" (valueChange)="form.modelo = $event" />
            </div>

            @if (ed.id) {
              <div class="seccion">
                <div class="sec-h"><i class="ph ph-shield-check"></i> Seguridad</div>
                @if (secretoNuevo(); as sn) {
                  <div class="secreto">
                    <small>Cópialo ahora: <b>no se vuelve a mostrar</b>. Envíalo en la cabecera <code>X-Webhook-Secret</code> (o <code>?token=</code> si tu sistema no permite cabeceras).</small>
                    <div class="url"><code>{{ sn }}</code><button class="btn-primary sm" (click)="copiar(sn, 'Secreto copiado')"><i class="ph ph-copy"></i> Copiar</button></div>
                  </div>
                } @else if (actualDe(ed.id)?.tieneSecreto) {
                  <p class="sec-txt"><i class="ph ph-lock-simple ok"></i> Exige <code>X-Webhook-Secret</code>. Las peticiones sin él reciben 401 y no gastan tokens.</p>
                } @else {
                  <p class="sec-txt"><i class="ph ph-lock-simple-open warn"></i> Cualquiera con la URL puede dispararlo (y gastar tokens). Recomendado activar un secreto.</p>
                }
                <div class="row">
                  <button class="btn-secondary sm" (click)="generarSecreto(ed.id)"><i class="ph ph-key"></i> {{ actualDe(ed.id)?.tieneSecreto ? 'Rotar secreto' : 'Activar secreto' }}</button>
                  @if (actualDe(ed.id)?.tieneSecreto) { <button class="btn-secondary sm" (click)="quitarSecreto(ed.id)">Quitar</button> }
                </div>
              </div>

              <div class="zona-peligro">
                <div><b>Eliminar webhook</b><small>La URL deja de funcionar y se borran sus logs.</small></div>
                <button class="btn-danger sm" (click)="eliminar(ed.id)"><i class="ph ph-trash"></i> Eliminar</button>
              </div>
            }
          </div>
          <div class="drawer-foot">
            <button class="btn-secondary" (click)="cerrarEditor()">Cancelar</button>
            <span class="spacer"></span>
            <button class="btn-primary" [disabled]="!form.titulo.trim() || !form.instrucciones.trim() || !modeloValido() || guardando()" (click)="guardar()">
              @if (guardando()) { <span class="spinner"></span> } {{ ed.id ? 'Guardar cambios' : 'Crear webhook' }}
            </button>
          </div>
        }
      </aside>
    }

    <!-- ═══ Probar ═══ -->
    @if (prueba(); as pr) {
      <div class="modal-backdrop" (click)="cerrarPrueba()">
        <div class="modal ancho" (click)="$event.stopPropagation()">
          <div class="modal-head">
            <h3><i class="ph ph-play"></i> Probar "{{ pr.w.titulo }}"</h3>
            <button class="btn-icon" (click)="cerrarPrueba()"><i class="ph ph-x"></i></button>
          </div>
          <div class="modal-body">
            <div class="plantillas">
              <small class="dim">Payload de ejemplo:</small>
              @for (pl of plantillas; track pl.nombre) { <button class="chip" (click)="usarPlantilla(pl.payload)">{{ pl.nombre }}</button> }
              @if (pr.ultimo) { <button class="chip acc" (click)="payloadTxt = pr.ultimo!" title="El último payload real que recibió"><i class="ph ph-clock-counter-clockwise"></i> Último recibido</button> }
            </div>
            @defer (on immediate) {
              <app-code-editor lenguaje="json" [value]="payloadTxt" (valueChange)="payloadTxt = $event" minAlto="180px" maxAlto="300px" [invalido]="!!errorPayload()" />
            } @placeholder { <textarea rows="8" class="mono" [(ngModel)]="payloadTxt"></textarea> }
            @if (errorPayload(); as e) { <small class="hint bad">{{ e }}</small> }
            <label class="opcion">
              <input type="checkbox" [(ngModel)]="entregarPrueba" />
              <span><b>Enviar también el aviso</b><small>Si no, solo ves lo que respondería. @if (pr.w.paused === 1) { El webhook está pausado, pero la prueba corre igual. }</small></span>
            </label>

            @if (probando()) {
              <div class="res-carga"><span class="spinner"></span> Procesando con {{ modeloCorto(pr.w.modelo) }}…</div>
            } @else if (pr.resultado; as rs) {
              <div class="res" [class.ok]="rs.status === 'success'" [class.sil]="rs.status === 'silenced'" [class.bad]="rs.status === 'error'">
                <div class="res-h">
                  <i class="ph" [class.ph-bell-ringing]="rs.status === 'success'" [class.ph-bell-slash]="rs.status === 'silenced'" [class.ph-x-circle]="rs.status === 'error'"></i>
                  <b>{{ rs.status === 'success' ? (entregado(rs) ? 'Aviso enviado' : 'Avisaría esto') : rs.status === 'silenced' ? 'No avisaría: lo considera no importante' : 'Falló' }}</b>
                  <span class="spacer"></span>
                  @if (rs.ms) { <small class="dim">{{ (rs.ms / 1000).toFixed(1) }} s</small> }
                </div>
                @if (rs.status === 'silenced') { <p class="res-txt">{{ motivoSilencio(rs.response) }}</p> }
                @else if (rs.response) { <div class="md res-txt" [innerHTML]="rs.response | markdown"></div> }
                @else { <p class="res-txt">{{ rs.message }}</p> }
                @if (rs.entrega) { <small class="dim"><i class="ph ph-paper-plane-tilt"></i> {{ rs.entrega }}</small> }
              </div>
            }
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="cerrarPrueba()">Cerrar</button>
            <span class="spacer"></span>
            <button class="btn-primary" (click)="ejecutarPrueba()" [disabled]="probando()"><i class="ph ph-play"></i> {{ pr.resultado ? 'Probar de nuevo' : 'Ejecutar prueba' }}</button>
          </div>
        </div>
      </div>
    }

    <!-- ═══ Logs ═══ -->
    @if (drawer(); as dr) {
      <div class="drawer-backdrop" (click)="cerrarDrawer()"></div>
      <aside class="drawer">
        <div class="drawer-head">
          <div>
            <h3><i class="ph ph-list-magnifying-glass"></i> {{ dr.webhook ? 'Logs' : 'Ejecuciones recientes' }}</h3>
            <div class="sub">{{ dr.webhook?.titulo || 'Todos los webhooks, más reciente primero' }}</div>
          </div>
          <div class="row">
            <button class="btn-icon" title="Actualizar" (click)="recargarDrawer()"><i class="ph ph-arrows-clockwise"></i></button>
            <button class="btn-icon" title="Cerrar" (click)="cerrarDrawer()"><i class="ph ph-x"></i></button>
          </div>
        </div>
        <div class="filtros">
          @for (f of filtros; track f.id) {
            <button class="chip" [class.on]="filtroLog() === f.id" (click)="filtroLog.set(f.id)">{{ f.nombre }} <span class="n">{{ contarLogs(f.id) }}</span></button>
          }
        </div>
        <div class="drawer-body">
          @if (!dr.logs) {
            <div class="empty">Cargando…</div>
          } @else if (!logsFiltrados().length) {
            <div class="empty">{{ dr.logs.length ? 'Nada con este filtro.' : 'Sin ejecuciones todavía. Cuando llegue el primer POST (o una prueba) aparecerá aquí.' }}</div>
          } @else {
            @for (l of logsFiltrados(); track l.id) {
              @let ab = abierto(l.id);
              <div class="log" [class.abierto]="ab">
                <button class="log-h" (click)="toggle(l.id)">
                  <i class="ph est-{{ l.status }}" [class.ph-bell-ringing]="l.status === 'success'" [class.ph-bell-slash]="l.status === 'silenced'" [class.ph-x-circle]="l.status === 'error'" [class.ph-pause-circle]="l.status === 'skipped'"></i>
                  <div class="log-tx">
                    <span class="log-l1">
                      <b>{{ etiquetaEstado(l.status) }}</b>
                      @if (!dr.webhook) { <span class="dim">· {{ l.webhook_titulo || l.webhook_id }}</span> }
                      @if (l.origen === 'prueba') { <span class="tag mini">prueba</span> }
                    </span>
                    <small class="dim">{{ resumenLog(l) }}</small>
                  </div>
                  <span class="log-meta">
                    <small>{{ l.created_at | friendlyDate }}</small>
                    @if (l.ms) { <small class="dim">{{ (l.ms / 1000).toFixed(1) }} s</small> }
                  </span>
                  <i class="ph chev" [class.ph-caret-down]="!ab" [class.ph-caret-up]="ab"></i>
                </button>
                @if (ab) {
                  <div class="log-body">
                    @if (l.entrega) { <div class="log-entrega"><i class="ph ph-paper-plane-tilt"></i> {{ l.entrega }}</div> }
                    <div class="log-sec">
                      <span class="lbl">Respuesta de la IA</span>
                      @if (l.status === 'silenced') { <div class="log-resp dim"><i class="ph ph-bell-slash"></i> {{ resumenLog(l) }}</div> } @else { <div class="md log-resp" [innerHTML]="(l.response || '—') | markdown"></div> }
                    </div>
                    <div class="log-sec">
                      <span class="lbl">Payload <button class="link" (click)="copiar(bonito(l.payload), 'Payload copiado')"><i class="ph ph-copy"></i></button></span>
                      <pre class="code">{{ bonito(l.payload) }}</pre>
                    </div>
                    <div class="log-acc">
                      <button class="btn-secondary sm" (click)="reprobar(l)"><i class="ph ph-play"></i> Probar con este payload</button>
                      <span class="spacer"></span>
                      <button class="btn-icon danger" title="Borrar este log" (click)="borrarLog(l)"><i class="ph ph-trash"></i></button>
                    </div>
                  </div>
                }
              </div>
            }
          }
        </div>
      </aside>
    }
  `,
  styles: [`
    .resumen { display: flex; gap: 4px 18px; align-items: center; flex-wrap: wrap; margin: -8px 0 16px; font-size: 13.5px; color: var(--text-dim); }
    .resumen b { color: var(--text-main); }
    .resumen .sep { opacity: .5; }
    .bad { color: var(--danger); }
    .dim { color: var(--text-dim); }

    .wh-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }
    .wh { display: flex; flex-direction: column; gap: 12px; padding: 16px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; transition: border-color .15s; min-width: 0; }
    .wh:hover { border-color: rgba(129,140,248,.5); }
    .wh.off .wh-top, .wh.off .wh-desc, .wh.off .chips { opacity: .6; }
    .wh-top { display: flex; align-items: center; gap: 12px; }
    .wh-ico { width: 40px; height: 40px; border-radius: 11px; display: grid; place-items: center; background: rgba(249,115,22,.14); color: #fb923c; font-size: 20px; flex-shrink: 0; }
    .wh-tit { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .wh-tit h3 { margin: 0; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wh-tit small { font-size: 12px; }
    .wh-desc { margin: 0; color: var(--text-dim); font-size: 13.5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .tag { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border-light); color: var(--text-dim); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .tag em { font-style: normal; opacity: .75; overflow: hidden; text-overflow: ellipsis; }
    .tag.acc { color: var(--accent-primary); border-color: rgba(129,140,248,.5); }
    .tag.ok { color: var(--ok); border-color: rgba(16,185,129,.4); }
    .tag.warn { color: var(--warn); border-color: rgba(245,158,11,.45); }
    .tag.dimtag { border-style: dashed; }
    .tag.mini { font-size: 10.5px; padding: 0 6px; }
    .actividad { display: flex; gap: 4px 14px; flex-wrap: wrap; align-items: center; font-size: 12.5px; }
    .estado { display: inline-flex; align-items: center; gap: 5px; }
    .estado.ok { color: var(--ok); } .estado.bad { color: var(--danger); } .estado.sil { color: var(--text-dim); }
    .url { display: flex; align-items: center; gap: 4px; padding: 6px 6px 6px 10px; border-radius: 9px; background: var(--bg-input); border: 1px solid var(--border-light); min-width: 0; }
    .url code { flex: 1; min-width: 0; font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .url.grande code { color: var(--text-main); font-size: 13px; white-space: normal; word-break: break-all; }
    .wh-pie { display: flex; gap: 6px; align-items: center; padding-top: 10px; border-top: 1px solid var(--border-light); margin-top: auto; }
    .btn-secondary.sm, .btn-primary.sm, .btn-danger.sm { padding: 6px 11px; font-size: 12.5px; display: inline-flex; align-items: center; gap: 5px; }
    .n { font-size: 11px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--border-light); }

    .switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .switch span { position: absolute; inset: 0; background: var(--border-light); border-radius: 999px; cursor: pointer; transition: .2s; }
    .switch span::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .2s; }
    .switch input:checked + span { background: var(--ok); }
    .switch input:checked + span::before { transform: translateX(16px); }

    .vacio { text-align: center; padding: 44px 20px; }
    .vacio-ico { display: inline-grid; place-items: center; width: 56px; height: 56px; border-radius: 16px; background: rgba(249,115,22,.14); color: #fb923c; font-size: 28px; }
    .vacio p { color: var(--text-dim); max-width: 56ch; margin: 8px auto 16px; }

    .drawer-foot { display: flex; align-items: center; gap: 8px; padding: 12px 24px; border-top: 1px solid var(--border-light); background: var(--bg-card); }
    .field em { font-style: normal; color: var(--text-dim); font-size: 12px; margin-left: 4px; }
    .modos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .modo { display: flex; gap: 10px; align-items: flex-start; text-align: left; padding: 12px; border-radius: 10px; border: 1px solid var(--border-light); background: var(--bg-input); color: var(--text-main); cursor: pointer; }
    .modo > i { font-size: 20px; color: var(--text-dim); margin-top: 1px; }
    .modo > span { display: flex; flex-direction: column; gap: 3px; font-size: 13.5px; }
    .modo small { color: var(--text-dim); font-size: 12px; line-height: 1.4; }
    .modo.on { border-color: var(--accent-primary); background: rgba(129,140,248,.1); }
    .modo.on > i { color: var(--accent-primary); }
    .seccion { margin-top: 6px; padding: 14px; border: 1px solid var(--border-light); border-radius: 12px; display: flex; flex-direction: column; gap: 10px; }
    .sec-h { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); display: flex; gap: 6px; align-items: center; }
    .sec-txt { margin: 0; font-size: 13px; color: var(--text-dim); }
    .sec-txt i.ok { color: var(--ok); } .sec-txt i.warn { color: var(--warn); }
    .secreto { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 10px; border: 1px solid rgba(245,158,11,.45); background: rgba(245,158,11,.07); }
    .secreto small { font-size: 12.5px; }
    .zona-peligro { display: flex; align-items: center; gap: 12px; margin-top: 16px; padding: 12px 14px; border: 1px solid rgba(239,68,68,.35); border-radius: 10px; }
    .zona-peligro > div { flex: 1; display: flex; flex-direction: column; font-size: 13.5px; }
    .zona-peligro small { color: var(--text-dim); font-size: 12px; }
    .listo { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-radius: 12px; background: rgba(16,185,129,.1); border: 1px solid rgba(16,185,129,.4); margin-bottom: 16px; }
    .listo > i { font-size: 24px; color: var(--ok); }
    .listo > div { display: flex; flex-direction: column; font-size: 13.5px; }
    .listo small { color: var(--text-dim); }
    .code { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--bg-input); border: 1px solid var(--border-light); font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 320px; overflow: auto; }
    .hint { display: block; color: var(--text-dim); font-size: 12px; margin-top: 8px; }
    .hint.bad { color: var(--danger); }

    .modal.ancho { width: min(760px, 100%); }
    .plantillas { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .chip.acc { color: var(--accent-primary); border-color: rgba(129,140,248,.5); }
    .opcion { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; padding: 10px 12px; border: 1px solid var(--border-light); border-radius: 10px; margin: 12px 0; }
    .opcion input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--accent-primary); }
    .opcion > span { display: flex; flex-direction: column; font-size: 13.5px; }
    .opcion small { color: var(--text-dim); font-size: 12px; }
    .res-carga { display: flex; gap: 10px; align-items: center; font-size: 13.5px; padding: 12px 0; }
    .res { border-radius: 12px; border: 1px solid var(--border-light); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
    .res.ok { border-color: rgba(16,185,129,.45); } .res.ok .res-h i { color: var(--ok); }
    .res.sil { border-style: dashed; } .res.sil .res-h i { color: var(--text-dim); }
    .res.bad { border-color: rgba(239,68,68,.5); } .res.bad .res-h i { color: var(--danger); }
    .res-h { display: flex; gap: 8px; align-items: center; font-size: 14px; }
    .res-h i { font-size: 19px; }
    .res-txt { font-size: 13.5px; margin: 0; max-height: 280px; overflow: auto; }

    .filtros { display: flex; gap: 6px; flex-wrap: wrap; padding: 12px 24px; border-bottom: 1px solid var(--border-light); background: var(--bg-card); }
    .chip .n { border: none; opacity: .7; }
    .log { border: 1px solid var(--border-light); border-radius: 12px; margin-bottom: 8px; overflow: hidden; background: var(--bg-card); }
    .log.abierto { border-color: rgba(129,140,248,.5); }
    .log-h { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: none; background: none; color: var(--text-main); text-align: left; cursor: pointer; }
    .log-h > i { font-size: 19px; flex-shrink: 0; }
    .est-success { color: var(--ok); } .est-error { color: var(--danger); } .est-silenced, .est-skipped { color: var(--text-dim); }
    .log-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .log-l1 { display: flex; gap: 6px; align-items: center; font-size: 13.5px; min-width: 0; }
    .log-tx small { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .log-meta { display: flex; flex-direction: column; align-items: flex-end; font-size: 12px; white-space: nowrap; }
    .chev { color: var(--text-dim); }
    .log-body { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 10px; }
    .log-entrega { font-size: 12.5px; color: var(--text-dim); }
    .log-sec { display: flex; flex-direction: column; gap: 6px; }
    .lbl { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); display: flex; align-items: center; gap: 6px; }
    .log-resp { font-size: 13.5px; padding: 10px 12px; border-radius: 8px; background: var(--bg-main); border: 1px solid var(--border-light); max-height: 260px; overflow: auto; }
    .log-acc { display: flex; align-items: center; gap: 8px; }
    .link { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 0; }
    .link:hover { color: var(--accent-primary); }
    .btn-icon.danger:hover { color: var(--danger); }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border-light); border-top-color: var(--accent-primary); border-radius: 50%; animation: sp .8s linear infinite; vertical-align: middle; }
    @keyframes sp { to { transform: rotate(360deg); } }

    @media (max-width: 700px) {
      .wh-grid { grid-template-columns: 1fr; }
      .modos { grid-template-columns: 1fr; }
      .drawer-foot, .filtros { padding-left: 14px; padding-right: 14px; }
    }
  `],
})
export class WebhooksComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  readonly plantillas = PLANTILLAS;
  readonly filtros: Array<{ id: FiltroLog; nombre: string }> = [
    { id: 'todos', nombre: 'Todos' }, { id: 'error', nombre: 'Errores' }, { id: 'silenced', nombre: 'Descartados' }, { id: 'prueba', nombre: 'Pruebas' },
  ];

  items = signal<CustomWebhook[]>([]);
  cargado = signal(false);
  resumen = computed(() => {
    const l = this.items();
    return {
      activos: l.filter((w) => w.paused !== 1).length,
      semana: l.reduce((a, w) => a + (w.stats?.semana || 0), 0),
      errores: l.reduce((a, w) => a + (w.stats?.errores || 0), 0),
      silenciados: l.reduce((a, w) => a + (w.stats?.silenciados || 0), 0),
    };
  });

  // Editor
  editor = signal<{ id: string | null; creado?: CustomWebhook } | null>(null);
  form: { titulo: string; instrucciones: string; modelo: string; modo: Modo; delivery: TaskDelivery[] } = this.formVacio();
  guardando = signal(false);
  secretoNuevo = signal<string | null>(null);
  private proveedores = signal<WebhookProvider[]>([]);

  // Prueba
  prueba = signal<{ w: CustomWebhook; resultado: WebhookTestResult | null; ultimo: string | null } | null>(null);
  payloadTxt = '';
  entregarPrueba = false;
  probando = signal(false);
  errorPayload = signal<string | null>(null);

  // Logs
  drawer = signal<{ webhook: CustomWebhook | null; logs: CustomWebhookLog[] | null } | null>(null);
  filtroLog = signal<FiltroLog>('todos');
  private abiertos = signal<Set<number>>(new Set());
  logsFiltrados = computed(() => (this.drawer()?.logs || []).filter((l) => this.pasaFiltro(l, this.filtroLog())));

  constructor() { this.load(); }

  load() {
    this.api.getWebhooks().subscribe({
      next: (r) => { this.items.set(r?.webhooks || []); this.cargado.set(true); },
      error: () => { this.cargado.set(true); this.toast.error('No se pudieron cargar los webhooks'); },
    });
  }

  // ─── Presentación ─────────────────────────────────────────────────────
  url(w: CustomWebhook) { return `${this.api.baseUrl}/api/webhook/${w.id}`; }
  curl(w: CustomWebhook) {
    return `curl -X POST ${this.url(w)} \\\n  -H "Content-Type: application/json" \\\n${w.tieneSecreto ? '  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \\\n' : ''}  -d '{"evento":"prueba","mensaje":"Hola desde curl"}'`;
  }
  destinos(w: CustomWebhook): TaskDelivery[] { return w.delivery?.length ? w.delivery : [{ channel: 'telegram' }]; }
  icono(c: string) { return ICONO_CANAL[c] || 'ph-paper-plane-tilt'; }
  nombreCanal(c: string) { return NOMBRE_CANAL[c] || c; }
  corto(t: string) { return t.length > 22 ? `${t.slice(0, 20)}…` : t; }
  modeloCorto(m: string) { const i = (m || '').indexOf('/'); return i > 0 ? m.slice(i + 1) : m; }
  actualDe(id: string) { return this.items().find((w) => w.id === id); }
  etiquetaEstado(s: string) { return ({ success: 'Avisado', silenced: 'Descartado (no importante)', error: 'Error', skipped: 'Ignorado (pausado)' } as Record<string, string>)[s] || s; }
  primeraLinea(t: string | null | undefined) { return (t || '').replace(/[*#>`_]/g, '').split('\n').map((x) => x.trim()).find(Boolean)?.slice(0, 140) || '—'; }
  /** Una línea para la lista de logs; los descartados muestran el motivo (lo que la IA puso tras SIN_AVISO) o un texto claro. */
  resumenLog(l: CustomWebhookLog) {
    return l.status === 'silenced' ? this.motivoSilencio(l.response) : this.primeraLinea(l.response);
  }
  motivoSilencio(resp: string | null | undefined) {
    const motivo = (resp || '').replace(/^[\s*`>"']*SIN_AVISO[\s*:.\-–—]*/i, '').trim();
    return motivo ? `No avisó: ${this.primeraLinea(motivo)}` : 'La IA lo consideró rutinario, así que no avisó.';
  }
  entregado(r: WebhookTestResult) { return !!r.entrega && !r.entrega.startsWith('prueba'); }

  copiar(v: string, ok: string) { navigator.clipboard.writeText(v).then(() => this.toast.ok(ok), () => this.toast.error('No se pudo copiar')); }

  // ─── Crear / editar ───────────────────────────────────────────────────
  private formVacio() { return { titulo: '', instrucciones: '', modelo: '', modo: 'siempre' as Modo, delivery: [] as TaskDelivery[] }; }

  private cargarProveedores() {
    if (this.proveedores().length) return;
    this.api.getWebhookModels().subscribe({
      next: (r) => {
        this.proveedores.set(r.providers || []);
        // Modelo sugerido para uno nuevo: el más barato del primer proveedor.
        if (!this.form.modelo && r.providers?.length) {
          const p = r.providers[0];
          const m = p.models.find((x) => /flash-lite|mini|nano|haiku/.test(x)) || p.models[0];
          if (m) this.form.modelo = `${p.id}/${m}`;
        }
      },
      error: () => {},
    });
  }

  modeloValido() { const i = this.form.modelo.indexOf('/'); return i > 0 && this.form.modelo.slice(i + 1).trim().length > 0; }

  abrirNuevo() {
    this.form = this.formVacio();
    this.secretoNuevo.set(null);
    this.editor.set({ id: null });
    this.cargarProveedores();
  }

  editar(w: CustomWebhook) {
    this.form = { titulo: w.titulo, instrucciones: w.instrucciones, modelo: this.normalizarModelo(w.modelo), modo: w.modo === 'importante' ? 'importante' : 'siempre', delivery: JSON.parse(JSON.stringify(w.delivery || [])) };
    this.secretoNuevo.set(null);
    this.editor.set({ id: w.id });
    this.cargarProveedores();
  }

  /** Valores antiguos sin proveedor ("gemini-3.5-flash-lite", "llama3 (ollama)") → "<proveedor>/<modelo>". */
  private normalizarModelo(v: string) {
    if ((v || '').indexOf('/') > 0) return v;
    if (/\(ollama\)/i.test(v)) return `ollama/${v.replace(/\s*\(ollama\)\s*/i, '').trim()}`;
    return `gemini/${v}`;
  }

  cerrarEditor() {
    if (this.guardando()) return;
    if (this.secretoNuevo() && !confirm('¿Ya copiaste el secreto? No se vuelve a mostrar.')) return;
    this.editor.set(null);
    this.secretoNuevo.set(null);
  }

  guardar() {
    const ed = this.editor();
    if (!ed) return;
    const datos = { titulo: this.form.titulo.trim(), instrucciones: this.form.instrucciones.trim(), modelo: this.form.modelo.trim(), modo: this.form.modo, delivery: this.form.delivery };
    this.guardando.set(true);
    if (ed.id) {
      this.api.updateWebhook(ed.id, datos).subscribe({
        next: () => { this.guardando.set(false); this.editor.set(null); this.load(); this.toast.ok('Webhook actualizado'); },
        error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); },
      });
    } else {
      this.api.createWebhook(datos).subscribe({
        next: (r) => { this.guardando.set(false); this.load(); this.editor.set({ id: r.data.id, creado: r.data }); },
        error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo crear'); },
      });
    }
  }

  alternar(w: CustomWebhook) {
    const paused = w.paused === 1 ? 0 : 1;
    this.items.update((l) => l.map((x) => (x.id === w.id ? { ...x, paused } : x)));
    this.api.updateWebhook(w.id, { paused }).subscribe({
      next: () => this.toast.ok(paused ? `${w.titulo} pausado` : `${w.titulo} activo`),
      error: () => { this.toast.error('No se pudo cambiar el estado'); this.load(); },
    });
  }

  eliminar(id: string) {
    const w = this.actualDe(id);
    if (!w || !confirm(`¿Eliminar "${w.titulo}"? La URL deja de funcionar y se borran sus logs.`)) return;
    this.api.deleteWebhook(id).subscribe({
      next: () => { this.editor.set(null); this.load(); this.toast.ok('Webhook eliminado'); },
      error: () => this.toast.error('No se pudo eliminar'),
    });
  }

  generarSecreto(id: string) {
    const w = this.actualDe(id);
    if (w?.tieneSecreto && !confirm('El secreto actual deja de servir de inmediato. ¿Rotarlo?')) return;
    this.api.webhookSecret(id).subscribe({
      next: (r) => { this.secretoNuevo.set(r.secreto); this.items.update((l) => l.map((x) => (x.id === id ? { ...x, tieneSecreto: true } : x))); },
      error: () => this.toast.error('No se pudo generar el secreto'),
    });
  }

  quitarSecreto(id: string) {
    if (!confirm('Sin secreto, cualquiera con la URL puede dispararlo. ¿Quitarlo?')) return;
    this.api.webhookSecret(id, true).subscribe({
      next: () => { this.secretoNuevo.set(null); this.items.update((l) => l.map((x) => (x.id === id ? { ...x, tieneSecreto: false } : x))); this.toast.ok('Secreto quitado'); },
      error: () => this.toast.error('No se pudo quitar'),
    });
  }

  // ─── Probar ───────────────────────────────────────────────────────────
  abrirPrueba(w: CustomWebhook, payload?: string) {
    this.payloadTxt = payload || JSON.stringify(PLANTILLAS[0].payload, null, 2);
    this.entregarPrueba = false;
    this.errorPayload.set(null);
    this.prueba.set({ w, resultado: null, ultimo: null });
    // El último payload real sirve para reproducir lo que llegó.
    this.api.getWebhookLogs(w.id, 10).subscribe({
      next: (r) => {
        const ult = (r.logs || []).find((l) => l.origen !== 'prueba' && l.payload);
        if (ult) this.prueba.update((p) => (p ? { ...p, ultimo: this.bonito(ult.payload) } : p));
      },
      error: () => {},
    });
  }

  cerrarPrueba() { if (!this.probando()) this.prueba.set(null); }
  usarPlantilla(p: any) { this.payloadTxt = JSON.stringify(p, null, 2); this.errorPayload.set(null); }

  ejecutarPrueba() {
    const pr = this.prueba();
    if (!pr) return;
    let payload: any;
    try { payload = JSON.parse(this.payloadTxt || '{}'); this.errorPayload.set(null); }
    catch { this.errorPayload.set('El payload no es JSON válido'); return; }
    this.probando.set(true);
    this.api.testWebhook(pr.w.id, payload, this.entregarPrueba).subscribe({
      next: (r) => { this.probando.set(false); this.prueba.update((p) => (p ? { ...p, resultado: r } : p)); this.load(); },
      error: (e) => { this.probando.set(false); this.prueba.update((p) => (p ? { ...p, resultado: { status: 'error', message: e?.error?.error || e?.error?.message || 'No se pudo probar' } } : p)); },
    });
  }

  reprobar(l: CustomWebhookLog) {
    const w = this.actualDe(l.webhook_id);
    if (!w) return;
    this.cerrarDrawer();
    this.abrirPrueba(w, this.bonito(l.payload));
  }

  // ─── Logs ─────────────────────────────────────────────────────────────
  verLogs(w: CustomWebhook) { this.filtroLog.set('todos'); this.drawer.set({ webhook: w, logs: null }); this.recargarDrawer(); }
  verEjecuciones() { this.filtroLog.set('todos'); this.drawer.set({ webhook: null, logs: null }); this.recargarDrawer(); }
  cerrarDrawer() { this.drawer.set(null); this.abiertos.set(new Set()); }

  recargarDrawer() {
    const d = this.drawer();
    if (!d) return;
    const req = d.webhook ? this.api.getWebhookLogs(d.webhook.id, 50) : this.api.getAllWebhookLogs(80);
    req.subscribe({
      next: (r) => this.drawer.update((x) => (x ? { ...x, logs: r.logs || [] } : x)),
      error: () => { this.drawer.update((x) => (x ? { ...x, logs: [] } : x)); this.toast.error('No se pudieron cargar los logs'); },
    });
  }

  private pasaFiltro(l: CustomWebhookLog, f: FiltroLog) {
    return f === 'todos' || (f === 'prueba' ? l.origen === 'prueba' : l.status === f);
  }
  contarLogs(f: FiltroLog) { return (this.drawer()?.logs || []).filter((l) => this.pasaFiltro(l, f)).length; }

  borrarLog(l: CustomWebhookLog) {
    this.api.deleteWebhookLog(l.webhook_id, l.id).subscribe({
      next: () => this.drawer.update((x) => (x?.logs ? { ...x, logs: x.logs.filter((y) => y.id !== l.id) } : x)),
      error: () => this.toast.error('No se pudo borrar el log'),
    });
  }

  toggle(id: number) { this.abiertos.update((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  abierto(id: number) { return this.abiertos().has(id); }

  bonito(raw: string): string {
    if (!raw) return '—';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  }
}
