import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, A2AToken, ToolDetalle, A2APeer } from '../../services/api.service';
import { ToolPickerComponent } from '../tool-picker/tool-picker';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';

/**
 * Tokens A2A: aislamiento por integración.
 *
 * Cada token es una identidad distinta con su propio set de herramientas. El valor
 * se muestra una única vez al crearlo — después solo queda el prefijo, porque el
 * backend no tiene por qué devolverlo de nuevo.
 */
@Component({
  selector: 'app-tokens',
  imports: [FormsModule, FriendlyDatePipe, ToolPickerComponent],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Tokens A2A</h2>
          <p class="sub">
            Quien llega por el canal entre agentes solo puede usar lo que su token declare.
            Un token sin herramientas conversa pero no ejecuta nada; uno revocado deja de entrar al instante.
          </p>
        </div>
        <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Nuevo token</button>
      </div>

      @if (nuevoToken()) {
        <div class="card" style="border-color: var(--ok)">
          <h3><i class="ph ph-check-circle"></i> Token creado</h3>
          <p class="card-sub">Cópialo ahora. No se vuelve a mostrar: si lo pierdes, hay que revocarlo y crear otro.</p>
          <div class="row">
            <code style="flex:1; padding:12px; background:var(--bg-input); border-radius:8px; word-break:break-all">{{ nuevoToken() }}</code>
            <button class="btn-secondary" (click)="copiar(nuevoToken()!)"><i class="ph ph-copy"></i> Copiar</button>
            <button class="btn-icon" (click)="nuevoToken.set(null)"><i class="ph ph-x"></i></button>
          </div>
        </div>
      }

      @if (creando()) {
        <div class="card">
          <h3>Nuevo token</h3>
          <p class="card-sub">Ponle el nombre de la integración que lo va a usar, para saber qué revocas después.</p>
          <label class="field">
            <span>Nombre</span>
            <input type="text" [(ngModel)]="nombre" placeholder="ej: agente-soporte, partner-acme" />
          </label>
          <label class="field">
            <span>Herramientas habilitadas ({{ toolsNuevo().length }})</span>
          </label>
          <p class="card-sub" style="margin-top:-8px">
            Aparecen las que el canal A2A tiene publicadas. Todas se montan en el agente
            público: lo que decide este token es cuáles puede <em>usar</em>. Si intenta otra,
            recibe una negativa explícita en vez de un silencio.
            Para publicar o retirar skills del canal, ve a <strong>Canales y tools</strong>.
          </p>
          <app-tool-picker [catalogo]="detalle()" [seleccion]="toolsNuevo()" (seleccionChange)="toolsNuevo.set($event)" />
          <div class="row" style="margin-top:16px">
            <span class="spacer"></span>
            <button class="btn-secondary" (click)="creando.set(false)">Cancelar</button>
            <button class="btn-primary" [disabled]="!nombre.trim()" (click)="crear()">Crear token</button>
          </div>
        </div>
      }

      <div class="card">
        <h3>Tokens activos</h3>
        <p class="card-sub">El alcance se puede editar en caliente: no requiere reiniciar el servicio.</p>

        @if (tokens().length === 0) {
          <div class="empty">Todavía no hay tokens. Sin al menos uno, el endpoint /a2a/v1 no se monta.</div>
        } @else {
          <table>
            <tr>
              <th>Nombre</th><th>Token</th><th>Herramientas</th><th>Último uso</th><th>Estado</th><th></th>
            </tr>
            @for (t of tokens(); track t.name) {
              <tr [class.editing]="editando() === t.name">
                <td><strong>{{ t.name }}</strong><br><span style="color:var(--text-dim);font-size:12px">creado {{ t.created_at | friendlyDate }}</span></td>
                <td class="mono" style="color:var(--text-dim)">{{ t.preview }}</td>
                <td>
                  @if (t.tools.length === 0) {
                    <span class="badge dim">sin herramientas</span>
                  } @else {
                    <div class="chips">
                      @for (tool of t.tools; track tool) {
                        <span class="chip readonly" [title]="tituloDe(tool)">{{ tool }}</span>
                      }
                    </div>
                  }
                </td>
                <td style="color:var(--text-dim)">{{ t.last_used_at | friendlyDate }}</td>
                <td>
                  @if (t.enabled) { <span class="badge ok">activo</span> } @else { <span class="badge danger">revocado</span> }
                </td>
                <td>
                  <div class="row">
                    <button class="btn-icon" title="Editar alcance" (click)="editar(t)"><i class="ph ph-pencil-simple"></i></button>
                    <button class="btn-icon" [title]="t.enabled ? 'Revocar' : 'Reactivar'" (click)="alternar(t)">
                      <i class="ph" [class.ph-prohibit]="t.enabled" [class.ph-check-circle]="!t.enabled"></i>
                    </button>
                    <button class="btn-icon" title="Eliminar" (click)="eliminar(t)"><i class="ph ph-trash"></i></button>
                  </div>
                </td>
              </tr>
              @if (editando() === t.name) {
                <tr class="editor-row">
                  <td colspan="6">
                    <div class="editor-head">
                      <div>
                        <strong>Alcance de "{{ t.name }}"</strong>
                        <p class="card-sub" style="margin:2px 0 0">
                          Todas las herramientas publicadas se montan en el agente público; este token solo puede <em>usar</em> las marcadas.
                          Si intenta otra, recibe una negativa explícita.
                        </p>
                      </div>
                      <div class="row">
                        <button class="btn-secondary" (click)="editando.set(null)">Cancelar</button>
                        <button class="btn-primary" [disabled]="!hayCambios(t)" (click)="guardarAlcance(t)">
                          <i class="ph ph-floppy-disk"></i> Guardar alcance
                        </button>
                      </div>
                    </div>
                    <app-tool-picker [catalogo]="detalle()" [seleccion]="toolsEdit()" (seleccionChange)="toolsEdit.set($event)" />
                  </td>
                </tr>
              }
            }
          </table>
        }
      </div>

      <!-- ─── Agentes remotos: Yisus como cliente A2A ─────────────────────── -->
      <div class="card">
        <div class="page-head" style="margin-bottom:8px">
          <div>
            <h3>Agentes remotos</h3>
            <p class="card-sub" style="margin:0">
              A2A es de ida y vuelta: acá van los agentes a los que Yisus puede <em>escribir</em> (OpenClaw, por ejemplo).
              Se usan desde el chat (<code>a2a_send_message</code>), como canal de entrega de tareas programadas,
              y para devolverle a ese agente las resoluciones de lo que escaló.
            </p>
          </div>
          <button class="btn-secondary" (click)="creandoPeer.set(!creandoPeer())"><i class="ph ph-plus"></i> Agregar agente</button>
        </div>

        @if (creandoPeer()) {
          <div class="peer-form">
            <label class="field"><span>Nombre</span><input type="text" [(ngModel)]="peerForm.name" placeholder="openclaw" /></label>
            <label class="field"><span>URL de su Agent Card</span><input type="text" [(ngModel)]="peerForm.card_url" placeholder="https://openclaw.tu-dominio/.well-known/agent-card.json" /></label>
            <label class="field"><span>Token que él nos pide (Bearer)</span><input type="password" [(ngModel)]="peerForm.token" placeholder="opcional" /></label>
            <label class="field">
              <span>Token con el que él nos escribe</span>
              <select [(ngModel)]="peerForm.token_name">
                <option value="">— sin asociar —</option>
                @for (t of tokensEntrantes(); track t) { <option [value]="t">{{ t }}</option> }
              </select>
              <small class="hint">Sirve para reconocerlo: si escala algo por A2A, la resolución se le devuelve por este canal.</small>
            </label>
            <div class="row" style="grid-column: 1 / -1">
              <span class="spacer"></span>
              <button class="btn-secondary" (click)="creandoPeer.set(false)">Cancelar</button>
              <button class="btn-primary" [disabled]="!peerForm.name.trim() || !peerForm.card_url.trim()" (click)="crearPeer()">Guardar</button>
            </div>
          </div>
        }

        @if (peers().length === 0) {
          <div class="empty">Sin agentes remotos. Agrega la Agent Card de OpenClaw para que Yisus pueda hablarle.</div>
        } @else {
          <table>
            <tr><th>Nombre</th><th>Agent Card</th><th>Nos escribe como</th><th>Último uso</th><th>Estado</th><th></th></tr>
            @for (p of peers(); track p.name) {
              <tr>
                <td><strong>{{ p.name }}</strong>@if (p.tokenPreview) {<br><span class="mono" style="font-size:12px;color:var(--text-dim)">{{ p.tokenPreview }}</span>}</td>
                <td><code style="font-size:12px;word-break:break-all">{{ p.card_url }}</code>
                  @if (p.last_error) { <br><span style="font-size:12px;color:var(--danger)">{{ p.last_error }}</span> }
                </td>
                <td style="color:var(--text-dim)">{{ p.token_name || '—' }}</td>
                <td style="color:var(--text-dim)">{{ p.last_used_at | friendlyDate }}</td>
                <td>@if (p.enabled) { <span class="badge ok">activo</span> } @else { <span class="badge dim">deshabilitado</span> }</td>
                <td>
                  <div class="row">
                    <button class="btn-icon" title="Probar conexión" [disabled]="probando() === p.name" (click)="probarPeer(p)"><i class="ph" [class.ph-plugs-connected]="probando() !== p.name" [class.ph-circle-notch]="probando() === p.name"></i></button>
                    <button class="btn-icon" title="Enviar mensaje de prueba" (click)="mensajePeer(p)"><i class="ph ph-paper-plane-tilt"></i></button>
                    <button class="btn-icon" [title]="p.enabled ? 'Deshabilitar' : 'Habilitar'" (click)="alternarPeer(p)"><i class="ph" [class.ph-prohibit]="p.enabled" [class.ph-check-circle]="!p.enabled"></i></button>
                    <button class="btn-icon" title="Eliminar" (click)="eliminarPeer(p)"><i class="ph ph-trash"></i></button>
                  </div>
                </td>
              </tr>
            }
          </table>
          @if (respuestaPeer()) {
            <div style="margin-top:12px;padding:12px;background:var(--bg-input);border-radius:8px;border:1px solid var(--border-light)">
              <span style="font-size:12px;color:var(--text-dim)">Respuesta de {{ respuestaPeer()!.peer }}</span>
              <p style="white-space:pre-wrap;margin-top:4px;font-size:14px">{{ respuestaPeer()!.texto }}</p>
            </div>
          }
        }
      </div>

      <div class="card">
        <h3>Cómo se usa</h3>
        <p class="card-sub">El cliente A2A presenta el token en cualquiera de estas dos formas:</p>
        <code style="display:block;padding:12px;background:var(--bg-input);border-radius:8px">Authorization: Bearer &lt;token&gt;<br>X-API-Key: &lt;token&gt;</code>
        <p class="card-sub" style="margin-top:12px;margin-bottom:0">
          La Agent Card pública sigue en <code>/.well-known/agent-card.json</code> y no expone las skills internas.
        </p>
      </div>
    </div>
  `,
  styles: [`
    .peer-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; padding: 14px; margin: 8px 0 16px; border: 1px solid var(--border-light); border-radius: 10px; background: var(--bg-input); }
    .peer-form .field { margin: 0; }
    .peer-form .hint { display: block; margin-top: 6px; font-size: 12px; color: var(--text-dim); }
    @media (max-width: 720px) { .peer-form { grid-template-columns: 1fr; } }
    tr.editing td { border-bottom-color: transparent; }
    tr.editor-row > td { padding: 4px 12px 16px; background: rgba(129,140,248,.04); }
    .editor-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin: 8px 0 12px; }
  `],
})
export class TokensComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  tokens = signal<A2AToken[]>([]);
  catalogo = signal<string[]>([]);
  detalle = signal<ToolDetalle[]>([]);
  creando = signal(false);
  nuevoToken = signal<string | null>(null);
  editando = signal<string | null>(null);
  toolsEdit = signal<string[]>([]);
  toolsNuevo = signal<string[]>([]);
  nombre = '';

  // ─── Agentes remotos ───────────────────────────────────────────────────
  peers = signal<A2APeer[]>([]);
  tokensEntrantes = signal<string[]>([]);
  creandoPeer = signal(false);
  probando = signal<string | null>(null);
  respuestaPeer = signal<{ peer: string; texto: string } | null>(null);
  peerForm = { name: '', card_url: '', token: '', token_name: '' };

  constructor() { this.load(); }

  load() {
    this.api.getPeers().subscribe({
      next: (r) => { this.peers.set(r.peers || []); this.tokensEntrantes.set(r.tokensEntrantes || []); },
      error: () => {},
    });
    this.api.getTokens().subscribe({
      next: (r) => this.tokens.set(r.tokens),
      error: () => this.toast.error('No se pudieron cargar los tokens'),
    });
    this.api.getDisponiblesA2A().subscribe({
      next: (r) => {
        this.catalogo.set(r.disponibles);
        // Solo las publicadas en el canal: el resto no se puede conceder.
        const publicadas = new Set(r.disponibles);
        const detalle = (r.detalle && r.detalle.length)
          ? r.detalle
          // Backend sin reiniciar (todavía no manda `detalle`): se muestra sin descripciones en vez de vacío.
          : r.disponibles.map((name) => ({ name, titulo: name, descripcion: '', grupo: 'otros', etiqueta: 'Herramientas' }));
        this.detalle.set(detalle.filter((d) => publicadas.has(d.name)));
      },
      error: () => {},
    });
  }

  abrirNuevo() {
    this.nombre = '';
    this.toolsNuevo.set([]);
    this.creando.set(true);
  }

  crearPeer() {
    const f = this.peerForm;
    this.api.createPeer({ name: f.name.trim(), card_url: f.card_url.trim(), token: f.token.trim() || undefined, token_name: f.token_name || undefined }).subscribe({
      next: () => { this.creandoPeer.set(false); this.peerForm = { name: '', card_url: '', token: '', token_name: '' }; this.load(); this.toast.ok('Agente remoto agregado'); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo agregar'),
    });
  }
  probarPeer(p: A2APeer) {
    this.probando.set(p.name);
    this.api.testPeer(p.name).subscribe({
      next: (r) => {
        this.probando.set(null); this.load();
        r.ok ? this.toast.ok(`Conectado: "${r.agente}" · ${r.skills} skills · protocolo ${r.version || '?'}`) : this.toast.error(`No conecta: ${r.error}`);
      },
      error: () => { this.probando.set(null); this.toast.error('No se pudo probar'); },
    });
  }
  mensajePeer(p: A2APeer) {
    const texto = prompt(`Mensaje para "${p.name}":`, 'Hola, soy Yisus. ¿Qué puedes hacer?');
    if (!texto) return;
    this.respuestaPeer.set({ peer: p.name, texto: '…' });
    this.api.sendToPeer(p.name, texto, true).subscribe({
      next: (r) => { this.respuestaPeer.set({ peer: p.name, texto: r.texto }); this.load(); },
      error: (e) => { this.respuestaPeer.set(null); this.toast.error(e?.error?.error || 'No respondió'); this.load(); },
    });
  }
  alternarPeer(p: A2APeer) {
    this.api.updatePeer(p.name, { enabled: !p.enabled }).subscribe({ next: () => this.load(), error: () => this.toast.error('No se pudo cambiar') });
  }
  eliminarPeer(p: A2APeer) {
    if (!confirm(`¿Eliminar el agente remoto "${p.name}"?`)) return;
    this.api.deletePeer(p.name).subscribe({ next: () => { this.load(); this.toast.ok('Eliminado'); }, error: () => this.toast.error('No se pudo eliminar') });
  }

  tituloDe(tool: string): string {
    return this.detalle().find((d) => d.name === tool)?.titulo || tool;
  }

  hayCambios(t: A2AToken): boolean {
    const a = [...t.tools].sort().join(',');
    const b = [...this.toolsEdit()].sort().join(',');
    return a !== b;
  }

  crear() {
    this.api.createToken(this.nombre.trim(), this.toolsNuevo()).subscribe({
      next: (r) => {
        this.nuevoToken.set(r.token);
        this.creando.set(false);
        this.load();
        this.toast.ok(`Token "${r.name}" creado`);
      },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo crear el token'),
    });
  }

  editar(t: A2AToken) {
    this.editando.set(t.name);
    this.toolsEdit.set([...t.tools]);
  }

  guardarAlcance(t: A2AToken) {
    this.api.updateToken(t.name, { tools: this.toolsEdit() }).subscribe({
      next: () => { this.editando.set(null); this.load(); this.toast.ok('Alcance actualizado'); },
      error: () => this.toast.error('No se pudo actualizar'),
    });
  }

  alternar(t: A2AToken) {
    this.api.updateToken(t.name, { enabled: !t.enabled }).subscribe({
      next: () => { this.load(); this.toast.ok(t.enabled ? 'Token revocado' : 'Token reactivado'); },
      error: () => this.toast.error('No se pudo cambiar el estado'),
    });
  }

  eliminar(t: A2AToken) {
    if (!confirm(`¿Eliminar el token "${t.name}"? La integración que lo use deja de funcionar de inmediato.`)) return;
    this.api.deleteToken(t.name).subscribe({
      next: () => { this.load(); this.toast.ok('Token eliminado'); },
      error: () => this.toast.error('No se pudo eliminar'),
    });
  }

  copiar(v: string) {
    navigator.clipboard.writeText(v).then(
      () => this.toast.ok('Token copiado'),
      () => this.toast.error('No se pudo copiar'),
    );
  }
}
