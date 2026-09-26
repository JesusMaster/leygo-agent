import { ChangeDetectorRef, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService, CanalAgente, CustomAgent, CustomToolDef, EnvVar } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { ModelPickerComponent } from '../model-picker/model-picker';
import { MarkdownPipe } from '../../pipes/markdown.pipe';

const CANALES: Array<{ id: CanalAgente; nombre: string; icono: string; ayuda: string }> = [
  { id: 'telegram', nombre: 'Telegram', icono: 'ph-telegram-logo', ayuda: 'Tu bot privado' },
  { id: 'api', nombre: 'Chat de la GUI', icono: 'ph-browser', ayuda: 'Chat y API con tu clave' },
  { id: 'buzz', nombre: 'Buzz', icono: 'ph-broadcast', ayuda: 'Quien te escriba en la comunidad' },
  { id: 'a2a', nombre: 'A2A', icono: 'ph-plugs-connected', ayuda: 'Otros agentes, según su token' },
];

type Pestana = 'general' | 'soul' | 'tools' | 'env' | 'probar';
type Resultado = { ok: boolean; result?: any; error?: string; logs?: string[]; ms?: number };
type Mensaje = { rol: 'yo' | 'agente'; texto: string; pasos?: string[]; ms?: number };

const EJEMPLOS_IA = [
  'Un agente que me ayude a estudiar para piloto: convierte km a millas náuticas, pies a metros y calcula el top of descent. Se llama Nami y habla como instructora de vuelo.',
  'Un agente que consulte el tipo de cambio USD/CLP del día (mindicador.cl) y convierta montos entre pesos y dólares. Se llama Luka.',
  'Un agente que me ayude a preparar reuniones: resume un texto largo en 5 puntos y propone 3 preguntas para hacer. Se llama Brief.',
];

/**
 * Agentes personalizados: tarjetas para ver de un vistazo qué hace cada uno y
 * un panel lateral para editarlos (general, personalidad, herramientas con
 * prueba del código en edición, variables) y conversar con ellos.
 */
