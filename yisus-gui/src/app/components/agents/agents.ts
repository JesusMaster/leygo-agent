import { ChangeDetectorRef, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService, CanalAgente, CustomAgent, CustomToolDef, EnvVar, HerramientaGenerada, SugerenciaTool } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { ModelPickerComponent } from '../model-picker/model-picker';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { CodeEditorComponent } from '../code-editor/code-editor';
import type { SugerenciaEditor } from '../code-editor/code-editor';

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
  host: { '(window:beforeunload)': 'alSalirDelNavegador($event)', '(document:keydown)': 'atajos($event)' },
  imports: [FormsModule, RouterLink, ModelPickerComponent, MarkdownPipe, CodeEditorComponent],
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
                @if (hayBorrador(a.name)) { <span class="tag acc" title="Tienes cambios sin guardar en este agente"><i class="ph ph-pencil-simple-line"></i> borrador sin guardar</span> }
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
            @let mod = modificadas();
            <button [class.on]="pestana() === 'general'" (click)="irPestana('general')">General@if (mod.general) { <i class="mod" title="Cambios sin guardar"></i> }</button>
            <button [class.on]="pestana() === 'soul'" (click)="irPestana('soul')">Personalidad@if (mod.soul) { <i class="mod" title="Cambios sin guardar"></i> }</button>
            <button [class.on]="pestana() === 'tools'" (click)="irPestana('tools')">Herramientas <span class="n">{{ f.tools.length }}</span>@if (mod.tools) { <i class="mod" title="Cambios sin guardar"></i> }</button>
            <button [class.on]="pestana() === 'env'" (click)="irPestana('env')">Variables <span class="n" [class.warn]="variablesFaltantes(a).length">{{ f.env.length }}</span>@if (mod.env) { <i class="mod" title="Cambios sin guardar"></i> }</button>
            <button [class.on]="pestana() === 'probar'" (click)="irPestana('probar')"><i class="ph ph-chat-circle-dots"></i> Probar</button>
          </nav>

          @if (borradorPendiente(); as bp) {
            <div class="restaurar">
              <i class="ph ph-clock-counter-clockwise"></i>
              <div>
                <b>Tienes cambios sin guardar de {{ haceTexto(bp.t) }}</b>
                <small>{{ bp.resumen }}@if (bp.version !== a.version) { · se hicieron sobre la v{{ bp.version }} (la actual es v{{ a.version }}) }</small>
              </div>
              <span class="spacer"></span>
              <button class="btn-secondary sm" (click)="descartarBorrador(a)">Descartar</button>
              <button class="btn-primary sm" (click)="restaurarBorrador()">Restaurar</button>
            </div>
          }

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
                    <div class="nuevas">
                      <button class="btn-primary sm" (click)="abrirToolIA()"><i class="ph ph-sparkle"></i> Crear con IA</button>
                      <button class="btn-secondary sm" (click)="agregarTool()" title="Empieza desde una plantilla vacía"><i class="ph ph-plus"></i> A mano</button>
                    </div>

                    <div class="recom">
                      <div class="recom-h">
                        <span><i class="ph ph-lightbulb"></i> Recomendadas</span>
                        @if (recomendadas() !== null && !cargandoSug()) { <button class="link" (click)="cargarSugerencias(a, true)" title="Pedir otras"><i class="ph ph-arrows-clockwise"></i></button> }
                      </div>
                      @if (cargandoSug()) {
                        <div class="recom-vacio"><span class="spinner"></span> Pensando qué le falta a {{ a.displayName }}…</div>
                      } @else if (recomendadas() === null) {
                        <p class="recom-vacio">Ideas de herramientas según su personalidad y lo que ya sabe hacer.</p>
                        <button class="btn-secondary sm ancho" (click)="cargarSugerencias(a)"><i class="ph ph-sparkle"></i> Sugerir herramientas</button>
                      } @else {
                        @for (sg of recomendadas()!; track sg.nombre) {
                          <button class="sug" (click)="abrirToolIA(sg)" [title]="sg.pedido">
                            <b>{{ sg.titulo }}</b>
                            <small>{{ sg.descripcion }}</small>
                            @if (sg.network || sg.requiere) { <span class="sug-tags">@if (sg.network) { <em><i class="ph ph-globe"></i> red</em> }@if (sg.requiere) { <em><i class="ph ph-key"></i> {{ sg.requiere }}</em> }</span> }
                          </button>
                        } @empty {
                          <p class="recom-vacio">No se me ocurren más: ya cubre lo principal.</p>
                        }
                      }
                    </div>
                  </div>

                  @if (f.tools[toolSel()]; as t) {
                    <div class="teditor">
                      <div class="grid2">
                        <label class="field"><span>Nombre <em>snake_case</em></span><input type="text" class="mono" [(ngModel)]="t.name" /></label>
                        <label class="opcion inline"><input type="checkbox" [(ngModel)]="t.network" /><span><b>Usa red</b><small><code>ctx.fetch</code>, solo https</small></span></label>
                      </div>
                      <label class="field"><span>Descripción <em>el modelo la lee para decidir cuándo usarla</em></span><input type="text" [(ngModel)]="t.description" /></label>
                      <div class="field">
                        <span>Parámetros <em>JSON Schema</em>@if (errorParams(); as e) { <em class="bad"> · {{ e }}</em> }</span>
                        @defer (on immediate) {
                          <app-code-editor lenguaje="json" [value]="paramsTxt()" (valueChange)="editarParams($event)" [invalido]="!!errorParams()" minAlto="110px" maxAlto="340px" />
                        } @placeholder { <div class="editor-cargando" style="height:110px">Cargando editor…</div> }
                      </div>
                      <div class="field">
                        <span>Código <em>cuerpo de async (args, ctx) =&gt; {{ '{' }} … {{ '}' }} · en sandbox</em></span>
                        @defer (on immediate) {
                          <app-code-editor lenguaje="javascript" [value]="t.code" (valueChange)="t.code = $event" [sugerencias]="sugerenciasDe(a, t)" minAlto="320px" maxAlto="72vh" placeholder="return { ok: true };" />
                        } @placeholder { <div class="editor-cargando" style="height:320px">Cargando editor…</div> }
                        <small class="hint">Tab indenta · Cmd/Ctrl+F busca · Ctrl+Espacio sugiere <code>args.*</code> y <code>ctx.*</code></small>
                      </div>

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
                  @if (sucio()) {
                    <div class="pendiente">
                      <i class="ph ph-warning-circle"></i>
                      <div><b>Tus cambios todavía no están en {{ a.displayName }}</b><small>Probar usa la versión guardada (v{{ a.version }}). Guarda primero para probar lo que acabas de editar.</small></div>
                      <span class="spacer"></span>
                      <button class="btn-primary sm" (click)="guardar(a)" [disabled]="guardando()">@if (guardando()) { <span class="spinner"></span> Guardando… } @else { <i class="ph ph-floppy-disk"></i> Guardar y probar }</button>
                    </div>
                  }
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

          <div class="det-foot" [class.sucio]="sucio() && pestana() !== 'probar'">
            @if (pestana() === 'probar') {
              <input type="text" [(ngModel)]="textoPrueba" [placeholder]="'Escríbele a ' + a.displayName + '…'" (keydown.enter)="enviarPrueba(a)" [disabled]="probando() || !a.enabled" />
              <button class="btn-icon" title="Nueva conversación" (click)="mensajes.set([])" [disabled]="!mensajes().length"><i class="ph ph-arrow-counter-clockwise"></i></button>
              <button class="btn-primary" (click)="enviarPrueba(a)" [disabled]="!textoPrueba.trim() || probando() || !a.enabled"><i class="ph ph-paper-plane-tilt"></i></button>
            } @else {
              @if (sucio()) { <span class="dirty"><i class="ph ph-circle-fill"></i> Cambios sin guardar <small class="dim">· se conservan en este navegador · {{ atajo }}+S para guardar</small></span> } @else { <span class="dim">Todo guardado · v{{ a.version }}</span> }
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

    <!-- ═══ Salir con cambios sin guardar ═══ -->
    @if (modalSalida(); as sal) {
      <div class="modal-backdrop">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head"><h3><i class="ph ph-warning-circle"></i> Cambios sin guardar</h3></div>
          <div class="modal-body">
            <p style="margin:0">Tienes cambios en <b>{{ sal.nombre }}</b> que aún no están guardados: {{ sal.resumen }}.</p>
            <small class="hint">Si sales sin guardar quedan como borrador en este navegador y podrás restaurarlos al volver.</small>
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="responderSalida('quedarse')">Seguir editando</button>
            <span class="spacer"></span>
            <button class="btn-secondary" (click)="responderSalida('salir')">Salir (dejar borrador)</button>
            <button class="btn-primary" (click)="responderSalida('guardar')" [disabled]="guardando()">@if (guardando()) { <span class="spinner"></span> Guardando… } @else { <i class="ph ph-floppy-disk"></i> Guardar y salir }</button>
          </div>
        </div>
      </div>
    }

    <!-- ═══ Herramienta con IA ═══ -->
    @if (modalTool(); as mt) {
      <div class="modal-backdrop" (click)="cerrarToolIA()">
        <div class="modal ancho-tool" (click)="$event.stopPropagation()">
          <div class="modal-head"><h3><i class="ph ph-sparkle"></i> Nueva herramienta con IA</h3><button class="btn-icon" (click)="cerrarToolIA()"><i class="ph ph-x"></i></button></div>
          <div class="modal-body">
            @if (!generandoTool() && !mt.resultado) {
              <label class="field">
                <span>¿Qué debe hacer? Describe entradas, resultado y unidades</span>
                <textarea rows="5" [(ngModel)]="pedidoTool" placeholder="Ej: dado el rumbo de pista y el viento (dirección y velocidad en nudos), calcula la componente de viento cruzado y de frente."></textarea>
              </label>
              @if (recomendadas()?.length) {
                <div class="ejemplos">
                  <small class="dim">Recomendadas:</small>
                  @for (sg of recomendadas()!; track sg.nombre) { <button class="ej" (click)="pedidoTool = sg.pedido">{{ sg.titulo }}</button> }
                </div>
              }
              <small class="hint">Escribe el código, los parámetros y los tests, los corre en el sandbox y te la deja como borrador. Se integra al agente cuando guardas.</small>
            } @else if (generandoTool()) {
              <div class="pedido"><i class="ph ph-quotes"></i> {{ pedidoTool }}</div>
              <div class="generando"><span class="spinner"></span> {{ faseTool() }}</div>
            } @else if (mt.resultado; as r) {
              @let okTests = contarOk(r);
              <div class="gen-res">
                <div class="gen-top">
                  <code class="gen-nombre">{{ r.tool.name }}</code>
                  @if (r.tool.network) { <span class="tag"><i class="ph ph-globe"></i> usa red</span> }
                  @if (r.tests.length) {
                    <span class="tag" [class.ok]="okTests === r.tests.length" [class.warn]="okTests < r.tests.length"><i class="ph ph-checks"></i> {{ okTests }}/{{ r.tests.length }} tests</span>
                  } @else { <span class="tag">sin tests</span> }
                  @if (r.intentos > 1) { <span class="tag" title="La IA corrigió su primer intento">corregida</span> }
                </div>
                <p class="gen-desc">{{ r.tool.description }}</p>
                @if (r.nota) { <div class="aviso"><i class="ph ph-info"></i> {{ r.nota }}</div> }
                <div class="gen-params">
                  <span class="lbl">Parámetros</span>
                  @for (p of paramsDe(r.tool); track p.nombre) {
                    <div class="gp"><code>{{ p.nombre }}</code><em>{{ p.tipo }}{{ p.requerido ? ' · requerido' : '' }}</em><small>{{ p.descripcion }}</small></div>
                  } @empty { <small class="dim">sin parámetros</small> }
                </div>
                @if (r.tests.length) {
                  <ul class="tests">
                    @for (x of r.tests; track $index) {
                      <li [class.ok]="x.ok" [class.bad]="!x.ok">
                        <i class="ph" [class.ph-check-circle]="x.ok" [class.ph-x-circle]="!x.ok"></i>
                        <code>{{ json1(x.args) }}</code>
                        @if (x.ok && x.resultado !== undefined) { <span class="dim">→ {{ json1(x.resultado).slice(0, 120) }}</span> }
                        @if (!x.ok) { <span>{{ x.detalle }}</span> }
                      </li>
                    }
                  </ul>
                }
                @if (r.envNuevas.length) {
                  <div class="aviso warn"><i class="ph ph-key"></i> Necesita {{ r.envNuevas.length === 1 ? 'la variable' : 'las variables' }} <b>{{ nombresEnv(r) }}</b>: se agregan a Variables para que les pongas valor.</div>
                }
                @if (okTests < r.tests.length) {
                  <div class="aviso warn"><i class="ph ph-warning"></i> Hay tests que fallan: al guardar el agente se rechaza. Puedes regenerarla o agregarla y corregirla en el editor.</div>
                }
                <details class="gen-code"><summary>Ver código</summary><pre class="out">{{ r.tool.code }}</pre></details>
              </div>
            }
          </div>
          <div class="modal-foot">
            @if (mt.resultado && !generandoTool()) {
              <button class="btn-secondary" (click)="mt.resultado = null">Ajustar pedido</button>
              <button class="btn-secondary" (click)="generarTool(mt.agente)"><i class="ph ph-arrows-clockwise"></i> Regenerar</button>
              <span class="spacer"></span>
              <button class="btn-secondary" (click)="integrarTool(mt.resultado)" title="Queda en el editor; se integra cuando guardas">Solo agregar al borrador</button>
              <button class="btn-primary" (click)="integrarTool(mt.resultado, mt.agente)" [disabled]="guardando()"><i class="ph ph-floppy-disk"></i> Agregar y guardar</button>
            } @else {
              <button class="btn-secondary" (click)="cerrarToolIA()">Cancelar</button>
              <button class="btn-primary" [disabled]="pedidoTool.trim().length < 8 || generandoTool()" (click)="generarTool(mt.agente)">
                @if (generandoTool()) { <span class="spinner"></span> Creando… } @else { <i class="ph ph-sparkle"></i> Crear herramienta }
              </button>
            }
          </div>
        </div>
      </div>
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
    .det-foot.sucio { border-top-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card)); }
    .dirty small { font-weight: 400; margin-left: 4px; }
    .ptabs .mod { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-primary); display: inline-block; margin-left: 2px; }
    .restaurar, .pendiente { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 16px 28px 0; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(129,140,248,.5); background: rgba(129,140,248,.1); }
    .restaurar > i, .pendiente > i { font-size: 22px; color: var(--accent-primary); }
    .restaurar > div, .pendiente > div { display: flex; flex-direction: column; font-size: 13.5px; }
    .restaurar small, .pendiente small { color: var(--text-dim); font-size: 12.5px; }
    .pendiente { margin: 0 0 6px; border-color: rgba(245,158,11,.5); background: rgba(245,158,11,.08); }
    .pendiente > i { color: var(--warn); }
    .tag.acc { color: var(--accent-primary); border-color: rgba(129,140,248,.5); }
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
    .nuevas { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin-top: 8px; }
    .nuevas .btn-primary.sm { justify-content: center; }
    .recom { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border-light); display: flex; flex-direction: column; gap: 6px; }
    .recom-h { display: flex; justify-content: space-between; align-items: center; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); }
    .recom-h i { color: var(--warn); }
    .recom-vacio { margin: 0 0 4px; color: var(--text-dim); font-size: 12.5px; line-height: 1.45; }
    .btn-secondary.sm.ancho { width: 100%; justify-content: center; }
    .link { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 2px; }
    .link:hover { color: var(--accent-primary); }
    .sug { display: flex; flex-direction: column; gap: 3px; text-align: left; padding: 9px 10px; border-radius: 9px; border: 1px dashed var(--border-light); background: none; color: var(--text-main); cursor: pointer; }
    .sug:hover { border-color: var(--accent-primary); border-style: solid; background: rgba(129,140,248,.06); }
    .sug b { font-size: 13px; }
    .sug small { color: var(--text-dim); font-size: 12px; line-height: 1.4; }
    .sug-tags { display: flex; gap: 8px; flex-wrap: wrap; }
    .sug-tags em { font-style: normal; font-size: 11px; color: var(--text-dim); }
    .modal.ancho-tool { width: min(760px, 100%); }
    .generando { display: flex; align-items: center; gap: 10px; margin-top: 14px; font-size: 13.5px; }
    .gen-res { display: flex; flex-direction: column; gap: 12px; }
    .gen-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .gen-nombre { font-size: 15px; font-weight: 600; }
    .gen-desc { margin: 0; color: var(--text-dim); font-size: 13.5px; }
    .gen-params { display: flex; flex-direction: column; gap: 6px; }
    .gen-params .lbl { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); }
    .gp { display: grid; grid-template-columns: auto auto 1fr; gap: 10px; align-items: baseline; font-size: 13px; }
    .gp em { font-style: normal; color: var(--text-dim); font-size: 12px; }
    .gp small { color: var(--text-dim); font-size: 12px; }
    .aviso.warn { background: rgba(245,158,11,.08); border-color: rgba(245,158,11,.4); }
    .gen-code summary { cursor: pointer; color: var(--text-dim); font-size: 13px; }
    .teditor { min-width: 0; }
    .teditor .grid2 > * { min-width: 0; }
    .teditor.empty { color: var(--text-dim); font-size: 13.5px; padding: 20px; border: 1px dashed var(--border-light); border-radius: 10px; }
    .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
    .editor-cargando { display: grid; place-items: center; border: 1px solid var(--border-light); border-radius: 10px; background: var(--bg-input); color: var(--text-dim); font-size: 12.5px; }
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
export class AgentsComponent implements OnDestroy {
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
    if (this.sugDe !== a.name) this.recomendadas.set(null);
    this.borradorPendiente.set(null);
    this.ultimoBorrador = '';
    this.leerBorrador(a);
    this.cdr.markForCheck();
  }

  irPestana(p: Pestana) {
    this.pestana.set(p);
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: p === 'general' ? null : p }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  cerrarPanel() { this.router.navigate(['/agents']); }

  // ─── Cambios sin guardar ───────────────────────────────────────────────
  // Tres capas: borrador automático en localStorage (sobrevive a salir, recargar o cerrar),
  // modal propio al salir con Guardar/Salir/Seguir, y aviso del navegador al recargar/cerrar.
  readonly atajo = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  modalSalida = signal<{ nombre: string; resumen: string; resolver: (ok: boolean) => void } | null>(null);
  borradorPendiente = signal<{ form: CustomAgent; t: number; version: number; resumen: string } | null>(null);
  private autoguardado = setInterval(() => this.guardarBorrador(), 1500);
  private ultimoBorrador = '';

  ngOnDestroy() { clearInterval(this.autoguardado); this.guardarBorrador(); }

  private claveBorrador(nombre: string) { return `yisus_agent_draft:${nombre}`; }

  hayBorrador(nombre: string): boolean { try { return !!localStorage.getItem(this.claveBorrador(nombre)); } catch { return false; } }

  /** Se guarda solo la definición (no los valores de variables: pueden ser secretos). */
  private guardarBorrador() {
    const a = this.actual();
    if (!a || !this.form || this.borradorPendiente()) return;
    const clave = this.claveBorrador(a.name);
    try {
      if (JSON.stringify(this.form) === this.original) {
        if (this.ultimoBorrador) { localStorage.removeItem(clave); this.ultimoBorrador = ''; }
        return;
      }
      const json = JSON.stringify(this.form);
      if (json === this.ultimoBorrador) return;
      localStorage.setItem(clave, JSON.stringify({ form: this.form, t: Date.now(), version: a.version }));
      this.ultimoBorrador = json;
    } catch { /* sin localStorage: queda el aviso al salir */ }
  }

  private borrarBorrador(nombre: string) { try { localStorage.removeItem(this.claveBorrador(nombre)); } catch {} this.ultimoBorrador = ''; }

  private leerBorrador(a: CustomAgent) {
    try {
      const raw = localStorage.getItem(this.claveBorrador(a.name));
      if (!raw) return;
      const b = JSON.parse(raw);
      if (!b?.form || JSON.stringify(b.form) === JSON.stringify(a)) { this.borrarBorrador(a.name); return; }
      this.borradorPendiente.set({ form: b.form, t: b.t, version: b.version, resumen: this.resumirCambios(JSON.parse(JSON.stringify(a)), b.form) });
    } catch { this.borrarBorrador(a.name); }
  }

  restaurarBorrador() {
    const b = this.borradorPendiente();
    if (!b) return;
    this.form = JSON.parse(JSON.stringify(b.form));
    this.borradorPendiente.set(null);
    this.elegirTool(Math.min(this.toolSel(), Math.max(0, (this.form?.tools.length || 1) - 1)));
    this.version.update((v) => v + 1);
    this.toast.ok('Cambios restaurados: revisa y guarda');
  }

  descartarBorrador(a: CustomAgent) { this.borradorPendiente.set(null); this.borrarBorrador(a.name); }

  /** Qué secciones cambiaron respecto de lo guardado (para el punto en las pestañas). */
  modificadas(): { general: boolean; soul: boolean; tools: boolean; env: boolean } {
    this.version();
    const f = this.form;
    if (!f || !this.original) return { general: false, soul: false, tools: false, env: false };
    const o = this.originalParseado();
    const j = JSON.stringify;
    return {
      general: f.displayName !== o.displayName || f.description !== o.description || j(f.channels) !== j(o.channels) || f.model !== o.model || f.memory !== o.memory,
      soul: f.soul !== o.soul,
      tools: j(f.tools) !== j(o.tools) || !!this.errorParams(),
      env: j(f.env) !== j(o.env) || Object.values(this.envValores).some((v) => (v || '').trim()),
    };
  }
  private cacheOriginal: { raw: string; obj: CustomAgent } | null = null;
  private originalParseado(): CustomAgent {
    if (this.cacheOriginal?.raw !== this.original) this.cacheOriginal = { raw: this.original, obj: JSON.parse(this.original) };
    return this.cacheOriginal.obj;
  }

  private resumirCambios(o: CustomAgent, f: CustomAgent): string {
    const partes: string[] = [];
    const nuevas = f.tools.filter((t) => !o.tools.some((x) => x.name === t.name)).map((t) => t.name);
    const quitadas = o.tools.filter((t) => !f.tools.some((x) => x.name === t.name)).map((t) => t.name);
    const editadas = f.tools.filter((t) => { const x = o.tools.find((y) => y.name === t.name); return x && JSON.stringify(x) !== JSON.stringify(t); }).map((t) => t.name);
    if (nuevas.length) partes.push(`${nuevas.length === 1 ? 'herramienta nueva' : nuevas.length + ' herramientas nuevas'} (${nuevas.join(', ')})`);
    if (editadas.length) partes.push(`${editadas.length === 1 ? 'editada' : 'editadas'}: ${editadas.join(', ')}`);
    if (quitadas.length) partes.push(`${quitadas.length === 1 ? 'quitada' : 'quitadas'}: ${quitadas.join(', ')}`);
    if (f.soul !== o.soul) partes.push('personalidad');
    if (f.displayName !== o.displayName || f.description !== o.description || JSON.stringify(f.channels) !== JSON.stringify(o.channels) || f.model !== o.model || f.memory !== o.memory) partes.push('datos generales');
    if (JSON.stringify(f.env) !== JSON.stringify(o.env)) partes.push('variables');
    return partes.join(' · ') || 'cambios menores';
  }

  haceTexto(t: number) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'hace un momento';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return new Date(t).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
  }

  /** canDeactivate de /agents/:name: modal propio en vez de confirm(). */
  puedeSalir(): boolean | Promise<boolean> {
    const a = this.actual();
    if (!a || !this.sucio()) return true;
    this.guardarBorrador();
    const resumen = this.resumirCambios(this.originalParseado(), this.form!);
    return new Promise<boolean>((resolver) => this.modalSalida.set({ nombre: a.displayName, resumen, resolver }));
  }

  async responderSalida(r: 'quedarse' | 'salir' | 'guardar') {
    const sal = this.modalSalida();
    const a = this.actual();
    if (!sal) return;
    if (r === 'guardar' && a) {
      const ok = await this.guardar(a);
      if (!ok) return; // se queda el modal: el toast explica qué falló
    }
    this.modalSalida.set(null);
    if (r !== 'quedarse') { this.preparado = null; this.borradorPendiente.set(null); }
    sal.resolver(r !== 'quedarse');
  }

  alSalirDelNavegador(ev: BeforeUnloadEvent) {
    if (!this.actual() || !this.sucio()) return;
    this.guardarBorrador();
    ev.preventDefault();
    ev.returnValue = '';
  }

  atajos(ev: KeyboardEvent) {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      const a = this.actual();
      if (!a || !this.form) return;
      ev.preventDefault();
      if (this.sucio() && !this.guardando()) this.guardar(a);
    }
  }

  descartar(a: CustomAgent) {
    this.borrarBorrador(a.name);
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

  /** Autocompletado del editor: parámetros de la herramienta y lo que ofrece ctx en el sandbox. */
  sugerenciasDe(a: CustomAgent, t: CustomToolDef): SugerenciaEditor[] {
    const clave = `${a.name}|${t.name}|${JSON.stringify(t.parameters?.properties || {})}|${this.form?.env.map((e) => e.name).join(',')}|${t.network}|${this.form?.memory}`;
    if (this.cacheSug?.clave === clave) return this.cacheSug.lista;
    const props = (t.parameters?.properties || {}) as Record<string, any>;
    const req: string[] = t.parameters?.required || [];
    const lista: SugerenciaEditor[] = [
      ...Object.entries(props).map(([k, v]) => ({ label: `args.${k}`, detail: `${v?.type || 'any'}${req.includes(k) ? ' · requerido' : ''}`, info: v?.description, type: 'variable' })),
      ...(this.form?.env || []).filter((e) => e.name).map((e) => ({ label: `ctx.env.${e.name}`, detail: e.secret ? 'secreto' : 'variable', info: e.description, type: 'constant' })),
      { label: 'ctx.env', detail: 'Record<string, string>', info: 'Variables del agente (AGENT_<NOMBRE>_<VAR> o la global).' },
      { label: 'ctx.log', detail: '(...valores) => void', info: 'Aparece en "logs" al probar.', type: 'function' },
      { label: 'ctx.now', detail: '() => string', info: 'Fecha y hora actual en ISO.', type: 'function' },
      ...(this.form?.tools[this.toolSel()]?.network ? [{ label: 'ctx.fetch', detail: '(url, init?) => { ok, status, json, text }', info: 'Solo https. Marca "Usa red" en la herramienta.', type: 'function' }] : []),
      ...(this.form?.memory ? [
        { label: 'ctx.memory.search', detail: '(query, limit?) => [{ text, meta, score }]', info: 'Busca en la memoria propia del agente.', type: 'function' },
        { label: 'ctx.memory.save', detail: '(text, meta?) => id', info: 'Guarda un recuerdo en la memoria del agente.', type: 'function' },
      ] : []),
    ];
    this.cacheSug = { clave, lista };
    return lista;
  }
  private cacheSug: { clave: string; lista: SugerenciaEditor[] } | null = null;

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

  // ─── Herramientas con IA y recomendadas ───────────────────────────────
  recomendadas = signal<SugerenciaTool[] | null>(null);
  cargandoSug = signal(false);
  modalTool = signal<{ agente: CustomAgent; resultado: HerramientaGenerada | null } | null>(null);
  generandoTool = signal(false);
  faseTool = signal('');
  pedidoTool = '';
  private sugDe = '';

  cargarSugerencias(a: CustomAgent, refrescar = false) {
    this.cargandoSug.set(true);
    this.api.getToolSuggestions(a.name, refrescar).subscribe({
      next: (r) => { this.cargandoSug.set(false); this.recomendadas.set(r.sugerencias); this.sugDe = a.name; },
      error: (e) => { this.cargandoSug.set(false); this.toast.error(e?.error?.error || 'No se pudieron sugerir herramientas'); },
    });
  }

  abrirToolIA(sg?: SugerenciaTool) {
    const a = this.actual();
    if (!a) return;
    this.pedidoTool = sg?.pedido || '';
    this.modalTool.set({ agente: a, resultado: null });
  }

  cerrarToolIA() {
    if (this.generandoTool() && !confirm('Se está creando la herramienta. ¿Cerrar y descartarla?')) return;
    this.modalTool.set(null);
  }

  generarTool(a: CustomAgent) {
    const pedido = this.pedidoTool.trim();
    if (pedido.length < 8) return;
    this.generandoTool.set(true);
    // El backend no transmite avance: fases aproximadas para que se note que está trabajando.
    const fases = ['Diseñando la herramienta…', 'Escribiendo el código…', 'Calculando los tests…', 'Probando en el sandbox…', 'Revisando los resultados…'];
    let i = 0; this.faseTool.set(fases[0]);
    const t = setInterval(() => { i = Math.min(i + 1, fases.length - 1); this.faseTool.set(fases[i]); }, 6000);
    this.api.generateAgentTool(a.name, pedido).subscribe({
      next: (r) => { clearInterval(t); this.generandoTool.set(false); const m = this.modalTool(); if (m) this.modalTool.set({ ...m, resultado: r }); },
      error: (e) => { clearInterval(t); this.generandoTool.set(false); this.toast.error(e?.error?.error || 'No se pudo crear la herramienta'); },
    });
  }

  /** Suma la herramienta generada al borrador del agente; con `guardarEn` además guarda. */
  async integrarTool(r: HerramientaGenerada, guardarEn?: CustomAgent) {
    if (!this.form) return;
    const existentes = new Set(this.form.tools.map((x) => x.name));
    let nombre = r.tool.name;
    for (let n = 2; existentes.has(nombre); n++) nombre = `${r.tool.name}_${n}`;
    this.form.tools.push({ ...JSON.parse(JSON.stringify(r.tool)), name: nombre });
    for (const e of r.envNuevas) if (!this.form.env.some((x) => x.name === e.name)) this.form.env.push({ ...e });
    const i = this.form.tools.length - 1;
    this.elegirTool(i);
    if (r.tests.length) this.estadoTests.set({ ...this.estadoTests(), [i]: { ok: this.contarOk(r), total: r.tests.length } });
    this.recomendadas.update((l) => l?.filter((s) => s.nombre !== r.tool.name && s.pedido !== this.pedidoTool.trim()) ?? l);
    this.modalTool.set(null);
    if (guardarEn) {
      const ok = await this.guardar(guardarEn);
      if (!ok) this.toast.error(`${nombre} quedó en el borrador: corrige lo que falló y guarda`);
    } else {
      this.toast.ok(`${nombre} agregada al borrador: guarda para integrarla (${this.atajo}+S)`);
    }
  }

  contarOk(r: HerramientaGenerada) { return r.tests.filter((x) => x.ok).length; }
  nombresEnv(r: HerramientaGenerada) { return r.envNuevas.map((e) => e.name).join(', '); }
  paramsDe(t: CustomToolDef) {
    const props = (t.parameters?.properties || {}) as Record<string, any>;
    const req: string[] = t.parameters?.required || [];
    return Object.entries(props).map(([nombre, v]) => ({ nombre, tipo: v?.type || 'any', descripcion: v?.description || '', requerido: req.includes(nombre) }));
  }

  // ─── Guardar / estado ─────────────────────────────────────────────────
  /** Guarda el agente (y los valores de variables escritos). Devuelve si quedó guardado. */
  guardar(a: CustomAgent): Promise<boolean> {
    if (!this.form) return Promise.resolve(false);
    if (this.errorParams()) { this.irPestana('tools'); this.toast.error('Hay parámetros con JSON inválido'); return Promise.resolve(false); }
    const sinNombre = this.form.tools.findIndex((t) => !/^[a-z][a-z0-9_]*$/.test(t.name));
    if (sinNombre >= 0) { this.irPestana('tools'); this.elegirTool(sinNombre); this.toast.error('Nombre de herramienta inválido: usa snake_case'); return Promise.resolve(false); }
    this.guardando.set(true);
    const { name, createdAt, createdBy, updatedAt, version, ...cambios } = this.form;
    return new Promise<boolean>((listo) => this.api.updateAgent(a.name, cambios).subscribe({
      next: (r) => {
        const patch: Record<string, string> = {};
        for (const e of this.form!.env) { const v = (this.envValores[e.name] || '').trim(); if (v && e.name) patch[`AGENT_${a.name.toUpperCase()}_${e.name.toUpperCase()}`] = v; }
        const fin = () => {
          this.guardando.set(false);
          this.form = JSON.parse(JSON.stringify(r.agent));
          this.original = JSON.stringify(r.agent);
          this.envValores = {};
          this.borrarBorrador(a.name);
          this.borradorPendiente.set(null);
          this.agents.set(this.agents().map((x) => (x.name === a.name ? r.agent : x)));
          this.version.update((v) => v + 1);
          this.toast.ok(`${r.agent.displayName} guardado (v${r.agent.version})`);
          this.cargarEnv();
          listo(true);
        };
        if (Object.keys(patch).length) this.api.saveEnv(patch).subscribe({ next: fin, error: () => { this.toast.error('Agente guardado, pero no se pudieron escribir las variables'); fin(); } });
        else fin();
      },
      // El backend corre los tests de las herramientas antes de guardar: el error dice cuál falló.
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); listo(false); },
    }));
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
      next: () => { this.toast.ok(`${a.displayName} eliminado`); this.borrarBorrador(a.name); this.form = null; this.preparado = null; this.agents.set(this.agents().filter((x) => x.name !== a.name)); this.router.navigate(['/agents']); },
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
