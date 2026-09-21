import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, A2AToken } from '../../services/api.service';
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
  imports: [FormsModule, FriendlyDatePipe],
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
            Solo aparecen las que el canal externo admite. Las herramientas personales
            —correo, agenda, Drive, Chat, memoria episódica, publicar en Buzz— no se ofrecen
            acá: el filtro se aplica al resolver el token, así que tampoco sirve concederlas por otra vía.
          </p>
          <div class="chips">
            @for (t of catalogo(); track t) {
              <span class="chip" [class.on]="toolsNuevo().includes(t)" (click)="toggleNuevo(t)">
                @if (toolsNuevo().includes(t)) { <i class="ph ph-check"></i> }
                {{ t }}
              </span>
            }
          </div>
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
              <tr>
                <td><strong>{{ t.name }}</strong><br><span style="color:var(--text-dim);font-size:12px">creado {{ t.created_at | friendlyDate }}</span></td>
                <td class="mono" style="color:var(--text-dim)">{{ t.preview }}</td>
                <td>
                  @if (editando() === t.name) {
                    <div class="chips">
                      @for (tool of catalogo(); track tool) {
                        <span class="chip" [class.on]="toolsEdit().includes(tool)" (click)="toggleEdit(tool)">{{ tool }}</span>
                      }
                    </div>
                    <div class="row" style="margin-top:10px">
                      <button class="btn-secondary" (click)="editando.set(null)">Cancelar</button>
                      <button class="btn-primary" (click)="guardarAlcance(t)">Guardar alcance</button>
                    </div>
                  } @else {
                    @if (t.tools.length === 0) {
                      <span class="badge dim">sin herramientas</span>
                    } @else {
                      <div class="chips">
                        @for (tool of t.tools; track tool) { <span class="chip readonly">{{ tool }}</span> }
                      </div>
                    }
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
            }
          </table>
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
})
export class TokensComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  tokens = signal<A2AToken[]>([]);
  catalogo = signal<string[]>([]);
  creando = signal(false);
  nuevoToken = signal<string | null>(null);
  editando = signal<string | null>(null);
  toolsEdit = signal<string[]>([]);
  toolsNuevo = signal<string[]>([]);
  nombre = '';

  constructor() { this.load(); }

  load() {
    this.api.getTokens().subscribe({
      next: (r) => this.tokens.set(r.tokens),
      error: () => this.toast.error('No se pudieron cargar los tokens'),
    });
    this.api.getToolsPermitidasA2A().subscribe({
      next: (r) => this.catalogo.set(r.permitidas),
      error: () => {},
    });
  }

  abrirNuevo() {
    this.nombre = '';
    this.toolsNuevo.set([]);
    this.creando.set(true);
  }

  toggleNuevo(t: string) {
    this.toolsNuevo.update((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));
  }
  toggleEdit(t: string) {
    this.toolsEdit.update((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));
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