@Component({
  selector: 'app-agents',
  imports: [FormsModule, RouterLink, ModelPickerComponent, MarkdownPipe],
  template: `
    @if (!actual() || !form) {
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Agentes</h2>
          <p class="sub">Especialistas que creas tú. Háblales directo con <code>&#64;nombre</code> en el chat o en Telegram, o deja que el Coordinator los elija. Los agentes del sistema se configuran en <a routerLink="/settings">Ajustes</a>.</p>
        </div>
        <div class="row">
          <button class="btn-secondary" (click)="abrirManual()"><i class="ph ph-plus"></i> A mano</button>
          <button class="btn-primary" (click)="modalIA.set(true)"><i class="ph ph-sparkle"></i> Crear con IA</button>
        </div>
      </div>

      @if (!cargado()) {
        <div class="card"><div class="empty">Cargando…</div></div>
      } @else if (rutaAgente() && !actual()) {
        <div class="card vacio">
          <h3>No existe &#64;{{ rutaAgente() }}</h3>
          <p>Puede que lo hayan eliminado o renombrado.</p>
          <a class="btn-secondary" routerLink="/agents"><i class="ph ph-arrow-left"></i> Volver a Agentes</a>
        </div>
      } @else if (agents().length === 0) {
        <div class="card vacio">
          <span class="vacio-ico"><i class="ph ph-robot"></i></span>
          <h3>Todavía no tienes agentes</h3>
          <p>Descríbelo en lenguaje natural y el agente programador lo construye con sus herramientas, las prueba y lo deja listo.</p>
          <button class="btn-primary" (click)="modalIA.set(true)"><i class="ph ph-sparkle"></i> Crear el primero con IA</button>
        </div>
      } @else {
        <div class="grid-ag">
          @for (a of agents(); track a.name) {
            @let faltan = variablesFaltantes(a);
            <article class="ag" [class.off]="!a.enabled">
              <header class="ag-top">
                <span class="avatar" [style.background]="colorDe(a.name, .18)" [style.color]="colorDe(a.name, 1)">{{ a.displayName.slice(0, 1) }}</span>
                <div class="ag-nombre">
                  <h3>{{ a.displayName }}</h3>
                  <button class="mencion" (click)="copiar('@' + a.name + ' ')" title="Copiar mención">&#64;{{ a.name }} <i class="ph ph-copy"></i></button>
                </div>
                <label class="switch" [title]="a.enabled ? 'Activo: clic para pausar' : 'Pausado: clic para activar'">
                  <input type="checkbox" [checked]="a.enabled" (change)="alternar(a)" /><span></span>
                </label>
              </header>

              <p class="desc" [title]="a.description">{{ a.description }}</p>

              <div class="meta">
                @for (c of a.channels; track c) { <span class="tag" [title]="nombreCanal(c)"><i class="ph {{ iconoCanal(c) }}"></i> {{ nombreCanal(c) }}</span> }
                @if (!a.channels.length) { <span class="tag warn"><i class="ph ph-warning"></i> sin canales</span> }
              </div>
              <div class="meta">
                <span class="tag"><i class="ph ph-cpu"></i> {{ etiquetaModelo(a.model) }}</span>
                <span class="tag"><i class="ph ph-wrench"></i> {{ a.tools.length }} herramienta{{ a.tools.length === 1 ? '' : 's' }}@if (usaRed(a)) { · red }</span>
                @if (a.memory) { <span class="tag"><i class="ph ph-brain"></i> memoria</span> }
                @if (faltan.length) { <span class="tag warn" [title]="'Sin valor: ' + faltan.join(', ')"><i class="ph ph-key"></i> falta {{ faltan.length === 1 ? faltan[0] : faltan.length + ' variables' }}</span> }
              </div>

              <footer class="ag-pie">
                <small class="dim">
                  @if (uso()[a.name]; as u) { {{ u.turnos }} uso{{ u.turnos === 1 ? '' : 's' }} · {{ '$' + u.costo.toFixed(2) }} este mes · }
                  v{{ a.version }} · {{ hace(a.updatedAt) }}
                </small>
                <span class="spacer"></span>
                <button class="btn-secondary sm" (click)="abrir(a, 'probar')" [disabled]="!a.enabled" [title]="a.enabled ? '' : 'Actívalo para probarlo'"><i class="ph ph-chat-circle-dots"></i> Probar</button>
                <button class="btn-secondary sm" (click)="abrir(a, 'general')"><i class="ph ph-pencil-simple"></i> Editar</button>
              </footer>
            </article>
          }
        </div>
      }
    </div>
    }

    <!-- ═══ Detalle (ruta /agents/:name): edición y prueba ═══ -->
    @if (actual(); as a) {
      @if (form; as f) {
        <section class="detalle">
          <div class="det-head">
            <a class="volver" routerLink="/agents" title="Volver a Agentes"><i class="ph ph-arrow-left"></i></a>
            <div class="dh">
              <span class="avatar" [style.background]="colorDe(a.name, .18)" [style.color]="colorDe(a.name, 1)">{{ (f.displayName || a.name).slice(0, 1) }}</span>
              <div>
                <h3>{{ f.displayName || a.name }}</h3>
                <div class="sub">&#64;{{ a.name }} · v{{ a.version }} · {{ a.createdBy === 'ia' ? 'creado por IA' : 'creado a mano' }}</div>
              </div>
            </div>
            <span class="spacer"></span>
            <label class="switch" [title]="a.enabled ? 'Activo: clic para pausar' : 'Pausado: clic para activar'">
              <input type="checkbox" [checked]="a.enabled" (change)="alternar(a)" /><span></span>
            </label>
          </div>

          <nav class="ptabs">
            <button [class.on]="pestana() === 'general'" (click)="irPestana('general')">General</button>
            <button [class.on]="pestana() === 'soul'" (click)="irPestana('soul')">Personalidad</button>
            <button [class.on]="pestana() === 'tools'" (click)="irPestana('tools')">Herramientas <span class="n">{{ f.tools.length }}</span></button>
            <button [class.on]="pestana() === 'env'" (click)="irPestana('env')">Variables <span class="n" [class.warn]="variablesFaltantes(a).length">{{ f.env.length }}</span></button>
            <button [class.on]="pestana() === 'probar'" (click)="irPestana('probar')"><i class="ph ph-chat-circle-dots"></i> Probar</button>
          </nav>

          <div class="det-body" [class.ancho]="pestana() === 'tools' || pestana() === 'soul'">
            @switch (pestana()) {
              @case ('general') {
                <div class="gen-grid">
                <div class="gen-main">
                <label class="field"><span>Nombre visible</span><input type="text" [(ngModel)]="f.displayName" /></label>
                <label class="field">
                  <span>Cuándo usarlo</span>
                  <textarea rows="3" [(ngModel)]="f.description"></textarea>
                  <small class="hint">El Coordinator lee esto para decidir cuándo delegarle. Sé concreto: qué resuelve y con qué datos.</small>
                </label>
                <div class="field bloque">
                  <span>Canales donde está disponible</span>
                  <div class="canales">
                    @for (c of canales; track c.id) {
                      <button type="button" class="canal" [class.on]="f.channels.includes(c.id)" (click)="toggleCanal(c.id)">
                        <i class="ph {{ c.icono }}"></i>
                        <span><b>{{ c.nombre }}</b><small>{{ c.ayuda }}</small></span>
                        <i class="ph chk" [class.ph-check-circle]="f.channels.includes(c.id)" [class.ph-circle]="!f.channels.includes(c.id)"></i>
                      </button>
                    }
                  </div>
                  @if (f.channels.includes('buzz') || f.channels.includes('a2a')) {
                    <small class="hint warn"><i class="ph ph-warning"></i> En Buzz y A2A le hablan terceros: revisa que sus herramientas no expongan datos privados.</small>
                  }
                </div>
                <div class="field">
                  <span>Modelo</span>
                  <app-model-picker [value]="f.model || ''" (valueChange)="f.model = $event || null" etiquetaDefecto="Por defecto (el del Coordinator)" />
                </div>
                </div>
                <aside class="gen-side">
                  <div class="resumen">
                    <h4>Resumen</h4>
                    <dl>
                      <dt>Mención</dt><dd><code>&#64;{{ a.name }}</code></dd>
                      <dt>Herramientas</dt><dd>{{ a.tools.length }}@if (usaRed(a)) { · usa red }</dd>
                      <dt>Variables</dt><dd>{{ a.env.length }}@if (variablesFaltantes(a).length) { <span class="warn-t"> · {{ variablesFaltantes(a).length }} sin valor</span> }</dd>
                      <dt>Este mes</dt><dd>@if (uso()[a.name]; as u) { {{ u.turnos }} usos · {{ '$' + u.costo.toFixed(2) }} } @else { sin uso }</dd>
                      <dt>Versión</dt><dd>v{{ a.version }} · {{ hace(a.updatedAt) }}</dd>
                      <dt>Creado</dt><dd>{{ fecha(a.createdAt) }} · {{ a.createdBy === 'ia' ? 'por IA' : 'a mano' }}</dd>
                    </dl>
                  </div>
                  <label class="opcion">
                    <input type="checkbox" [(ngModel)]="f.memory" />
                    <span><b>Memoria propia</b><small>Recuerda entre conversaciones (se guarda en Qdrant, colección propia del agente).</small></span>
                  </label>
                  <div class="zona-peligro">
                    <div><b>Eliminar agente</b><small>Borra su definición, herramientas y memoria. No se puede deshacer.</small></div>
                    <button class="btn-danger sm" (click)="eliminar(a)"><i class="ph ph-trash"></i> Eliminar</button>
                  </div>
                </aside>
                </div>
              }

              @case ('soul') {
                <div class="field">
                  <span class="soul-h">Personalidad e instrucciones <small class="dim">{{ f.soul.length }} caracteres</small></span>
                  <textarea class="soul" [(ngModel)]="f.soul" spellcheck="true"></textarea>
                  <small class="hint">Quién es, cómo habla, qué hace y qué no. Se suma a las reglas generales de Yisus (fecha, tono, límites).</small>
                </div>
              }

              @case ('tools') {
                <div class="tools">
                  <div class="tlist">
                    @for (t of f.tools; track $index; let i = $index) {
                      <button class="titem" [class.on]="toolSel() === i" (click)="elegirTool(i)">
                        <code>{{ t.name || '(sin nombre)' }}</code>
                        <small>
                          @if (t.network) { <i class="ph ph-globe" title="Usa red"></i> }
                          {{ (t.tests || []).length }} test{{ (t.tests || []).length === 1 ? '' : 's' }}
                          @if (estadoTests()[i]; as e) { <span [class.ok]="e.ok === e.total" [class.bad]="e.ok < e.total">· {{ e.ok }}/{{ e.total }} ✓</span> }
                        </small>
                      </button>
                    }
                    <button class="titem nueva" (click)="agregarTool()"><i class="ph ph-plus"></i> Nueva herramienta</button>
                  </div>

                  @if (f.tools[toolSel()]; as t) {
                    <div class="teditor">
                      <div class="grid2">
                        <label class="field"><span>Nombre <em>snake_case</em></span><input type="text" class="mono" [(ngModel)]="t.name" /></label>
                        <label class="opcion inline"><input type="checkbox" [(ngModel)]="t.network" /><span><b>Usa red</b><small><code>ctx.fetch</code>, solo https</small></span></label>
                      </div>
                      <label class="field"><span>Descripción <em>el modelo la lee para decidir cuándo usarla</em></span><input type="text" [(ngModel)]="t.description" /></label>
                      <label class="field">
                        <span>Parámetros <em>JSON Schema</em>@if (errorParams(); as e) { <em class="bad"> · {{ e }}</em> }</span>
                        <textarea rows="8" class="mono" [class.invalido]="errorParams()" [ngModel]="paramsTxt()" (ngModelChange)="editarParams($event)"></textarea>
                      </label>
                      <label class="field">
                        <span>Código <em>cuerpo de async (args, ctx) =&gt; {{ '{' }} … {{ '}' }} · en sandbox</em></span>
                        <textarea rows="22" class="mono code" [(ngModel)]="t.code" (keydown.tab)="tab($event, t)" spellcheck="false"></textarea>
                      </label>

                      <div class="prueba-box">
                        <div class="pb-row">
                          <input type="text" class="mono" [(ngModel)]="argsPrueba" placeholder='args de prueba, ej: {"km": 100}' (keydown.enter)="ejecutarTool(a, t)" />
                          <button class="btn-primary sm" (click)="ejecutarTool(a, t)" [disabled]="ejecutando()"><i class="ph" [class.ph-play]="!ejecutando()" [class.ph-spinner]="ejecutando()"></i> Ejecutar</button>
                          @if ((t.tests || []).length) {
                            <button class="btn-secondary sm" (click)="correrTests(a, t)" [disabled]="ejecutando()"><i class="ph ph-checks"></i> Tests ({{ t.tests!.length }})</button>
                          }
                        </div>
                        <small class="hint">Ejecuta el código de este editor, sin guardar.</small>
                        @if (salida(); as r) {
                          <pre class="out" [class.bad]="!r.ok">{{ r.ok ? json(r.result) : r.error }}@if (r.logs?.length) {{{ '\n\n' }}logs: {{ r.logs!.join(' | ') }}}</pre>
                          @if (r.ms !== undefined) { <small class="dim">{{ r.ms }} ms</small> }
                        }
                        @if (resultadosTests().length) {
                          <ul class="tests">
                            @for (x of resultadosTests(); track $index) {
                              <li [class.ok]="x.ok" [class.bad]="!x.ok">
                                <i class="ph" [class.ph-check-circle]="x.ok" [class.ph-x-circle]="!x.ok"></i>
                                <code>{{ json1(x.args) }}</code>
                                @if (!x.ok) { <span>{{ x.detalle }}</span> }
                              </li>
                            }
                          </ul>
                        }
                      </div>

                      <button class="btn-borrar" (click)="quitarTool(toolSel())"><i class="ph ph-trash"></i> Quitar herramienta</button>
                    </div>
                  } @else {
                    <div class="teditor empty">Sin herramientas: el agente solo conversa. Agrega una o pídele al programador que la cree.</div>
                  }
                </div>
              }

              @case ('env') {
                <p class="intro">Claves y datos que usan sus herramientas (<code>ctx.env.NOMBRE</code>). Se guardan en el .env como <code>AGENT_{{ a.name.toUpperCase() }}_NOMBRE</code>; si falta, se usa la variable global del mismo nombre.</p>
                <div class="env-tabla">
                  @if (f.env.length) {
                    <div class="env-cab"><span>Nombre</span><span>Para qué es</span><span>Valor</span><span>Estado</span><span></span></div>
                  }
                  @for (e of f.env; track $index; let i = $index) {
                    @let actualVal = envActual[a.name + ':' + e.name];
                    <div class="env-fila">
                      <input type="text" class="mono nombre" [(ngModel)]="e.name" placeholder="NOMBRE" />
                      <input type="text" [(ngModel)]="e.description" placeholder="Para qué es" [title]="e.description" />
                      <div class="valor">
                        <input [type]="e.secret ? 'password' : 'text'" autocomplete="new-password" [(ngModel)]="envValores[e.name]"
                          [placeholder]="actualVal ? actualVal + ' · escribe para reemplazar' : envGlobal[e.name] ? 'usa la global · escribe para una propia' : 'valor'" />
                        <label class="mini" title="Se muestra enmascarado"><input type="checkbox" [(ngModel)]="e.secret" /> secreto</label>
                      </div>
                      <div>
                        @if (actualVal) { <span class="tag ok"><i class="ph ph-check"></i> propia</span> }
                        @else if (envGlobal[e.name]) { <span class="tag ok" [title]="'Sin valor propio: usa ' + e.name + ' del .env'"><i class="ph ph-check"></i> global</span> }
                        @else { <span class="tag warn">sin valor</span> }
                      </div>
                      <button class="btn-icon danger" title="Quitar" (click)="f.env.splice(i, 1)"><i class="ph ph-trash"></i></button>
                    </div>
                  } @empty {
                    <div class="env-vacio">Sin variables. Agrégalas si una herramienta necesita una API key o un dato de configuración.</div>
                  }
                </div>
                <button class="agregar" (click)="f.env.push({ name: '', description: '', secret: true })"><i class="ph ph-plus"></i> Agregar variable</button>
              }

              @case ('probar') {
                <div class="chat">
                  @if (sucio()) { <div class="aviso"><i class="ph ph-info"></i> Tienes cambios sin guardar: la prueba usa la versión guardada.</div> }
                  @if (!mensajes().length) {
                    <div class="chat-vacio">
                      <p>Conversación directa con {{ a.displayName }}, sin pasar por el Coordinator. Cada mensaje es un turno aislado.</p>
                      <div class="sugerencias">
                        @for (s of sugerencias(a); track s) { <button class="chip" (click)="textoPrueba = s; enviarPrueba(a)">{{ s }}</button> }
                      </div>
                    </div>
                  }
                  @for (m of mensajes(); track $index) {
                    <div class="msg" [class.yo]="m.rol === 'yo'">
                      @if (m.rol === 'yo') { <div class="burbuja">{{ m.texto }}</div> }
                      @else {
                        <div class="burbuja md" [innerHTML]="m.texto | markdown"></div>
                        @if (m.pasos?.length || m.ms) {
                          <details class="pasos">
                            <summary>
                              @for (h of herramientasUsadas(m.pasos); track $index) { <span class="paso"><i class="ph ph-wrench"></i> {{ h }}</span> }
                              @if (m.pasos?.length) { <span class="dim">{{ m.pasos!.length }} paso{{ m.pasos!.length === 1 ? '' : 's' }}</span> }
                              @if (m.ms) { <span class="dim">· {{ (m.ms / 1000).toFixed(1) }} s</span> }
                            </summary>
                            <pre class="out">{{ (m.pasos || []).join('\n') }}</pre>
                          </details>
                        }
                      }
                    </div>
                  }
                  @if (probando()) { <div class="msg"><div class="burbuja escribiendo"><span></span><span></span><span></span></div></div> }
                </div>
              }
            }
          </div>

          <div class="det-foot">
            @if (pestana() === 'probar') {
              <input type="text" [(ngModel)]="textoPrueba" [placeholder]="'Escríbele a ' + a.displayName + '…'" (keydown.enter)="enviarPrueba(a)" [disabled]="probando() || !a.enabled" />
              <button class="btn-icon" title="Nueva conversación" (click)="mensajes.set([])" [disabled]="!mensajes().length"><i class="ph ph-arrow-counter-clockwise"></i></button>
              <button class="btn-primary" (click)="enviarPrueba(a)" [disabled]="!textoPrueba.trim() || probando() || !a.enabled"><i class="ph ph-paper-plane-tilt"></i></button>
            } @else {
              @if (sucio()) { <span class="dirty"><i class="ph ph-circle-fill"></i> Cambios sin guardar</span> } @else { <span class="dim">Sin cambios</span> }
              <span class="spacer"></span>
              @if (sucio()) { <button class="btn-secondary" (click)="descartar(a)">Descartar</button> }
              <button class="btn-primary" [disabled]="!sucio() || guardando()" (click)="guardar(a)">
                @if (guardando()) { <span class="spinner"></span> Probando y guardando… } @else { <i class="ph ph-floppy-disk"></i> Guardar }
              </button>
            }
          </div>
        </section>
      }
    }

    <!-- ═══ Crear a mano ═══ -->
    @if (modalManual()) {
      <div class="modal-backdrop" (click)="modalManual.set(false)">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head"><h3>Nuevo agente</h3><button class="btn-icon" (click)="modalManual.set(false)"><i class="ph ph-x"></i></button></div>
          <div class="modal-body">
            <label class="field"><span>Nombre</span><input type="text" [(ngModel)]="nuevo.displayName" (ngModelChange)="sugerirSlug()" placeholder="Nami" /></label>
            <label class="field">
              <span>Mención <em>minúsculas, sin espacios</em></span>
              <div class="slug"><span>&#64;</span><input type="text" class="mono" [(ngModel)]="nuevo.name" (ngModelChange)="slugTocado = true" placeholder="nami" /></div>
              @if (nuevo.name && !slugValido()) { <small class="hint bad">Usa 2–30 letras minúsculas, números o _ (empieza con letra).</small> }
              @else if (slugOcupado()) { <small class="hint bad">Ya existe un agente con esa mención.</small> }
            </label>
            <label class="field"><span>Cuándo usarlo</span><textarea rows="3" [(ngModel)]="nuevo.description" placeholder="Conversiones aeronáuticas y cálculos de descenso para estudiar vuelo."></textarea></label>
            <small class="hint">Después le agregas personalidad y herramientas en el panel de edición.</small>
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="modalManual.set(false)">Cancelar</button>
            <button class="btn-primary" [disabled]="!slugValido() || slugOcupado() || !nuevo.displayName.trim() || creando()" (click)="crearManual()">Crear y editar</button>
          </div>
        </div>
      </div>
    }

    <!-- ═══ Crear con IA ═══ -->
    @if (modalIA()) {
      <div class="modal-backdrop" (click)="cerrarIA()">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head"><h3><i class="ph ph-sparkle"></i> Crear agente con IA</h3><button class="btn-icon" (click)="cerrarIA()"><i class="ph ph-x"></i></button></div>
          <div class="modal-body">
            @if (!generando() && !resultadoIA()) {
              <label class="field">
                <span>Describe el agente: cómo se llama, su personalidad y qué debe saber hacer</span>
                <textarea rows="6" [(ngModel)]="promptIA" placeholder="Se llama…, habla como…, sabe…"></textarea>
              </label>
              <div class="ejemplos">
                <small class="dim">Ideas:</small>
                @for (e of ejemplos; track e) { <button class="ej" (click)="promptIA = e">{{ e.slice(0, 70) }}…</button> }
              </div>
              <small class="hint">El programador escribe las herramientas, las prueba en el sandbox y lo deja montado. Toma uno o dos minutos.</small>
            } @else {
              <div class="pedido"><i class="ph ph-quotes"></i> {{ promptIA }}</div>
            }
            @if (estadosIA().length) {
              <ol class="timeline">
                @for (e of estadosIA(); track $index; let ultimo = $last) {
                  <li [class]="'tl-' + e.nivel" [class.activo]="ultimo && generando()">
                    <span class="tl-ico">
                      @if (ultimo && generando()) { <span class="spinner"></span> }
                      @else if (e.nivel === 'ok') { <i class="ph ph-check-circle"></i> }
                      @else if (e.nivel === 'error') { <i class="ph ph-warning-circle"></i> }
                      @else { <i class="ph ph-circle"></i> }
                    </span>
                    <span class="tl-txt">{{ e.texto }}</span>
                    <span class="tl-t dim">{{ e.t }}</span>
                  </li>
                }
              </ol>
            }
            @if (resultadoIA(); as r) {
              <div class="md-out md" [innerHTML]="r.respuesta | markdown"></div>
              @if (r.pasos.length) { <details style="margin-top:10px"><summary class="dim">Pasos ({{ r.pasos.length }})</summary><pre class="out">{{ r.pasos.join('\n') }}</pre></details> }
            }
          </div>
          <div class="modal-foot">
            @if (resultadoIA(); as r) {
              <button class="btn-secondary" (click)="nuevaGeneracion()"><i class="ph ph-arrow-counter-clockwise"></i> Crear otro</button>
              @if (r.nuevos.length) {
                <button class="btn-secondary" (click)="irAlAgente(r.nuevos[0], 'general')"><i class="ph ph-pencil-simple"></i> Revisar</button>
                <button class="btn-primary" (click)="irAlAgente(r.nuevos[0], 'probar')"><i class="ph ph-chat-circle-dots"></i> Probar a {{ nombreVisible(r.nuevos[0]) }}</button>
              } @else {
                <button class="btn-primary" (click)="cerrarIA()">Cerrar</button>
              }
            } @else {
              <button class="btn-secondary" (click)="cerrarIA()">{{ generando() ? 'Seguir en segundo plano' : 'Cancelar' }}</button>
              <button class="btn-primary" [disabled]="!promptIA.trim() || generando()" (click)="generar()">
                @if (generando()) { <span class="spinner"></span> Creando… } @else { <i class="ph ph-sparkle"></i> Crear }
              </button>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .grid-ag { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
    .ag { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 10px; transition: border-color .15s; }
    .ag:hover { border-color: rgba(129,140,248,.5); }
    .ag.off { opacity: .6; }
    .ag-top { display: flex; align-items: center; gap: 12px; }
    .avatar { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; font-weight: 700; font-size: 18px; flex-shrink: 0; text-transform: uppercase; }
    .ag-nombre { flex: 1; min-width: 0; }
    .ag-nombre h3 { margin: 0; font-size: 16.5px; }
    .mencion { background: none; border: none; padding: 0; color: var(--text-dim); font-family: ui-monospace, monospace; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
    .mencion i { opacity: 0; transition: opacity .15s; }
    .mencion:hover { color: var(--accent-primary); } .mencion:hover i { opacity: 1; }
    .desc { margin: 0; color: var(--text-dim); font-size: 13.5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .tag { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border-light); color: var(--text-dim); white-space: nowrap; }
    .tag i { font-size: 13px; }
    .tag.warn { color: var(--warn); border-color: rgba(245,158,11,.45); }
    .tag.ok { color: var(--ok); border-color: rgba(16,185,129,.4); }
    .ag-pie { display: flex; align-items: center; gap: 6px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border-light); flex-wrap: wrap; }
    .dim { color: var(--text-dim); font-size: 12px; }
    .btn-secondary.sm, .btn-primary.sm, .btn-danger.sm { padding: 6px 11px; font-size: 12.5px; display: inline-flex; align-items: center; gap: 5px; }

    .switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .switch span { position: absolute; inset: 0; background: var(--border-light); border-radius: 999px; cursor: pointer; transition: .2s; }
    .switch span::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .2s; }
    .switch input:checked + span { background: var(--ok); }
    .switch input:checked + span::before { transform: translateX(16px); }

    .vacio { text-align: center; padding: 44px 20px; }
    .vacio-ico { display: inline-grid; place-items: center; width: 56px; height: 56px; border-radius: 16px; background: rgba(129,140,248,.14); color: var(--accent-primary); font-size: 28px; }
    .vacio p { color: var(--text-dim); max-width: 52ch; margin: 8px auto 16px; }

    /* Detalle */
    /* Igual que .page: ocupa el alto de la vista y scrollea por dentro (tabs y pie quedan fijos). */
    .detalle { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-y: auto; }
    .det-head, .ptabs, .det-foot { flex-shrink: 0; }
    .det-head { display: flex; align-items: center; gap: 12px; padding: 20px 28px 14px; }
    .det-head h3 { margin: 0; font-size: 20px; }
    .det-head .sub { color: var(--text-dim); font-size: 13px; margin-top: 2px; }
    .volver { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; border: 1px solid var(--border-light); color: var(--text-main); font-size: 17px; text-decoration: none; flex-shrink: 0; }
    .volver:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
    .det-body { flex: 1 0 auto; padding: 20px 28px 28px; width: 100%; min-width: 0; }
    .gen-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(280px, 1fr); gap: 28px; align-items: start; }
    .gen-side { display: flex; flex-direction: column; gap: 14px; position: sticky; top: 64px; }
    .gen-side .opcion, .gen-side .zona-peligro { margin: 0; }
    .resumen { padding: 14px 16px; border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-card); }
    .resumen h4 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); }
    .resumen dl { display: grid; grid-template-columns: auto 1fr; gap: 7px 14px; margin: 0; font-size: 13px; }
    .resumen dt { color: var(--text-dim); }
    .resumen dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .warn-t { color: var(--warn); }
    .intro { margin: 0 0 14px; color: var(--text-dim); font-size: 13.5px; }
    .env-tabla { border: 1px solid var(--border-light); border-radius: 12px; overflow: hidden; margin-bottom: 12px; }
    .env-cab, .env-fila { display: grid; grid-template-columns: minmax(180px, 240px) minmax(0, 1fr) minmax(0, 1.3fr) 110px 36px; gap: 10px; align-items: center; padding: 10px 14px; }
    .env-cab { background: var(--bg-card); font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); }
    .env-fila { border-top: 1px solid var(--border-light); }
    .env-fila .nombre { text-transform: uppercase; }
    .env-fila .valor { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .env-fila .valor input[type=password], .env-fila .valor input[type=text] { flex: 1; min-width: 0; }
    .env-vacio { padding: 18px; color: var(--text-dim); font-size: 13.5px; }
    .det-foot { position: sticky; bottom: 0; z-index: 5; display: flex; align-items: center; gap: 8px; padding: 12px 28px; border-top: 1px solid var(--border-light); background: var(--bg-card); }
    .det-foot input { flex: 1; }
    .dh { display: flex; align-items: center; gap: 12px; }
    .ptabs { display: flex; gap: 2px; padding: 0 24px; border-bottom: 1px solid var(--border-light); overflow-x: auto; scrollbar-width: none; position: sticky; top: 0; z-index: 6; background: var(--bg-main); }
    .ptabs::-webkit-scrollbar { display: none; }
    .ptabs button { display: inline-flex; align-items: center; gap: 6px; padding: 10px 10px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--text-dim); font-size: 13.5px; cursor: pointer; white-space: nowrap; margin-bottom: -1px; }
    .ptabs button:hover { color: var(--text-main); }
    .ptabs button.on { color: var(--accent-primary); border-bottom-color: var(--accent-primary); }
    .n { font-size: 11px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--border-light); }
    .n.warn { color: var(--warn); border-color: rgba(245,158,11,.45); }
    .dirty { color: var(--accent-primary); font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
    .dirty i { font-size: 8px; }

    .field em { font-style: normal; color: var(--text-dim); font-weight: 400; font-size: 12px; margin-left: 4px; }
    .field em.bad, .hint.bad { color: var(--danger); }
    .hint { display: block; color: var(--text-dim); font-size: 12px; margin-top: 6px; }
    .hint.warn { color: var(--warn); }
    .field.bloque { margin-bottom: 18px; }
    .canales { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .canal { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border-light); background: var(--bg-input); color: var(--text-main); cursor: pointer; text-align: left; }
    .canal > i:first-child { font-size: 19px; color: var(--text-dim); }
    .canal > span { flex: 1; display: flex; flex-direction: column; min-width: 0; font-size: 13px; }
    .canal small { color: var(--text-dim); font-size: 11.5px; }
    .canal .chk { color: var(--text-dim); font-size: 18px; }
    .canal.on { border-color: var(--accent-primary); background: rgba(129,140,248,.1); }
    .canal.on > i { color: var(--accent-primary); }
    .opcion { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; padding: 12px; border: 1px solid var(--border-light); border-radius: 10px; margin: 14px 0; }
    .opcion input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--accent-primary); }
    .opcion > span { display: flex; flex-direction: column; font-size: 13.5px; }
    .opcion small { color: var(--text-dim); font-size: 12px; }
    .opcion.inline { margin: 22px 0 0; padding: 8px 10px; }
    .zona-peligro { display: flex; align-items: center; gap: 12px; margin-top: 24px; padding: 12px 14px; border: 1px solid rgba(239,68,68,.35); border-radius: 10px; }
    .zona-peligro > div { flex: 1; display: flex; flex-direction: column; font-size: 13.5px; }
    .zona-peligro small { color: var(--text-dim); font-size: 12px; }

    .soul-h { display: flex; justify-content: space-between; }
    .soul { min-height: calc(100vh - 360px); font-size: 14px; line-height: 1.55; resize: vertical; }

    .tools { display: grid; grid-template-columns: 260px 1fr; gap: 20px; align-items: start; }
    .tlist { display: flex; flex-direction: column; gap: 4px; position: sticky; top: 56px; }
    .titem { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; border: 1px solid transparent; background: none; color: var(--text-main); text-align: left; cursor: pointer; }
    .titem code { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .titem small { color: var(--text-dim); font-size: 11.5px; display: flex; gap: 4px; align-items: center; }
    .titem small .ok { color: var(--ok); } .titem small .bad { color: var(--danger); }
    .titem:hover { background: var(--bg-card); }
    .titem.on { border-color: var(--accent-primary); background: rgba(129,140,248,.1); }
    .titem.nueva { flex-direction: row; align-items: center; gap: 6px; color: var(--text-dim); border: 1px dashed var(--border-light); margin-top: 4px; font-size: 13px; }
    .teditor { min-width: 0; }
    .teditor .grid2 > * { min-width: 0; }
    .teditor.empty { color: var(--text-dim); font-size: 13.5px; padding: 20px; border: 1px dashed var(--border-light); border-radius: 10px; }
    .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
    .code { line-height: 1.5; tab-size: 2; white-space: pre; }
    textarea.invalido { border-color: var(--danger); }
    .prueba-box { padding: 12px; border-radius: 10px; background: var(--bg-card); border: 1px solid var(--border-light); }
    .pb-row { display: flex; gap: 8px; }
    .pb-row input { flex: 1; min-width: 0; }
    .out { margin: 10px 0 4px; padding: 10px 12px; border-radius: 8px; background: var(--bg-main); border: 1px solid var(--border-light); font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
    .out.bad { border-color: rgba(239,68,68,.5); color: var(--danger); }
    .tests { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
    .tests li { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .tests li.ok i { color: var(--ok); } .tests li.bad { color: var(--danger); }
    .tests code { color: var(--text-main); font-size: 12px; }
    .btn-borrar { margin-top: 14px; background: none; border: none; color: var(--danger); font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; padding: 4px 0; }

    .mini { display: inline-flex; gap: 5px; align-items: center; font-size: 12.5px; color: var(--text-dim); cursor: pointer; }
    .agregar { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 10px; border: 1px dashed var(--border-light); background: none; color: var(--text-dim); font-size: 13px; cursor: pointer; }
    .agregar:hover { color: var(--accent-primary); border-color: var(--accent-primary); }
    .btn-icon.danger:hover { color: var(--danger); }

    .chat { display: flex; flex-direction: column; gap: 10px; }
    .chat-vacio p { color: var(--text-dim); font-size: 13.5px; margin: 0 0 12px; }
    .sugerencias { display: flex; flex-wrap: wrap; gap: 6px; }
    .sugerencias .chip { white-space: normal; text-align: left; }
    .aviso { padding: 9px 12px; border-radius: 10px; font-size: 13px; background: rgba(129,140,248,.08); border: 1px solid rgba(129,140,248,.35); }
    .msg { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
    .msg.yo { align-items: flex-end; }
    .burbuja { max-width: min(760px, 80%); padding: 10px 14px; border-radius: 14px; background: var(--bg-card); border: 1px solid var(--border-light); font-size: 14px; }
    .msg.yo .burbuja { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; white-space: pre-wrap; }
    .pasos { max-width: min(760px, 80%); }
    .pasos summary { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; cursor: pointer; list-style: none; }
    .pasos summary::-webkit-details-marker { display: none; }
    .pasos .out { max-height: 260px; }
    .paso { font-size: 11.5px; font-family: ui-monospace, monospace; color: var(--text-dim); padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border-light); }
    .escribiendo { display: inline-flex; gap: 4px; }
    .escribiendo span { width: 6px; height: 6px; border-radius: 50%; background: var(--text-dim); animation: b 1s infinite; }
    .escribiendo span:nth-child(2) { animation-delay: .15s; } .escribiendo span:nth-child(3) { animation-delay: .3s; }
    @keyframes b { 0%, 60%, 100% { opacity: .3; } 30% { opacity: 1; } }

    .slug { display: flex; align-items: center; gap: 6px; }
    .slug span { color: var(--text-dim); font-family: ui-monospace, monospace; }
    .ejemplos { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; margin: 4px 0 8px; }
    .ej { background: none; border: 1px solid var(--border-light); border-radius: 8px; padding: 6px 10px; color: var(--text-main); font-size: 12.5px; text-align: left; cursor: pointer; }
    .ej:hover { border-color: var(--accent-primary); }
    .pedido { padding: 10px 12px; border-radius: 10px; background: var(--bg-main); color: var(--text-dim); font-size: 13px; line-height: 1.45; }
    .timeline { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .timeline li { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; line-height: 1.4; }
    .timeline .tl-ico { width: 18px; display: inline-flex; justify-content: center; flex: none; margin-top: 1px; color: var(--text-dim); }
    .timeline .tl-ok .tl-ico { color: var(--ok); }
    .timeline .tl-error .tl-ico, .timeline .tl-error .tl-txt { color: var(--warn); }
    .timeline li.activo .tl-txt { color: var(--text-main); font-weight: 500; }
    .timeline .tl-txt { flex: 1; }
    .timeline .tl-t { font-size: 11px; font-variant-numeric: tabular-nums; }
    .md-out { font-size: 14px; padding: 12px 14px; margin-top: 12px; border-radius: 10px; background: var(--bg-main); border: 1px solid var(--border-light); }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border-light); border-top-color: var(--accent-primary); border-radius: 50%; animation: sp .8s linear infinite; vertical-align: middle; }
    @keyframes sp { to { transform: rotate(360deg); } }

    @media (max-width: 1100px) {
      .gen-grid { grid-template-columns: minmax(0, 1fr); }
      .gen-side { position: static; }
    }
    @media (max-width: 700px) {
      .grid-ag { grid-template-columns: 1fr; }
      .canales { grid-template-columns: 1fr; }
      .env-cab { display: none; }
      .env-fila { grid-template-columns: minmax(0, 1fr) auto; }
      .env-fila > :nth-child(2), .env-fila > .valor { grid-column: 1 / -1; }
      .tools { grid-template-columns: minmax(0, 1fr); }
      .grid2 { grid-template-columns: minmax(0, 1fr); }
      .opcion.inline { margin: 0 0 14px; }
      .tlist { position: static; flex-direction: row; overflow-x: auto; }
      .titem { flex-shrink: 0; }
      .det-head, .det-body { padding-left: 14px; padding-right: 14px; }
      .ptabs { padding: 0 8px; }
      .det-foot { padding: 10px 14px; }
    }
  `],
})
export class AgentsComponent {
  api = inject(ApiService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  agents = signal<CustomAgent[]>([]);
  cargado = signal(false);
  canales = CANALES;
  ejemplos = EJEMPLOS_IA;
  uso = signal<Record<string, { turnos: number; costo: number }>>({});
  proveedores = signal<Record<string, string>>({});

  // Panel
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  /** Agente de la ruta /agents/:name (null en la lista). */
  rutaAgente = signal<string | null>(null);
  private preparado: string | null = null;
  actual = computed(() => this.agents().find((a) => a.name === this.rutaAgente()) || null);
  pestana = signal<Pestana>('general');
  form: CustomAgent | null = null;
  private original = '';
  private version = signal(0); // fuerza recomputar "sucio" al editar
  guardando = signal(false);
  envValores: Record<string, string> = {};
  envActual: Record<string, string> = {};
  /** El backend usa la variable global (p. ej. GEMINI_API_KEY) si falta AGENT_<NOMBRE>_<VAR>. */
  envGlobal: Record<string, string> = {};

  // Herramientas
  toolSel = signal(0);
  paramsTxt = signal('');
  errorParams = signal<string | null>(null);
  argsPrueba = '';
  salida = signal<Resultado | null>(null);
  ejecutando = signal(false);
  resultadosTests = signal<Array<{ args: any; ok: boolean; detalle?: string }>>([]);
  estadoTests = signal<Record<number, { ok: number; total: number }>>({});

  // Probar
  mensajes = signal<Mensaje[]>([]);
  probando = signal(false);
  textoPrueba = '';

  // Crear
  modalManual = signal(false);
  creando = signal(false);
  nuevo = { name: '', displayName: '', description: '' };
  slugTocado = false;
  modalIA = signal(false);
  generando = signal(false);
  resultadoIA = signal<{ respuesta: string; pasos: string[]; nuevos: string[] } | null>(null);
  estadosIA = signal<{ texto: string; nivel: 'info' | 'ok' | 'error'; t: string }[]>([]);
  promptIA = '';
  private inicioIA = 0;

  constructor() {
    // El mismo componente atiende /agents y /agents/:name; Angular lo reutiliza al pasar de un agente a otro.
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((pm) => { this.rutaAgente.set(pm.get('name')); this.preparar(); });
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((q) => {
      const t = q.get('tab') as Pestana | null;
      this.pestana.set(t && ['general', 'soul', 'tools', 'env', 'probar'].includes(t) ? t : 'general');
    });
    this.load(); this.cargarEnv(); this.cargarUso(); this.cargarProveedores();
  }

  // ─── Carga ────────────────────────────────────────────────────────────
  load() {
    this.api.getAgents().subscribe({
      next: (r) => { this.agents.set(r.agents); this.cargado.set(true); this.preparar(); this.cdr.markForCheck(); },
      error: (e) => { this.cargado.set(true); this.toast.error(e?.error?.error || 'No se pudieron cargar los agentes'); },
    });
  }

  private cargarEnv() {
    this.api.getEnv().subscribe({ next: (r) => {
      const actual: Record<string, string> = {};
      const globales: Record<string, string> = {};
      for (const v of r.vars as EnvVar[]) {
        if (v.valor && v.definida) globales[v.key] = v.valor;
        if (!v.valor || !v.key.startsWith('AGENT_')) continue;
        // AGENT_<NAME>_<VAR>: el nombre puede llevar _, así que se compara con los agentes conocidos
        for (const a of this.agents()) {
          const pre = `AGENT_${a.name.toUpperCase()}_`;
          if (v.key.startsWith(pre)) actual[`${a.name}:${v.key.slice(pre.length)}`] = v.valor;
        }
      }
      this.envActual = actual;
      this.envGlobal = globales;
      this.cdr.markForCheck();
    }, error: () => {} });
  }

  private cargarUso() {
    this.api.getUsage(1).subscribe({ next: (r) => {
      const out: Record<string, { turnos: number; costo: number }> = {};
      for (const x of r.byAgent || []) {
        const u = out[x.agent] || { turnos: 0, costo: 0 };
        u.turnos += x.count; u.costo += x.total_cost;
        out[x.agent] = u;
      }
      this.uso.set(out);
    }, error: () => {} });
  }

  private cargarProveedores() {
    this.api.getLlmSettings().subscribe({ next: (r) => {
      const m: Record<string, string> = {};
      for (const p of r.providers) m[p.id] = p.name;
      this.proveedores.set(m);
    }, error: () => {} });
  }

  // ─── Presentación ─────────────────────────────────────────────────────
  nombreCanal(c: CanalAgente) { return CANALES.find((x) => x.id === c)?.nombre || c; }
  iconoCanal(c: CanalAgente) { return CANALES.find((x) => x.id === c)?.icono || 'ph-circle'; }
  usaRed(a: CustomAgent) { return a.tools.some((t) => t.network); }
  json(x: any) { try { return JSON.stringify(x, null, 2); } catch { return String(x); } }
  json1(x: any) { try { return JSON.stringify(x); } catch { return String(x); } }

  etiquetaModelo(ref: string | null) {
    if (!ref) return 'modelo por defecto';
    const i = ref.indexOf('/');
    if (i < 0) return ref;
    const prov = this.proveedores()[ref.slice(0, i)];
    return `${prov ? prov.replace(/\s*\(.*\)$/, '') + ' · ' : ''}${ref.slice(i + 1)}`;
  }

  /** Tono estable por agente: identidad visual, no significado. */
  colorDe(nombre: string, alpha: number) {
    let h = 0;
    for (const ch of nombre) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsla(${h}, 70%, 68%, ${alpha})`;
  }

  hace(iso: string) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'editado recién';
    if (s < 3600) return `editado hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `editado hace ${Math.round(s / 3600)} h`;
    const d = Math.round(s / 86400);
    return d === 1 ? 'editado ayer' : `editado hace ${d} días`;
  }

  fecha(iso: string) { try { return new Date(iso).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return iso; } }

  /** Nombres de las herramientas llamadas ("→ nombre({...})"), sin repetir. */
  herramientasUsadas(pasos?: string[]): string[] {
    const out: string[] = [];
    for (const p of pasos || []) { const m = p.match(/^\s*→\s*([\w.-]+)\(/); if (m && !out.includes(m[1])) out.push(m[1]); }
    return out;
  }

  variablesFaltantes(a: CustomAgent) { return a.env.filter((e) => e.name && !this.envActual[`${a.name}:${e.name}`] && !this.envGlobal[e.name]).map((e) => e.name); }

  sugerencias(a: CustomAgent): string[] {
    const s = a.tools.slice(0, 3).map((t) => `Usa ${t.name.replace(/_/g, ' ')}${t.tests?.[0]?.args ? ' con ' + Object.values(t.tests[0].args).join(', ') : ''}`);
    return ['¿Qué sabes hacer?', ...s];
  }

  copiar(t: string) { navigator.clipboard.writeText(t).then(() => this.toast.ok(`Copiado: ${t.trim()}`), () => {}); }

  // ─── Panel ────────────────────────────────────────────────────────────
  abrir(a: CustomAgent, p: Pestana = 'general') {
    this.router.navigate(['/agents', a.name], { queryParams: p === 'general' ? {} : { tab: p } });
  }

  /** Copia editable del agente de la ruta (una vez por agente, para no pisar lo que se está editando). */
  private preparar() {
    const a = this.actual();
    if (!a) { if (!this.rutaAgente()) { this.form = null; this.preparado = null; } return; }
    if (this.preparado === a.name && this.form) return;
    this.preparado = a.name;
    this.form = JSON.parse(JSON.stringify(a));
    this.original = JSON.stringify(a);
    this.envValores = {};
    this.mensajes.set([]);
    this.elegirTool(0);
    this.estadoTests.set({});
    this.cdr.markForCheck();
  }

  irPestana(p: Pestana) {
    this.pestana.set(p);
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: p === 'general' ? null : p }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  cerrarPanel() { this.router.navigate(['/agents']); }

  /** canDeactivate de /agents/:name: no perder cambios al volver o navegar. */
  puedeSalir(): boolean {
    if (!this.sucio()) return true;
    const ok = confirm('Tienes cambios sin guardar. ¿Salir y descartarlos?');
    if (ok) { this.form = this.original ? JSON.parse(this.original) : null; this.envValores = {}; this.errorParams.set(null); }
    return ok;
  }

  descartar(a: CustomAgent) {
    this.form = JSON.parse(this.original);
    this.envValores = {};
    this.elegirTool(Math.min(this.toolSel(), (this.form?.tools.length || 1) - 1));
    this.version.update((v) => v + 1);
  }

  sucio(): boolean {
    this.version();
    if (!this.form) return false;
    return JSON.stringify(this.form) !== this.original || Object.values(this.envValores).some((v) => (v || '').trim()) || !!this.errorParams();
  }

  toggleCanal(c: CanalAgente) {
    if (!this.form) return;
    this.form.channels = this.form.channels.includes(c) ? this.form.channels.filter((x) => x !== c) : [...this.form.channels, c];
  }

  // ─── Herramientas ─────────────────────────────────────────────────────
  elegirTool(i: number) {
    this.toolSel.set(Math.max(0, i));
    const t = this.form?.tools[Math.max(0, i)];
    this.paramsTxt.set(t ? this.json(t.parameters) : '');
    this.errorParams.set(null);
    this.salida.set(null);
    this.resultadosTests.set([]);
    this.argsPrueba = t?.tests?.[0]?.args ? this.json1(t.tests[0].args) : '';
  }

  editarParams(txt: string) {
    this.paramsTxt.set(txt);
    const t = this.form?.tools[this.toolSel()];
    try {
      const v = JSON.parse(txt);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('debe ser un objeto');
      if (t) t.parameters = v;
      this.errorParams.set(null);
    } catch (e: any) {
      this.errorParams.set(e?.message?.includes('objeto') ? 'debe ser un objeto' : 'JSON inválido');
    }
  }

  agregarTool() {
    if (!this.form) return;
    this.form.tools.push({ name: `herramienta_${this.form.tools.length + 1}`, description: '', parameters: { type: 'object', properties: {}, required: [] }, code: '// args: los parámetros · ctx.env, ctx.fetch, ctx.log\nreturn { ok: true };', network: false, tests: [] });
    this.elegirTool(this.form.tools.length - 1);
  }

  quitarTool(i: number) {
    const t = this.form?.tools[i];
    if (!t || !confirm(`¿Quitar ${t.name}? Se aplica al guardar.`)) return;
    this.form!.tools.splice(i, 1);
    this.elegirTool(Math.min(i, this.form!.tools.length - 1));
  }

  /** Tab inserta dos espacios en el editor de código en vez de saltar de campo. */
  tab(ev: Event, t: CustomToolDef) {
    ev.preventDefault();
    const el = ev.target as HTMLTextAreaElement;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    t.code = t.code.slice(0, a) + '  ' + t.code.slice(b);
    el.value = t.code;
    el.selectionStart = el.selectionEnd = a + 2;
  }

  private parsearArgs(): any | undefined {
    try { return JSON.parse(this.argsPrueba.trim() || '{}'); }
    catch { this.toast.error('Args de prueba: JSON inválido'); return undefined; }
  }

  ejecutarTool(a: CustomAgent, t: CustomToolDef) {
    const args = this.parsearArgs();
    if (args === undefined || !t.name) return;
    this.ejecutando.set(true);
    this.resultadosTests.set([]);
    this.api.testAgentTool(a.name, t.name, args, { code: t.code, network: !!t.network }).subscribe({
      next: (r) => { this.ejecutando.set(false); this.salida.set(r); this.cdr.markForCheck(); },
      error: (e) => { this.ejecutando.set(false); this.salida.set({ ok: false, error: e?.error?.error || 'Error' }); },
    });
  }

  /** Corre los tests declarados contra el código en edición (misma comparación que el backend al guardar). */
  async correrTests(a: CustomAgent, t: CustomToolDef) {
    const casos = t.tests || [];
    this.ejecutando.set(true);
    this.salida.set(null);
    const res: Array<{ args: any; ok: boolean; detalle?: string }> = [];
    for (const c of casos) {
      try {
        const r = await new Promise<Resultado>((ok, mal) => this.api.testAgentTool(a.name, t.name, c.args, { code: t.code, network: !!t.network }).subscribe({ next: ok, error: mal }));
        if (!r.ok) res.push({ args: c.args, ok: false, detalle: r.error });
        else if (c.expect !== undefined && JSON.stringify(r.result) !== JSON.stringify(c.expect)) res.push({ args: c.args, ok: false, detalle: `esperaba ${this.json1(c.expect)} y devolvió ${this.json1(r.result).slice(0, 160)}` });
        else res.push({ args: c.args, ok: true });
      } catch (e: any) {
        res.push({ args: c.args, ok: false, detalle: e?.error?.error || 'Error' });
      }
      this.resultadosTests.set([...res]);
    }
    this.estadoTests.set({ ...this.estadoTests(), [this.toolSel()]: { ok: res.filter((x) => x.ok).length, total: res.length } });
    this.ejecutando.set(false);
  }

  // ─── Guardar / estado ─────────────────────────────────────────────────
  guardar(a: CustomAgent) {
    if (!this.form) return;
    if (this.errorParams()) { this.pestana.set('tools'); this.toast.error('Hay parámetros con JSON inválido'); return; }
    const sinNombre = this.form.tools.findIndex((t) => !/^[a-z][a-z0-9_]*$/.test(t.name));
    if (sinNombre >= 0) { this.pestana.set('tools'); this.elegirTool(sinNombre); this.toast.error('Nombre de herramienta inválido: usa snake_case'); return; }
    this.guardando.set(true);
    const { name, createdAt, createdBy, updatedAt, version, ...cambios } = this.form;
    this.api.updateAgent(a.name, cambios).subscribe({
      next: (r) => {
        const patch: Record<string, string> = {};
        for (const e of this.form!.env) { const v = (this.envValores[e.name] || '').trim(); if (v && e.name) patch[`AGENT_${a.name.toUpperCase()}_${e.name.toUpperCase()}`] = v; }
        const fin = () => {
          this.guardando.set(false);
          this.form = JSON.parse(JSON.stringify(r.agent));
          this.original = JSON.stringify(r.agent);
          this.envValores = {};
          this.agents.set(this.agents().map((x) => (x.name === a.name ? r.agent : x)));
          this.toast.ok(`${r.agent.displayName} guardado (v${r.agent.version})`);
          this.cargarEnv();
        };
        if (Object.keys(patch).length) this.api.saveEnv(patch).subscribe({ next: fin, error: () => { this.toast.error('Agente guardado, pero no se pudieron escribir las variables'); fin(); } });
        else fin();
      },
      // El backend corre los tests de las herramientas antes de guardar: el error dice cuál falló.
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); },
    });
  }

