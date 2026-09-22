import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, CustomWebhook, CustomWebhookLog, WebhookModel } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';

/**
 * Smart Webhooks, calcado de la vista de Leygo: tarjetas por webhook, modal de
 * edición, drawer lateral con los logs (payload y respuesta plegables) y una
 * vista global de ejecuciones.
 */
@Component({
  selector: 'app-webhooks',
  imports: [FormsModule, FriendlyDatePipe],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Smart Webhooks</h2>
          <p class="sub">Acopla tus sistemas externos con Yisus para procesar payloads asíncronamente y avisarte donde corresponda.</p>
        </div>
        <div class="row">
          <button class="btn-secondary" (click)="verEjecuciones()"><i class="ph ph-terminal"></i> Ver ejecuciones</button>
          <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Nuevo webhook</button>
        </div>
      </div>

      @if (!cargado()) {
        <div class="empty">Cargando webhooks…</div>
      } @else if (items().length === 0) {
        <div class="card empty-state">
          <i class="ph ph-share-network"></i>
          <h3>Todavía no hay webhooks</h3>
          <p>Crea uno, copia su URL y apúntale desde SonarQube, GCP, GitHub, n8n o lo que sea. Cada POST que llegue se procesa con las instrucciones que le des.</p>
          <button class="btn-primary" (click)="abrirNuevo()"><i class="ph ph-plus"></i> Nuevo webhook</button>
        </div>
      } @else {
        <div class="wh-grid">
          @for (w of items(); track w.id) {
            <div class="wh-card" [class.paused]="w.paused === 1">
              <div class="wh-head">
                <div class="wh-icon"><i class="ph ph-share-network"></i></div>
                <div class="wh-title">
                  <h3 [title]="w.titulo">{{ w.titulo }}</h3>
                  @if (w.paused === 1) { <span class="badge warn">PAUSADO</span> } @else { <span class="badge ok">ACTIVO</span> }
                </div>
              </div>

              <p class="wh-desc" [title]="w.instrucciones">{{ w.instrucciones }}</p>

              <div class="wh-model" [title]="w.modelo">
                <i class="ph ph-cpu"></i> <span>{{ w.modelo }}</span>
              </div>

              <button class="btn-secondary wh-url" (click)="copiar(url(w))" [title]="url(w)">
                <i class="ph ph-copy"></i> Copiar URL HTTP POST
              </button>

              <div class="wh-actions">
                <button class="wh-btn logs" (click)="verLogs(w)"><i class="ph ph-terminal"></i> Logs</button>
                <button class="wh-btn" (click)="editar(w)">Editar</button>
                <button class="wh-btn go" (click)="alternar(w)">{{ w.paused === 1 ? 'Reanudar' : 'Pausar' }}</button>
                <button class="wh-btn del" (click)="eliminar(w)">Eliminar</button>
              </div>
            </div>
          }
        </div>
      }
    </div>

    <!-- ─── Modal: crear / editar ─────────────────────────────────────────── -->
    @if (modal()) {
      <div class="modal-backdrop" (click)="cerrarModal()">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-head">
            <h3>{{ modal()!.id ? 'Editar webhook' : 'Nuevo webhook' }}</h3>
            <button class="btn-icon" (click)="cerrarModal()"><i class="ph ph-x"></i></button>
          </div>
          <div class="modal-body">
            <label class="field">
              <span>Título / nombre</span>
              <input type="text" [(ngModel)]="form.titulo" placeholder="ej: Procesa alertas de GCP" autofocus />
            </label>
            <label class="field">
              <span>Descripción (instrucciones para la IA)</span>
              <textarea rows="5" [(ngModel)]="form.instrucciones"
                placeholder="Qué hacer con cada payload: qué resaltar, qué ignorar, a quién avisar y por dónde (Telegram, un espacio de Google Chat, Buzz…)"></textarea>
            </label>
            <label class="field">
              <span>Modelo de IA a utilizar</span>
              <select [(ngModel)]="form.modelo">
                @if (modelos().length === 0) { <option [value]="form.modelo">{{ form.modelo }}</option> }
                @for (m of modelos(); track m.id) { <option [value]="m.id">{{ m.label }}</option> }
                @if (form.modelo && !modeloEnLista()) { <option [value]="form.modelo">{{ form.modelo }} (no disponible ahora)</option> }
              </select>
              <small class="hint">Este modelo procesará los payloads asíncronamente. Los de Ollama corren en tu servidor y no gastan presupuesto.</small>
            </label>
          </div>
          <div class="modal-foot">
            <button class="btn-secondary" (click)="cerrarModal()">Cancelar</button>
            <button class="btn-primary" [disabled]="!form.titulo.trim() || !form.instrucciones.trim() || guardando()" (click)="guardar()">
              {{ modal()!.id ? 'Guardar cambios' : 'Crear webhook' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- ─── Drawer: logs ──────────────────────────────────────────────────── -->
    @if (drawer()) {
      <div class="drawer-backdrop" (click)="cerrarDrawer()"></div>
      <aside class="drawer">
        <div class="drawer-head">
          <div>
            <h3><i class="ph ph-terminal"></i> {{ drawer()!.webhook ? 'Logs del webhook' : 'Ejecuciones recientes' }}</h3>
            <div class="sub">{{ drawer()!.webhook?.titulo || 'Todos los webhooks, más reciente primero' }}</div>
          </div>
          <div class="row">
            <button class="btn-icon" title="Actualizar" (click)="recargarDrawer()"><i class="ph ph-arrows-clockwise"></i></button>
            <button class="btn-icon" title="Cerrar" (click)="cerrarDrawer()"><i class="ph ph-x"></i></button>
          </div>
        </div>
        <div class="drawer-body">
          @if (!drawer()!.logs) {
            <div class="empty">Cargando…</div>
          } @else if (drawer()!.logs!.length === 0) {
            <div class="empty">Sin ejecuciones todavía. Cuando llegue el primer POST aparecerá aquí con su payload y la respuesta de la IA.</div>
          } @else {
            @for (l of drawer()!.logs; track l.id) {
              <div class="log" [class.err]="l.status === 'error'" [class.skip]="l.status === 'skipped'">
                <div class="log-head">
                  <span class="log-when"><i class="ph ph-clock"></i> {{ l.created_at | friendlyDate }}</span>
                  @if (!drawer()!.webhook) { <span class="badge dim">{{ l.webhook_titulo || l.webhook_id }}</span> }
                  @if (l.status !== 'success') { <span class="badge" [class.danger]="l.status === 'error'" [class.warn]="l.status === 'skipped'">{{ l.status }}</span> }
                  <span class="spacer"></span>
                  <button class="btn-icon del" title="Borrar este log" (click)="borrarLog(l)"><i class="ph ph-trash"></i></button>
                </div>

                <div class="log-section">
                  <div class="log-label">
                    <span>Payload</span>
                    <button class="btn-link" (click)="toggle(l.id, 'p')">{{ abierto(l.id, 'p') ? 'Plegar' : 'Ver todo' }}</button>
                  </div>
                  <pre class="log-pre mono" [class.open]="abierto(l.id, 'p')">{{ bonito(l.payload) }}</pre>
                </div>

                <div class="log-section">
                  <div class="log-label">
                    <span>Respuesta</span>
                    <button class="btn-link" (click)="toggle(l.id, 'r')">{{ abierto(l.id, 'r') ? 'Plegar' : 'Ver todo' }}</button>
                  </div>
                  <pre class="log-pre texto" [class.open]="abierto(l.id, 'r')">{{ l.response || '—' }}</pre>
                </div>
              </div>
            }
          }
        </div>
      </aside>
    }
  `,
  styles: [`
    .wh-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
    .wh-card {
      display: flex; flex-direction: column; gap: 14px; padding: 20px;
      background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px;
      transition: border-color .15s, transform .15s;
    }
    .wh-card:hover { border-color: var(--accent-primary); transform: translateY(-1px); }
    .wh-card.paused { opacity: .92; }

    .wh-head { display: flex; gap: 14px; align-items: flex-start; }
    .wh-icon {
      flex: 0 0 auto; width: 52px; height: 52px; border-radius: 12px; display: grid; place-items: center;
      background: var(--bg-input); border: 1px solid var(--border-light); color: #f97316; font-size: 24px;
    }
    .wh-title { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .wh-title h3 { margin: 0; font-size: 16.5px; line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .wh-title .badge { align-self: flex-start; font-size: 10.5px; letter-spacing: .06em; font-weight: 600; }

    .wh-desc {
      margin: 0; color: var(--text-dim); font-size: 13.5px; line-height: 1.5; min-height: 3em;
      overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    }
    .wh-model {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 8px;
      background: var(--bg-input); border: 1px solid var(--border-light); color: var(--text-dim); font-size: 13px;
    }
    .wh-model i { color: var(--accent-primary); }
    .wh-model span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .wh-url { width: 100%; justify-content: center; display: inline-flex; align-items: center; gap: 8px; margin-top: auto; }

    .wh-actions { display: grid; grid-template-columns: auto 1fr 1fr 1fr; gap: 8px; }
    .wh-btn {
      padding: 9px 10px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer;
      background: var(--bg-input); border: 1px solid var(--border-light); color: var(--text-main);
      display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap;
    }
    .wh-btn:hover { border-color: var(--accent-primary); }
    .wh-btn.logs { background: rgba(163,230,53,.14); color: #a3e635; border-color: transparent; flex-direction: column; gap: 2px; padding: 6px 12px; }
    .wh-btn.go { color: var(--ok); }
    .wh-btn.del { color: var(--danger); }

    .empty-state { text-align: center; padding: 48px 24px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .empty-state > i { font-size: 40px; color: var(--accent-primary); }
    .empty-state p { color: var(--text-dim); max-width: 52ch; margin: 0 0 8px; }

    .field .hint { display: block; margin-top: 6px; color: var(--text-dim); font-size: 12px; }

    /* logs */
    .log { border: 1px solid var(--border-light); border-left: 3px solid var(--accent-primary); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; background: var(--bg-card); }
    .log.err { border-left-color: var(--danger); }
    .log.skip { border-left-color: var(--warn); }
    .log-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .log-when { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 13px; }
    .log-head .btn-icon.del { color: var(--danger); opacity: .7; }
    .log-head .btn-icon.del:hover { opacity: 1; }
    .log-section { margin-top: 10px; }
    .log-label { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-dim); }
    .btn-link { background: none; border: 0; padding: 0; color: var(--accent-primary); cursor: pointer; font: inherit; font-size: 12px; text-transform: none; letter-spacing: 0; }
    .btn-link:hover { text-decoration: underline; }
    .log-pre {
      margin: 0; padding: 12px 14px; border-radius: 8px; background: var(--bg-input); border: 1px solid var(--border-light);
      font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--text-main);
      max-height: 120px; overflow: hidden; position: relative;
    }
    .log-pre.texto { font-family: inherit; font-size: 13.5px; }
    .log-pre:not(.open)::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 36px; background: linear-gradient(transparent, var(--bg-input)); }
    .log-pre.open { max-height: none; overflow: auto; }
  `],
})
export class WebhooksComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  items = signal<CustomWebhook[]>([]);
  cargado = signal(false);
  modelos = signal<WebhookModel[]>([]);

  /** null = cerrado; { id: null } = crear; { id } = editar */
  modal = signal<{ id: string | null } | null>(null);
  form = { titulo: '', instrucciones: '', modelo: 'gemini-2.5-flash' };
  guardando = signal(false);
  modeloEnLista = computed(() => this.modelos().some((m) => m.id === this.form.modelo));

  drawer = signal<{ webhook: CustomWebhook | null; logs: CustomWebhookLog[] | null } | null>(null);
  private abiertos = signal<Set<string>>(new Set());

  constructor() { this.load(); }

  load() {
    this.api.getWebhooks().subscribe({
      next: (r) => { this.items.set(r?.webhooks || []); this.cargado.set(true); },
      error: () => { this.cargado.set(true); this.toast.error('No se pudieron cargar los webhooks'); },
    });
  }

  private cargarModelos() {
    if (this.modelos().length) return;
    this.api.getWebhookModels().subscribe({ next: (r) => this.modelos.set(r.models || []), error: () => {} });
  }

  url(w: CustomWebhook) { return w.url || `${this.api.baseUrl}/api/webhook/${w.id}`; }

  // ─── Crear / editar ───────────────────────────────────────────────────
  abrirNuevo() {
    this.form = { titulo: '', instrucciones: '', modelo: 'gemini-2.5-flash' };
    this.cargarModelos();
    this.modal.set({ id: null });
  }
  editar(w: CustomWebhook) {
    this.form = { titulo: w.titulo, instrucciones: w.instrucciones, modelo: w.modelo };
    this.cargarModelos();
    this.modal.set({ id: w.id });
  }
  cerrarModal() { if (!this.guardando()) this.modal.set(null); }

  guardar() {
    const datos = { titulo: this.form.titulo.trim(), instrucciones: this.form.instrucciones.trim(), modelo: this.form.modelo.trim() };
    const id = this.modal()?.id;
    this.guardando.set(true);
    const req = id ? this.api.updateWebhook(id, datos) : this.api.createWebhook(datos);
    req.subscribe({
      next: () => { this.guardando.set(false); this.modal.set(null); this.load(); this.toast.ok(id ? 'Webhook actualizado' : 'Webhook creado'); },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); },
    });
  }

  alternar(w: CustomWebhook) {
    this.api.updateWebhook(w.id, { paused: w.paused === 1 ? 0 : 1 }).subscribe({
      next: () => { this.load(); this.toast.ok(w.paused === 1 ? 'Webhook reanudado' : 'Webhook pausado'); },
      error: () => this.toast.error('No se pudo cambiar el estado'),
    });
  }

  eliminar(w: CustomWebhook) {
    if (!confirm(`¿Eliminar "${w.titulo}"? Se borran también sus logs.`)) return;
    this.api.deleteWebhook(w.id).subscribe({
      next: () => { this.load(); this.toast.ok('Webhook eliminado'); },
      error: () => this.toast.error('No se pudo eliminar'),
    });
  }

  copiar(v: string) {
    navigator.clipboard.writeText(v).then(() => this.toast.ok('URL copiada'), () => this.toast.error('No se pudo copiar'));
  }

  // ─── Logs ─────────────────────────────────────────────────────────────
  verLogs(w: CustomWebhook) { this.drawer.set({ webhook: w, logs: null }); this.recargarDrawer(); }
  verEjecuciones() { this.drawer.set({ webhook: null, logs: null }); this.recargarDrawer(); }
  cerrarDrawer() { this.drawer.set(null); this.abiertos.set(new Set()); }

  recargarDrawer() {
    const d = this.drawer();
    if (!d) return;
    const req = d.webhook ? this.api.getWebhookLogs(d.webhook.id, 30) : this.api.getAllWebhookLogs(50);
    req.subscribe({
      next: (r) => this.drawer.update((x) => (x ? { ...x, logs: r.logs || [] } : x)),
      error: () => { this.drawer.update((x) => (x ? { ...x, logs: [] } : x)); this.toast.error('No se pudieron cargar los logs'); },
    });
  }

  borrarLog(l: CustomWebhookLog) {
    this.api.deleteWebhookLog(l.webhook_id, l.id).subscribe({
      next: () => this.drawer.update((x) => (x?.logs ? { ...x, logs: x.logs.filter((y) => y.id !== l.id) } : x)),
      error: () => this.toast.error('No se pudo borrar el log'),
    });
  }

  toggle(id: number, que: 'p' | 'r') {
    const k = `${id}${que}`;
    this.abiertos.update((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }
  abierto(id: number, que: 'p' | 'r') { return this.abiertos().has(`${id}${que}`); }

  bonito(raw: string): string {
    if (!raw) return '—';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  }
}
