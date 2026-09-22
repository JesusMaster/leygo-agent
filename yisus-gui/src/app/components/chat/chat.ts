import { Component, inject, signal, effect, ElementRef, viewChild, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatService, ChatMessage, Adjunto, Paso } from '../../services/chat.service';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';
import { ToastService } from '../../services/toast.service';

const MAX_ADJUNTO_MB = 15;
const TEXTO_EXT = /\.(txt|md|markdown|csv|json|ya?ml|xml|html?|css|js|ts|tsx|jsx|py|go|java|kt|rb|php|sh|sql|log|env|toml|ini)$/i;

@Component({
  selector: 'app-chat',
  imports: [FormsModule, MarkdownPipe, FriendlyDatePipe],
  template: `
    <div class="chat-wrap">
      <div class="chat-head">
        <div>
          <h3>Conversación</h3>
          <span class="sub">Sesión <code>{{ chat.sessionId() }}</code> · canal <span class="badge dim">api</span></span>
        </div>
        <span class="spacer"></span>
        <button class="btn-secondary" (click)="chat.reset()"><i class="ph ph-plus"></i> Nueva sesión</button>
      </div>

      <div class="chat-body" #scroll>
        @if (chat.messages().length === 0) {
          <div class="empty">
            Escríbele como lo harías por Telegram. Las herramientas disponibles acá son las del canal <code>api</code>.
            Puedes adjuntar imágenes, PDFs o archivos de texto.
          </div>
        }

        @for (m of chat.messages(); track $index) {
          <div class="msg" [class.mine]="m.role === 'user'">
            <div class="meta">
              @if (m.role === 'agent') {
                <span class="avatar"><i class="ph" [class.ph-sparkle]="m.streaming" [class.ph-robot]="!m.streaming"></i></span>
                <span class="who">Yisus</span>
                @if (m.author && m.author !== 'Coordinator' && m.author !== 'agente') { <span class="via">vía {{ m.author }}</span> }
                <span class="when">{{ m.at | friendlyDate }}</span>
                @if (m.uso) {
                  <span class="uso" [title]="detalleUso(m)">
                    <i class="ph ph-coins"></i> {{ m.uso.totalTokens.toLocaleString('es-CL') }} tokens · {{ '$' + m.uso.costUsd.toFixed(4) }}
                  </span>
                }
              } @else {
                <span class="when">{{ m.at | friendlyDate }}</span>
                <span class="who">Tú</span>
                <span class="avatar mine">JL</span>
              }
            </div>

            @if (m.adjuntos?.length) {
              <div class="adjuntos">
                @for (a of m.adjuntos; track a.name) {
                  <span class="adjunto"><i class="ph" [class]="'ph ' + iconoAdjunto(a)"></i> {{ a.name }} <small>{{ tamano(a.size) }}</small></span>
                }
              </div>
            }

            @if (m.role === 'agent') {
              <div class="bubble agent" [class.error]="m.error">
                @if (m.streaming) {
                  <div class="paso-actual">
                    <span class="pulso"></span>
                    {{ textoPaso(chat.pasoActual()) }}
                  </div>
                }
                @if (m.text) { <div class="md" [innerHTML]="m.text | markdown"></div> }
                @if (m.streaming && !m.text) { <div class="dots"><i></i><i></i><i></i></div> }
              </div>
              @if (!m.streaming && (m.pasos?.length || 0) > 0) {
                <details class="pasos">
                  <summary><i class="ph ph-list-checks"></i> {{ m.pasos!.length }} paso{{ m.pasos!.length === 1 ? '' : 's' }}</summary>
                  <ul>
                    @for (p of m.pasos!; track $index) {
                      <li><span class="p-who">{{ p.author }}</span> <span class="p-kind">{{ p.kind === 'herramienta' ? '→' : '←' }}</span> <code>{{ p.detail }}</code></li>
                    }
                  </ul>
                </details>
              }
            } @else {
              <div class="bubble mine"><div class="md" [innerHTML]="m.text | markdown"></div></div>
            }
          </div>
        }
      </div>

      <div class="chat-input">
        @if (pendientes().length) {
          <div class="pendientes">
            @for (a of pendientes(); track a.name) {
              <span class="adjunto"><i class="ph" [class]="'ph ' + iconoAdjunto(a)"></i> {{ a.name }} <small>{{ tamano(a.size) }}</small>
                <button type="button" class="quitar" (click)="quitar(a)"><i class="ph ph-x"></i></button>
              </span>
            }
          </div>
        }
        <div class="input-row">
          <textarea #ta rows="1" [(ngModel)]="texto" (input)="ajustar(ta)" (keydown.enter)="enviar($event)"
            placeholder="Escribe un mensaje… (Enter envía, Shift+Enter salta línea)"></textarea>
          @if (chat.thinking()) {
            <button class="btn-send stop" title="Detener" (click)="chat.cancelar()"><i class="ph ph-stop-fill"></i></button>
          } @else {
            <button class="btn-send" title="Enviar" [disabled]="!texto.trim() && !pendientes().length" (click)="enviar()"><i class="ph ph-arrow-right"></i></button>
          }
        </div>
        <div class="input-foot">
          <label class="btn-link"><i class="ph ph-paperclip"></i> Adjuntar<input type="file" multiple hidden (change)="adjuntar($event)" /></label>
          <span class="spacer"></span>
          <button type="button" class="btn-link" (click)="chat.reset()"><i class="ph ph-broom"></i> Limpiar chat</button>
          <span class="contador" [class.warn]="texto.length > 8000">{{ texto.length.toLocaleString('es-CL') }} / 10.000</span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .chat-wrap { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .chat-head { display: flex; align-items: center; gap: 12px; padding: 16px 28px; border-bottom: 1px solid var(--border-light); }
    .chat-head .sub { font-size: 12.5px; color: var(--text-dim); }
    .chat-body { flex: 1; overflow-y: auto; padding: 24px 28px; display: flex; flex-direction: column; gap: 18px; }

    .msg { display: flex; flex-direction: column; align-items: flex-start; max-width: 82%; }
    .msg.mine { align-self: flex-end; align-items: flex-end; }
    .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12.5px; color: var(--text-dim); }
    .meta .who { font-weight: 600; color: var(--text-main); }
    .meta .via { font-size: 11.5px; padding: 1px 7px; border-radius: 999px; background: var(--bg-input); border: 1px solid var(--border-light); }
    .avatar { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: var(--bg-input); border: 1px solid var(--border-light); color: var(--accent-primary); font-size: 15px; }
    .avatar.mine { background: var(--accent-primary); color: #fff; border-color: var(--accent-primary); font-size: 11px; font-weight: 700; border-radius: 50%; }
    .uso { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; color: var(--accent-primary); background: rgba(129,140,248,.12); border: 1px solid rgba(129,140,248,.3); cursor: help; }

    .bubble { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; padding: 12px 16px; font-size: 14.5px; line-height: 1.55; max-width: 100%; }
    .bubble.mine { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }
    .bubble.error { border-color: var(--danger); }
    .bubble.agent { min-width: 200px; }

    .paso-actual { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--accent-primary); padding: 6px 10px; margin: -4px -6px 8px; border-radius: 8px; background: rgba(129,140,248,.08); }
    .pulso { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-primary); animation: pulso 1.2s ease-in-out infinite; }
    @keyframes pulso { 0%,100% { opacity: .3; transform: scale(.8);} 50% { opacity: 1; transform: scale(1);} }
    .dots { display: flex; gap: 4px; padding: 4px 0; }
    .dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-primary); animation: dots 1.2s infinite; }
    .dots i:nth-child(2) { animation-delay: .2s; } .dots i:nth-child(3) { animation-delay: .4s; }
    @keyframes dots { 0%,80%,100% { opacity: .25; } 40% { opacity: 1; } }

    .pasos { margin-top: 6px; font-size: 12px; color: var(--text-dim); }
    .pasos summary { cursor: pointer; display: inline-flex; align-items: center; gap: 6px; list-style: none; }
    .pasos summary::-webkit-details-marker { display: none; }
    .pasos ul { margin: 6px 0 0 4px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
    .pasos .p-who { color: var(--text-main); }
    .pasos code { font-size: 11.5px; }

    .adjuntos, .pendientes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
    .adjunto { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 8px; font-size: 12.5px; background: var(--bg-input); border: 1px solid var(--border-light); }
    .adjunto small { color: var(--text-dim); }
    .adjunto .quitar { background: none; border: 0; color: var(--text-dim); cursor: pointer; padding: 0; display: grid; place-items: center; }
    .adjunto .quitar:hover { color: var(--danger); }

    /* markdown: en styles.css (el HTML inyectado no lleva el atributo de encapsulación) */

    /* input */
    .chat-input { display: flex; flex-direction: column; gap: 8px; padding: 14px 28px 12px; border-top: 1px solid var(--border-light); }
    .input-row { display: flex; gap: 10px; align-items: flex-end; border: 1px solid var(--border-light); border-radius: 14px; background: var(--bg-input); padding: 8px 8px 8px 16px; transition: border-color .15s; }
    .input-row:focus-within { border-color: var(--accent-primary); }
    .input-row textarea { flex: 1; resize: none; border: 0; background: transparent; padding: 8px 0; font-size: 15px; line-height: 1.5; max-height: 220px; overflow-y: auto; min-height: 24px; }
    .input-row textarea:focus { outline: none; box-shadow: none; }
    .btn-send { width: 42px; height: 42px; border-radius: 12px; border: 0; background: var(--accent-primary); color: #fff; font-size: 20px; cursor: pointer; display: grid; place-items: center; flex: 0 0 auto; transition: background .15s, transform .1s; }
    .btn-send:hover { background: var(--accent-hover); }
    .btn-send:disabled { opacity: .45; cursor: default; }
    .btn-send.stop { background: var(--danger); }
    .btn-send.stop:hover { background: #dc2626; }
    .input-foot { display: flex; align-items: center; gap: 16px; font-size: 13px; color: var(--text-dim); padding: 0 4px; }
    .btn-link { display: inline-flex; align-items: center; gap: 6px; background: none; border: 0; padding: 0; color: var(--text-dim); cursor: pointer; font: inherit; font-size: 13px; }
    .btn-link:hover { color: var(--text-main); }
    .contador { font-variant-numeric: tabular-nums; }
    .contador.warn { color: var(--warn); }
  `],
})
export class ChatComponent {
  chat = inject(ChatService);
  private toast = inject(ToastService);
  texto = '';
  pendientes = signal<Adjunto[]>([]);
  private scroll = viewChild<ElementRef<HTMLDivElement>>('scroll');