  alternar(a: CustomAgent) {
    this.api.updateAgent(a.name, { enabled: !a.enabled }).subscribe({
      next: (r) => { this.agents.set(this.agents().map((x) => (x.name === a.name ? r.agent : x))); this.toast.ok(r.agent.enabled ? `${a.displayName} activo` : `${a.displayName} en pausa`); },
      error: (e) => { this.toast.error(e?.error?.error || 'No se pudo cambiar'); this.load(); },
    });
  }

  eliminar(a: CustomAgent) {
    if (!confirm(`¿Eliminar a ${a.displayName}? Se borra su definición, herramientas y memoria.`)) return;
    this.api.deleteAgent(a.name).subscribe({
      next: () => { this.toast.ok(`${a.displayName} eliminado`); this.form = null; this.preparado = null; this.agents.set(this.agents().filter((x) => x.name !== a.name)); this.router.navigate(['/agents']); },
      error: () => this.toast.error('No se pudo eliminar'),
    });
  }

  // ─── Probar ───────────────────────────────────────────────────────────
  enviarPrueba(a: CustomAgent) {
    const t = this.textoPrueba.trim();
    if (!t || this.probando()) return;
    this.textoPrueba = '';
    this.probando.set(true);
    this.mensajes.update((l) => [...l, { rol: 'yo', texto: t }]);
    const t0 = Date.now();
    this.api.chatAgent(a.name, t).subscribe({
      next: (r) => { this.mensajes.update((l) => [...l, { rol: 'agente', texto: r.respuesta || '(sin respuesta)', pasos: r.pasos, ms: Date.now() - t0 }]); this.probando.set(false); },
      error: (e) => { this.mensajes.update((l) => [...l, { rol: 'agente', texto: `**Error:** ${e?.error?.error || 'falló'}` }]); this.probando.set(false); },
    });
  }

