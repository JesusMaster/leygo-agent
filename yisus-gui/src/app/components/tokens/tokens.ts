import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, A2AToken, ToolDetalle, A2APeer } from '../../services/api.service';
import { ToolPickerComponent } from '../tool-picker/tool-picker';
import { ToastService } from '../../services/toast.service';

type Tab = 'entrantes' | 'salientes' | 'conectar';
interface Card { name?: string; url?: string; version?: string; protocolVersion?: string; skills?: Array<{ id: string; name: string }>; }

/**
 * A2A en ambos sentidos:
 *  - Entrantes: tokens con los que otros agentes le hablan a Yisus (cada uno con su alcance).
 *  - Salientes: agentes remotos a los que Yisus les escribe.
 *  - Conectar: URLs y ejemplos listos para configurar un cliente.
 * El valor de un token se muestra una sola vez, al crearlo.
 */
@Component({
  selector: 'app-tokens',
  imports: [FormsModule, RouterLink, ToolPickerComponent],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>A2A · agentes conectados</h2>
          <p class="sub">Quién puede hablarle a Yisus (y con qué herramientas) y a qué agentes les habla Yisus.</p>
        </div>
        @if (tab() === 'entrantes') { <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Nuevo token</button> }
        @if (tab() === 'salientes') { <button class="btn-primary" (click)="abrirPeer()"><i class="ph ph-plus"></i> Agregar agente</button> }
      </div>

      <div class="tabs">
        <button class="tab" [class.on]="tab() === 'entrantes'" (click)="ir('entrantes')"><i class="ph ph-arrow-down-left"></i> Nos hablan <span class="cnt">{{ activos() }}</span></button>
        <button class="tab" [class.on]="tab() === 'salientes'" (click)="ir('salientes')"><i class="ph ph-arrow-up-right"></i> Les hablamos <span class="cnt">{{ peers().length }}</span></button>
        <button class="tab" [class.on]="tab() === 'conectar'" (click)="ir('conectar')"><i class="ph ph-plugs-connected"></i> Cómo conectar</button>
      </div>

      @switch (tab()) {
        <!-- ─── Entrantes ───────────────────────────────────────── -->
        @case ('entrantes') {
          @if (tokens().length === 0) {
            <div class="card empty-state">
              <i class="ph ph-key"></i>
              <h3>Todavía no hay tokens</h3>
              <p>Crea uno por cada agente o integración que deba hablarle a Yisus. Sin al menos un token, el endpoint A2A responde 401.</p>
              <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Nuevo token</button>
            </div>
          } @else {
            <div class="lista card">
              @for (t of tokensOrdenados(); track t.name) {
                <div class="it" [class.off]="!t.enabled">
                  <label class="sw" [title]="t.enabled ? 'Activo — clic para revocar' : 'Revocado — clic para reactivar'">
                    <input type="checkbox" [checked]="t.enabled" (change)="alternar(t)" /><span></span>
                  </label>
                  <div class="it-main">
                    <div class="it-tit">{{ t.name }} <code class="pref">{{ t.preview }}</code></div>
                    <div class="it-sub">
                      @if (t.tools.length === 0) { <span class="chip">solo conversa (sin herramientas)</span> }
                      @else {
                        @for (tool of t.tools.slice(0, 4); track tool) { <span class="chip" [title]="tool">{{ tituloDe(tool) }}</span> }
                        @if (t.tools.length > 4) { <span class="chip">+{{ t.tools.length - 4 }}</span> }
                      }
                      @if (fueraDelTecho(t).length) { <span class="chip warn" [title]="'No publicadas en el canal A2A: ' + fueraDelTecho(t).join(', ')"><i class="ph ph-warning"></i> {{ fueraDelTecho(t).length }} sin publicar</span> }
                    </div>
                  </div>
                  <div class="it-uso">
                    <small>Último uso</small>
                    <b>{{ t.last_used_at ? hace(t.last_used_at) : 'nunca' }}</b>
                    <small>creado {{ hace(t.created_at) }}</small>
                  </div>
                  <div class="it-acts">
                    <button class="btn-secondary sm" (click)="editar(t)"><i class="ph ph-sliders"></i> Alcance</button>
                    <button class="btn-icon" title="Eliminar" (click)="eliminar(t)"><i class="ph ph-trash"></i></button>
                  </div>
                </div>
              }
            </div>
            <p class="nota"><i class="ph ph-info"></i> Todas las herramientas publicadas se montan en el agente público; cada token solo puede <em>usar</em> las suyas. Los cambios de alcance aplican al instante. Lo que el canal A2A publica se define en <a routerLink="/channels">Canales y tools</a>.</p>
          }
        }

        <!-- ─── Salientes ───────────────────────────────────────── -->
        @case ('salientes') {
          @if (peers().length === 0) {
            <div class="card empty-state">
              <i class="ph ph-robot"></i>
              <h3>Sin agentes remotos</h3>
              <p>Agrega la Agent Card de otro agente (por ejemplo OpenClaw) para que Yisus pueda escribirle desde el chat, usarlo como destino de tareas y devolverle lo que escaló.</p>
              <button class="btn-primary" (click)="abrirPeer()"><i class="ph ph-plus"></i> Agregar agente</button>
            </div>
          } @else {
            <div class="lista card">
              @for (p of peers(); track p.name) {
                <div class="it" [class.off]="!p.enabled">
                  <label class="sw" [title]="p.enabled ? 'Habilitado — clic para deshabilitar' : 'Deshabilitado — clic para habilitar'">
                    <input type="checkbox" [checked]="p.enabled" (change)="alternarPeer(p)" /><span></span>
                  </label>
                  <div class="it-main">
                    <div class="it-tit">
                      {{ p.name }}
                      @if (p.last_error) { <span class="estado err" [title]="p.last_error"><i class="ph ph-warning-circle"></i> error</span> }
                      @else if (p.last_used_at) { <span class="estado ok"><i class="ph ph-check-circle"></i> ok</span> }
                    </div>
                    <div class="it-sub">
                      <code class="url" [title]="p.card_url">{{ hostDe(p.card_url) }}</code>
                      @if (p.token_name) { <span class="chip" title="Token con el que este agente nos escribe"><i class="ph ph-arrow-down-left"></i> nos escribe como {{ p.token_name }}</span> }
                      @if (p.tokenPreview) { <span class="chip" title="Token que usamos para escribirle"><i class="ph ph-key"></i> {{ p.tokenPreview }}</span> }
                    </div>
                    @if (p.last_error) { <div class="err-txt">{{ p.last_error }}</div> }
                    @if (prueba()?.peer === p.name) {
                      <div class="prueba" [class.bad]="!prueba()!.ok">
                        @if (prueba()!.ok) { <i class="ph ph-check-circle"></i> "{{ prueba()!.agente }}" · {{ prueba()!.skills }} skills · protocolo {{ prueba()!.version || '?' }} }
                        @else { <i class="ph ph-warning-circle"></i> {{ prueba()!.error }} }
                      </div>
                    }
                  </div>
                  <div class="it-uso">
                    <small>Último uso</small>
                    <b>{{ p.last_used_at ? hace(p.last_used_at) : 'nunca' }}</b>
                  </div>
                  <div class="it-acts">
                    <button class="btn-secondary sm" [disabled]="probando() === p.name" (click)="probarPeer(p)"><i class="ph" [class.ph-plugs-connected]="probando() !== p.name" [class.ph-spinner]="probando() === p.name"></i> Probar</button>
                    <button class="btn-secondary sm" (click)="abrirMensaje(p)"><i class="ph ph-paper-plane-tilt"></i> Escribir</button>
                    <button class="btn-icon" title="Eliminar" (click)="eliminarPeer(p)"><i class="ph ph-trash"></i></button>
                  </div>
                </div>
              }
            </div>
          }
        }

        <!-- ─── Cómo conectar ───────────────────────────────────── -->
        @case ('conectar') {
          <div class="card">
            <h3>Datos para el cliente</h3>
            <p class="card-sub">Lo que necesita otro agente para hablarle a Yisus. La Agent Card es pública; el RPC exige un token.</p>
            <div class="dato"><span>Agent Card</span><code>{{ cardUrl() }}</code><button class="btn-icon" title="Copiar" (click)="copiar(cardUrl())"><i class="ph ph-copy"></i></button></div>
            <div class="dato"><span>Endpoint RPC</span><code>{{ rpcUrl() }}</code><button class="btn-icon" title="Copiar" (click)="copiar(rpcUrl())"><i class="ph ph-copy"></i></button></div>
            <div class="dato"><span>Autenticación</span><code>Authorization: Bearer &lt;token&gt;</code><small>o <code>X-API-Key: &lt;token&gt;</code></small></div>
            <div class="dato"><span>Versión</span><code>A2A-Version: 1.0</code><small>cabecera obligatoria</small></div>
            @if (card(); as c) {
              <div class="card-info"><i class="ph ph-identification-card"></i> La card anuncia a <b>{{ c.name }}</b> con {{ c.skills?.length || 0 }} skill(s)@if (c.url && c.url !== rpcUrl()) { · <span class="warn">el RPC anunciado es {{ c.url }}</span> }.</div>
            } @else if (cardError()) {
              <div class="card-info warn"><i class="ph ph-warning"></i> No se pudo leer la Agent Card: {{ cardError() }}</div>
            }
          </div>
          <div class="card">
            <div class="row" style="justify-content:space-between;align-items:center">
              <div>
                <h3 style="margin:0">Ejemplo con curl</h3>
                <p class="card-sub" style="margin:2px 0 0">Envía un mensaje y devuelve la tarea con la respuesta.</p>
              </div>
              <button class="btn-secondary sm" (click)="copiar(curl())"><i class="ph ph-copy"></i> Copiar</button>
            </div>
            <pre class="code">{{ curl() }}</pre>
            <p class="card-sub" style="margin:8px 0 0">Para OpenClaw hay una skill lista en <code>docs/openclaw/yisus-remoto.SKILL.md</code>: define <code>YISUS_A2A_TOKEN</code> en su entorno.</p>
          </div>
        }
      }
    </div>

    <!-- ─── Modal: nuevo token / alcance ───────────────────────────── -->
    @if (modalToken(); as m) {
      <div class="modal-backdrop" (click)="cerrarToken()">
        <div class="modal ancho" (click)="$event.stopPropagation()">
          <div class="modal-head">
            <h3>{{ m.creado ? 'Token creado' : m.editando ? 'Alcance de "' + m.editando + '"' : 'Nuevo token' }}</h3>
            <button class="btn-icon" (click)="cerrarToken()"><i class="ph ph-x"></i></button>
          </div>
          @if (m.creado) {
            <div class="modal-body">
              <div class="creado">
                <p><i class="ph ph-warning"></i> Cópialo ahora: <b>no se vuelve a mostrar</b>. Si se pierde, elimínalo y crea otro.</p>
                <div class="dato"><code class="tok">{{ m.creado }}</code><button class="btn-primary sm" (click)="copiar(m.creado)"><i class="ph ph-copy"></i> Copiar</button></div>
              </div>
              <div class="field" style="margin-top:14px"><span>Listo para usar</span></div>
              <pre class="code">{{ curl(m.creado) }}</pre>
              <button class="btn-secondary sm" (click)="copiar(curl(m.creado))"><i class="ph ph-copy"></i> Copiar ejemplo</button>
            </div>
            <div class="modal-foot"><button class="btn-primary" (click)="cerrarToken()">Listo</button></div>
          } @else {
            <div class="modal-body">
              @if (!m.editando) {
                <label class="field">
                  <span>Nombre de la integración</span>
                  <input type="text" [(ngModel)]="m.nombre" placeholder="ej: openclaw, partner-acme" autofocus />
                  <small class="hint">Sirve para reconocerla en el consumo y para saber qué revocas después. Solo letras, números, guiones.</small>
                </label>
              }
              <div class="field"><span>Qué puede usar ({{ m.tools.length }} de {{ detalle().length }})</span></div>
              <div class="presets">
                <button type="button" class="ej" (click)="setTools([])">Solo conversar</button>
                <button type="button" class="ej" (click)="setTools(publicas())">Solo conocimiento público</button>
                <button type="button" class="ej" (click)="setTools(todasNombres())">Todo lo publicado</button>
              </div>
              <app-tool-picker [catalogo]="detalle()" [seleccion]="m.tools" (seleccionChange)="setTools($event)" />
              <small class="hint">Solo aparecen las herramientas publicadas en el canal A2A. Si el agente pide otra, recibe una negativa explícita.</small>
            </div>
            <div class="modal-foot">
              <button class="btn-secondary" (click)="cerrarToken()">Cancelar</button>
              @if (m.editando) { <button class="btn-primary" [disabled]="!hayCambios()" (click)="guardarAlcance()">Guardar alcance</button> }
              @else { <button class="btn-primary" [disabled]="!nombreValido(m.nombre)" (click)="crear()">Crear token</button> }
            </div>
          }
        </div>
      </div>
    }

    <!-- ─── Modal: agente remoto ───────────────────────────────────── -->
    @if (modalPeer()) {
      <div class="modal-backdrop" (click)="modalPeer.set(false)">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head"><h3>Agregar agente remoto</h3><button class="btn-icon" (click)="modalPeer.set(false)"><i class="ph ph-x"></i></button></div>
          <div class="modal-body">
            <label class="field"><span>Nombre</span><input type="text" [(ngModel)]="peerForm.name" placeholder="openclaw" /></label>
            <label class="field"><span>URL de su Agent Card</span><input type="text" [(ngModel)]="peerForm.card_url" placeholder="https://openclaw.tu-dominio/.well-known/agent-card.json" /></label>
            <label class="field"><span>Token que él nos pide (opcional)</span><input type="password" [(ngModel)]="peerForm.token" placeholder="Bearer que presentamos al escribirle" /></label>
            <label class="field">
              <span>Token con el que él nos escribe (opcional)</span>
              <select [(ngModel)]="peerForm.token_name">
                <option value="">— sin asociar —</option>
                @for (t of tokensEntrantes(); track t) { <option [value]="t">{{ t }}</option> }
              </select>
              <small class="hint">Así se le devuelven las resoluciones de lo que escale por A2A.</small>
            </label>
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="modalPeer.set(false)">Cancelar</button>
            <button class="btn-primary" [disabled]="!peerForm.name.trim() || !peerForm.card_url.trim()" (click)="crearPeer()">Agregar y probar</button>
          </div>
        </div>
      </div>
    }

    <!-- ─── Modal: escribirle a un agente ──────────────────────────── -->
    @if (chat(); as c) {
      <div class="modal-backdrop" (click)="chat.set(null)">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head"><h3>Escribirle a {{ c.peer }}</h3><button class="btn-icon" (click)="chat.set(null)"><i class="ph ph-x"></i></button></div>
          <div class="modal-body">
            <label class="field"><span>Mensaje</span><textarea rows="3" [(ngModel)]="c.texto" (keydown.meta.enter)="enviarMensaje()" (keydown.control.enter)="enviarMensaje()"></textarea></label>
            @if (c.enviando) { <div class="resp dim"><i class="ph ph-spinner"></i> Esperando respuesta…</div> }
            @if (c.respuesta) { <div class="resp"><small>Respuesta</small><div>{{ c.respuesta }}</div></div> }
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="chat.set(null)">Cerrar</button>
            <button class="btn-primary" [disabled]="!c.texto.trim() || c.enviando" (click)="enviarMensaje()"><i class="ph ph-paper-plane-tilt"></i> Enviar</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .tabs { display: flex; gap: 4px; margin-bottom: 14px; border-bottom: 1px solid var(--border-light); overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
    .tabs::-webkit-scrollbar { display: none; }
    .tab { display: inline-flex; align-items: center; gap: 7px; padding: 10px 12px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--text-dim); font-size: 14px; cursor: pointer; white-space: nowrap; margin-bottom: -1px; }
    .tab:hover { color: var(--text-main); }
    .tab.on { color: var(--accent-primary); border-bottom-color: var(--accent-primary); }
    .cnt { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--bg-main); }
    .tab.on .cnt { background: rgba(129,140,248,.18); }

    .lista { padding: 0; }
    .it { display: grid; grid-template-columns: 40px minmax(0, 1fr) 120px auto; gap: 14px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--border-light); }
    .it:last-child { border-bottom: 0; }
    .it.off .it-main { opacity: .55; }
    .it-tit { font-weight: 600; font-size: 14.5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .pref { font-size: 11.5px; font-weight: 400; color: var(--text-dim); }
    .it-sub { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
    .it-uso { display: flex; flex-direction: column; font-size: 13px; }
    .it-uso small { font-size: 11px; color: var(--text-dim); }
    .it-acts { display: flex; gap: 6px; align-items: center; }
    .chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; background: var(--bg-main); border: 1px solid var(--border-light); font-size: 12px; color: var(--text-dim); }
    .chip.warn { color: var(--warn); border-color: rgba(245,158,11,.4); }
    .estado { font-size: 11.5px; font-weight: 500; display: inline-flex; gap: 4px; align-items: center; }
    .estado.ok { color: var(--ok); } .estado.err { color: var(--danger); }
    .url { font-size: 12px; color: var(--text-dim); }
    .err-txt { font-size: 12px; color: var(--danger); margin-top: 6px; }
    .prueba { margin-top: 8px; font-size: 12.5px; padding: 6px 10px; border-radius: 8px; background: rgba(16,185,129,.08); color: var(--ok); display: inline-flex; gap: 6px; align-items: center; }
    .prueba.bad { background: rgba(239,68,68,.08); color: var(--danger); }
    .sw { position: relative; width: 36px; height: 20px; display: inline-block; }
    .sw input { opacity: 0; width: 0; height: 0; }
    .sw span { position: absolute; inset: 0; border-radius: 999px; background: var(--border-light); transition: background .15s; cursor: pointer; }
    .sw span::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .sw input:checked + span { background: var(--ok); }
    .sw input:checked + span::after { transform: translateX(16px); }
    .btn-primary.sm, .btn-secondary.sm { padding: 6px 11px; font-size: 12.5px; }
    .nota { font-size: 12.5px; color: var(--text-dim); margin-top: 10px; line-height: 1.5; }
    .nota i { margin-right: 4px; vertical-align: -1px; }
    .nota a { color: var(--accent-primary); }
    .empty-state { text-align: center; padding: 44px 24px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .empty-state > i { font-size: 38px; color: var(--accent-primary); }
    .empty-state p { color: var(--text-dim); max-width: 60ch; margin: 0 0 8px; }

    .dato { display: grid; grid-template-columns: 120px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-light); font-size: 13px; }
    .dato > span { color: var(--text-dim); font-size: 12px; }
    .dato code { word-break: break-all; }
    .dato small { color: var(--text-dim); font-size: 12px; }
    .card-info { margin-top: 12px; font-size: 13px; }
    .card-info i { margin-right: 4px; vertical-align: -1px; }
    .card-info.warn, .warn { color: var(--warn); }
    .code { margin: 10px 0 0; padding: 12px 14px; border-radius: 10px; background: var(--bg-main); border: 1px solid var(--border-light); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
    .code + .btn-secondary { margin-top: 8px; }

    .modal.ancho { max-width: 720px; }
    .presets { display: flex; gap: 6px; flex-wrap: wrap; margin: -4px 0 10px; }
    .ej { border: 1px dashed var(--border-light); background: none; color: var(--text-dim); border-radius: 8px; padding: 5px 10px; font-size: 12.5px; cursor: pointer; }
    .ej:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
    .hint { display: block; color: var(--text-dim); font-size: 12px; margin-top: 6px; }
    .creado { border: 1px solid rgba(245,158,11,.45); background: rgba(245,158,11,.07); border-radius: 10px; padding: 12px 14px; }
    .creado p { margin: 0 0 8px; font-size: 13px; }
    .creado p i { color: var(--warn); margin-right: 4px; }
    .creado .dato { grid-template-columns: minmax(0, 1fr) auto; border: 0; padding: 0; }
    .tok { font-size: 13px; padding: 8px 10px; background: var(--bg-main); border-radius: 8px; }
    .resp { margin-top: 10px; padding: 10px 12px; border-radius: 10px; background: var(--bg-main); border: 1px solid var(--border-light); font-size: 13.5px; white-space: pre-wrap; }
    .resp small { display: block; color: var(--text-dim); font-size: 11px; margin-bottom: 4px; }
    .dim { color: var(--text-dim); }
    .ph-spinner { animation: spin 1s linear infinite; display: inline-block; } @keyframes spin { to { transform: rotate(360deg); } }

    @media (max-width: 760px) {
      .it { grid-template-columns: 40px minmax(0, 1fr); row-gap: 8px; }
      .it-uso { grid-column: 2; flex-direction: row; gap: 6px; align-items: baseline; }
      .it-acts { grid-column: 2; flex-wrap: wrap; }
      .dato { grid-template-columns: 1fr auto; } .dato > span { grid-column: 1 / -1; }
      .tab { padding: 10px 9px; font-size: 13.5px; gap: 5px; }
      .it { padding-left: 10px; }
    }
  `],
})
export class TokensComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  tab = signal<Tab>(((): Tab => { try { return (localStorage.getItem('yisus_a2a_tab') as Tab) || 'entrantes'; } catch { return 'entrantes'; } })());
  tokens = signal<A2AToken[]>([]);
  disponibles = signal<string[]>([]);
  detalle = signal<ToolDetalle[]>([]);
  peers = signal<A2APeer[]>([]);
  tokensEntrantes = signal<string[]>([]);
  probando = signal<string | null>(null);
  prueba = signal<{ peer: string; ok: boolean; agente?: string; skills?: number; version?: string; error?: string } | null>(null);
  card = signal<Card | null>(null);
  cardError = signal<string | null>(null);

  modalToken = signal<{ nombre: string; tools: string[]; editando: string | null; original: string[]; creado: string | null } | null>(null);
  modalPeer = signal(false);
  peerForm = { name: '', card_url: '', token: '', token_name: '' };
  chat = signal<{ peer: string; texto: string; respuesta: string | null; enviando: boolean } | null>(null);

  activos = computed(() => this.tokens().filter((t) => t.enabled).length);
  tokensOrdenados = computed(() => [...this.tokens()].sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || ((b.last_used_at || 0) - (a.last_used_at || 0))));
  todasNombres = computed(() => this.detalle().map((d) => d.name));
  publicas = computed(() => this.detalle().filter((d) => d.grupo === 'publico').map((d) => d.name));
  cardUrl = computed(() => `${this.api.baseUrl}/.well-known/agent-card.json`);
  rpcUrl = computed(() => this.card()?.url || `${this.api.baseUrl}/a2a/v1`);

  constructor() { this.load(); this.cargarCard(); }

  ir(t: Tab) {
    this.tab.set(t); try { localStorage.setItem('yisus_a2a_tab', t); } catch {}
    if (t === 'conectar') this.cargarCard();
  }

  load() {
    this.api.getTokens().subscribe({ next: (r) => this.tokens.set(r.tokens), error: () => this.toast.error('No se pudieron cargar los tokens') });
    this.api.getPeers().subscribe({ next: (r) => { this.peers.set(r.peers || []); this.tokensEntrantes.set(r.tokensEntrantes || []); }, error: () => {} });
    this.api.getDisponiblesA2A().subscribe({
      next: (r) => {
        this.disponibles.set(r.disponibles);
        const publicadas = new Set(r.disponibles);
        const det = r.detalle?.length ? r.detalle : r.disponibles.map((name) => ({ name, titulo: name, descripcion: '', grupo: 'otros', etiqueta: 'Herramientas' }));
        this.detalle.set(det.filter((d) => publicadas.has(d.name)));
      },
      error: () => {},
    });
  }
  private cargarCard() {
    fetch(this.cardUrl(), { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((c: Card) => this.card.set(c)).catch((e) => this.cardError.set(e?.message || 'sin respuesta'));
  }

  // ─── Presentación ────────────────────────────────────────────────────
  tituloDe(tool: string) { return this.detalle().find((d) => d.name === tool)?.titulo || tool; }
  fueraDelTecho(t: A2AToken) { const s = new Set(this.disponibles()); return this.disponibles().length ? t.tools.filter((x) => !s.has(x)) : []; }
  hostDe(u: string) { try { const x = new URL(u); return x.host + (x.pathname !== '/.well-known/agent-card.json' ? x.pathname : ''); } catch { return u; } }
  hace(ms: number) {
    const diff = Date.now() - ms, d = new Date(ms);
    const hora = d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const dias = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
    if (diff < 60_000) return 'recién';
    if (diff < 3600_000) return `hace ${Math.round(diff / 60_000)} min`;
    if (dias === 0) return `hoy ${hora}`;
    if (dias === -1) return `ayer ${hora}`;
    if (dias > -7) return `${d.toLocaleDateString('es-CL', { weekday: 'short' })} ${hora}`;
    return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  }
  curl(token = '<TOKEN>') {
    return `curl -s ${this.rpcUrl()} \\
  -H "Content-Type: application/json" \\
  -H "A2A-Version: 1.0" \\
  -H "Authorization: Bearer ${token}" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"Hola, ¿qué puedes hacer?"}]}}}'`;
  }
  copiar(v: string) { navigator.clipboard.writeText(v).then(() => this.toast.ok('Copiado'), () => this.toast.error('No se pudo copiar')); }

  // ─── Tokens ──────────────────────────────────────────────────────────
  nombreValido(n: string) { return /^[a-zA-Z0-9_.-]{2,40}$/.test((n || '').trim()); }
  abrirNuevo() { this.modalToken.set({ nombre: '', tools: this.publicas(), editando: null, original: [], creado: null }); }
  editar(t: A2AToken) { this.modalToken.set({ nombre: t.name, tools: [...t.tools], editando: t.name, original: [...t.tools], creado: null }); }
  setTools(t: string[]) { const m = this.modalToken(); if (m) this.modalToken.set({ ...m, tools: [...t] }); }
  hayCambios() { const m = this.modalToken(); return !!m && [...m.tools].sort().join(',') !== [...m.original].sort().join(','); }
  cerrarToken() { this.modalToken.set(null); }
  crear() {
    const m = this.modalToken()!;
    this.api.createToken(m.nombre.trim(), m.tools).subscribe({
      next: (r) => { this.modalToken.set({ ...m, creado: r.token }); this.load(); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo crear el token'),
    });
  }
  guardarAlcance() {
    const m = this.modalToken()!;
    this.api.updateToken(m.editando!, { tools: m.tools }).subscribe({
      next: () => { this.modalToken.set(null); this.load(); this.toast.ok('Alcance actualizado'); },
      error: () => this.toast.error('No se pudo actualizar'),
    });
  }
  alternar(t: A2AToken) {
    if (t.enabled && !confirm(`¿Revocar "${t.name}"? Deja de entrar al instante (puedes reactivarlo después).`)) { this.load(); return; }
    this.api.updateToken(t.name, { enabled: !t.enabled }).subscribe({
      next: () => { this.load(); this.toast.ok(t.enabled ? 'Token revocado' : 'Token reactivado'); },
      error: () => { this.load(); this.toast.error('No se pudo cambiar el estado'); },
    });
  }
  eliminar(t: A2AToken) {
    if (!confirm(`¿Eliminar el token "${t.name}"? La integración que lo use deja de funcionar de inmediato.`)) return;
    this.api.deleteToken(t.name).subscribe({ next: () => { this.load(); this.toast.ok('Token eliminado'); }, error: () => this.toast.error('No se pudo eliminar') });
  }

  // ─── Agentes remotos ─────────────────────────────────────────────────
  abrirPeer() { this.peerForm = { name: '', card_url: '', token: '', token_name: '' }; this.modalPeer.set(true); }
  crearPeer() {
    const f = this.peerForm;
    const nombre = f.name.trim();
    this.api.createPeer({ name: nombre, card_url: f.card_url.trim(), token: f.token.trim() || undefined, token_name: f.token_name || undefined }).subscribe({
      next: () => { this.modalPeer.set(false); this.load(); this.toast.ok('Agente agregado'); const p = { name: nombre } as A2APeer; this.probarPeer(p); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo agregar'),
    });
  }
  probarPeer(p: A2APeer) {
    this.probando.set(p.name); this.prueba.set(null);
    this.api.testPeer(p.name).subscribe({
      next: (r) => { this.probando.set(null); this.prueba.set({ peer: p.name, ...r }); this.load(); },
      error: () => { this.probando.set(null); this.prueba.set({ peer: p.name, ok: false, error: 'No se pudo probar' }); },
    });
  }
  abrirMensaje(p: A2APeer) { this.chat.set({ peer: p.name, texto: 'Hola, soy Yisus. ¿Qué puedes hacer?', respuesta: null, enviando: false }); }
  enviarMensaje() {
    const c = this.chat(); if (!c || !c.texto.trim() || c.enviando) return;
    this.chat.set({ ...c, enviando: true, respuesta: null });
    this.api.sendToPeer(c.peer, c.texto.trim(), true).subscribe({
      next: (r) => { const a = this.chat(); if (a) this.chat.set({ ...a, enviando: false, respuesta: r.texto || '(sin texto)' }); this.load(); },
      error: (e) => { const a = this.chat(); if (a) this.chat.set({ ...a, enviando: false, respuesta: `Error: ${e?.error?.error || 'no respondió'}` }); this.load(); },
    });
  }
  alternarPeer(p: A2APeer) { this.api.updatePeer(p.name, { enabled: !p.enabled }).subscribe({ next: () => this.load(), error: () => { this.load(); this.toast.error('No se pudo cambiar'); } }); }
  eliminarPeer(p: A2APeer) {
    if (!confirm(`¿Eliminar el agente remoto "${p.name}"?`)) return;
    this.api.deletePeer(p.name).subscribe({ next: () => { this.load(); this.toast.ok('Eliminado'); }, error: () => this.toast.error('No se pudo eliminar') });
  }
}