  constructor() {
    effect(() => {
      this.chat.messages();
      this.chat.pasoActual();
      queueMicrotask(() => {
        const el = this.scroll()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  ajustar(ta: HTMLTextAreaElement) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  }

  enviar(ev?: Event) {
    if (ev) {
      const ke = ev as KeyboardEvent;
      if (ke.shiftKey) return;
      ev.preventDefault();
    }
    const t = this.texto.trim();
    if ((!t && !this.pendientes().length) || this.chat.thinking()) return;
    if (t.length > 10000) { this.toast.error('Máximo 10.000 caracteres por mensaje'); return; }
    const adj = this.pendientes();
    this.texto = '';
    this.pendientes.set([]);
    queueMicrotask(() => { const ta = document.querySelector<HTMLTextAreaElement>('.input-row textarea'); if (ta) ta.style.height = 'auto'; });
    void this.chat.send(t || `Revisa ${adj.length === 1 ? 'el archivo adjunto' : 'los archivos adjuntos'}.`, adj);
  }

  async adjuntar(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    for (const f of files) {
      if (f.size > MAX_ADJUNTO_MB * 1024 * 1024) { this.toast.error(`${f.name}: supera ${MAX_ADJUNTO_MB} MB`); continue; }
      try {
        const esTexto = f.type.startsWith('text/') || TEXTO_EXT.test(f.name) || f.type === 'application/json';
        const adj: Adjunto = { name: f.name, mimeType: f.type || (esTexto ? 'text/plain' : 'application/octet-stream'), size: f.size };
        if (esTexto) adj.text = await f.text();
        else adj.data = await this.aBase64(f);
        this.pendientes.update((l) => [...l.filter((x) => x.name !== f.name), adj]);
      } catch { this.toast.error(`No se pudo leer ${f.name}`); }
    }
  }
  quitar(a: Adjunto) { this.pendientes.update((l) => l.filter((x) => x !== a)); }

  private aBase64(f: File): Promise<string> {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.onerror = () => rej(r.error);
      r.readAsDataURL(f);
    });
  }

  iconoAdjunto(a: Adjunto) {
    if (a.mimeType.startsWith('image/')) return 'ph-image';
    if (a.mimeType === 'application/pdf') return 'ph-file-pdf';
    if (a.text !== undefined || a.mimeType.startsWith('text/')) return 'ph-file-text';
    return 'ph-file';
  }
  tamano(b: number) { return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`; }

  textoPaso(p: Paso | null): string {
    if (!p) return 'Pensando…';
    const quien = p.author === 'Coordinator' ? 'Yisus' : p.author;
    if (p.kind === 'herramienta') return `${quien} usando ${p.detail}…`;
    if (p.kind === 'resultado') return `${quien} procesando ${p.detail}…`;
    return `${quien} pensando…`;
  }
  detalleUso(m: ChatMessage): string {
    const u = m.uso!;
    const lineas = [`Entrada: ${u.inputTokens.toLocaleString('es-CL')} · Salida: ${u.outputTokens.toLocaleString('es-CL')}`];
    for (const a of u.porAgente || []) lineas.push(`${a.agent} (${a.model}): ${a.tokens.toLocaleString('es-CL')} tokens · $${a.costUsd.toFixed(4)}`);
    return lineas.join('\n');
  }
}