  // ─── Crear a mano ─────────────────────────────────────────────────────
  abrirManual() { this.nuevo = { name: '', displayName: '', description: '' }; this.slugTocado = false; this.modalManual.set(true); }
  sugerirSlug() {
    if (this.slugTocado) return;
    this.nuevo.name = this.nuevo.displayName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 30);
  }
  slugValido() { return /^[a-z][a-z0-9_]{1,29}$/.test(this.nuevo.name); }
  slugOcupado() { return this.agents().some((a) => a.name === this.nuevo.name); }

  crearManual() {
    this.creando.set(true);
    this.api.createAgent({
      name: this.nuevo.name, displayName: this.nuevo.displayName.trim(),
      description: this.nuevo.description.trim() || 'Describe cuándo debe usarlo el Coordinator.',
      soul: `Eres ${this.nuevo.displayName.trim()}. Describe aquí tu personalidad, cómo hablas y cómo trabajas.`,
      tools: [], env: [], memory: false, channels: ['telegram', 'api'], model: null,
    } as any).subscribe({
      next: (r) => { this.creando.set(false); this.modalManual.set(false); this.agents.set([...this.agents(), r.agent]); this.abrir(r.agent, 'soul'); },
      error: (e) => { this.creando.set(false); this.toast.error(e?.error?.error || 'No se pudo crear'); },
    });
  }

  // ─── Crear con IA ─────────────────────────────────────────────────────
  /** Cerrar mientras genera no cancela: el builder sigue y al terminar la lista se refresca sola. */
  cerrarIA() { this.modalIA.set(false); if (!this.generando()) { this.resultadoIA.set(null); this.estadosIA.set([]); } }
  nuevaGeneracion() { this.resultadoIA.set(null); this.estadosIA.set([]); this.promptIA = ''; }
  nombreVisible(slug: string): string { return this.agents().find((a) => a.name === slug)?.displayName || slug; }
  irAlAgente(slug: string, p: Pestana) {
    const a = this.agents().find((x) => x.name === slug);
    this.modalIA.set(false); this.resultadoIA.set(null); this.estadosIA.set([]); this.promptIA = '';
    if (a) this.abrir(a, p);
  }

  private pushEstado(texto: string, nivel: 'info' | 'ok' | 'error' = 'info') {
    const seg = Math.round((Date.now() - this.inicioIA) / 1000);
    this.estadosIA.update((l) => [...l, { texto, nivel, t: `${seg}s` }]);
    this.cdr.markForCheck();
  }

  async generar() {
    const prompt = this.promptIA.trim();
    if (!prompt || this.generando()) return;
    this.generando.set(true); this.resultadoIA.set(null); this.estadosIA.set([]); this.inicioIA = Date.now();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const sesion = localStorage.getItem('yisus_auth_token');
    const adminKey = localStorage.getItem('yisus_admin_key');
    if (sesion) headers['Authorization'] = `Bearer ${sesion}`;
    else if (adminKey) headers['X-Admin-Key'] = adminKey;
    try {
      const res = await fetch(`${this.api.baseUrl}/api/agents/generate/stream`, { method: 'POST', headers, body: JSON.stringify({ prompt }) });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let terminado = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const bloques = buf.split('\n\n'); buf = bloques.pop() || '';
        for (const b of bloques) {
          const linea = b.split('\n').find((l) => l.startsWith('data: '));
          if (!linea) continue;
          let ev: any; try { ev = JSON.parse(linea.slice(6)); } catch { continue; }
          if (ev.type === 'estado') this.pushEstado(ev.texto, ev.nivel);
          else if (ev.type === 'fin') {
            terminado = true;
            this.pushEstado(ev.nuevos.length ? `Listo en ${Math.round((Date.now() - this.inicioIA) / 1000)}s` : 'El programador terminó sin crear un agente nuevo (revisa su respuesta)', ev.nuevos.length ? 'ok' : 'error');
            this.resultadoIA.set({ respuesta: ev.respuesta, pasos: ev.pasos, nuevos: ev.nuevos });
            this.agents.set(ev.agents);
            this.cargarEnv();
            if (ev.nuevos.length) this.toast.ok(`Agente creado: ${ev.nuevos.map((n: string) => this.nombreVisible(n)).join(', ')}`);
          } else if (ev.type === 'error') throw new Error(ev.error);
        }
      }
      if (!terminado) throw new Error('La conexión se cortó antes de terminar');
    } catch (e: any) {
      this.pushEstado(`Error: ${e?.message || 'No se pudo crear'}`, 'error');
      this.toast.error(e?.message || 'No se pudo crear');
      this.load();
    } finally {
      this.generando.set(false);
      this.cdr.markForCheck();
    }
  }
}
