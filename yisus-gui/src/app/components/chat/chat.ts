import { Component, inject, signal, effect, ElementRef, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../services/chat.service';

@Component({
  selector: 'app-chat',
  imports: [FormsModule],
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
          </div>
        }
        @for (m of chat.messages(); track $index) {
          <div class="msg" [class.mine]="m.role === 'user'">
            @if (m.role === 'agent' && m.author) { <span class="author">{{ m.author }}</span> }
            <div class="bubble">{{ m.text }}</div>
          </div>
        }
        @if (chat.thinking()) {
          <div class="msg"><div class="bubble thinking"><i class="ph ph-circle-notch"></i> pensando…</div></div>
        }
      </div>

      <div class="chat-input">
        <textarea rows="1" [(ngModel)]="texto" (keydown.enter)="enviar($event)" placeholder="Escribe un mensaje… (Enter envía, Shift+Enter salta línea)"></textarea>
        <button class="btn-primary" [disabled]="!texto.trim() || chat.thinking()" (click)="enviar()">
          <i class="ph ph-paper-plane-tilt"></i>
        </button>
      </div>
    </div>
  `,
  styles: [`
    .chat-wrap { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .chat-head { display: flex; align-items: center; gap: 12px; padding: 16px 28px; border-bottom: 1px solid var(--border-light); }
    .chat-head .sub { font-size: 12.5px; color: var(--text-dim); }
    .chat-body { flex: 1; overflow-y: auto; padding: 24px 28px; display: flex; flex-direction: column; gap: 14px; }
    .msg { display: flex; flex-direction: column; align-items: flex-start; max-width: 76%; }
    .msg.mine { align-self: flex-end; align-items: flex-end; }
    .author { font-size: 11.5px; color: var(--text-dim); margin-bottom: 4px; padding-left: 4px; }
    .bubble {
      background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px;
      padding: 12px 16px; font-size: 14.5px; white-space: pre-wrap; line-height: 1.55;
    }
    .msg.mine .bubble { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }
    .bubble.thinking { color: var(--text-dim); display: flex; align-items: center; gap: 8px; }
    .bubble.thinking i { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .chat-input { display: flex; gap: 10px; padding: 16px 28px; border-top: 1px solid var(--border-light); align-items: flex-end; }
    .chat-input textarea { resize: none; max-height: 140px; }
    .chat-input button { height: 42px; padding: 0 18px; font-size: 18px; }
  `],
})
export class ChatComponent {
  chat = inject(ChatService);
  texto = '';
  private scroll = viewChild<ElementRef<HTMLDivElement>>('scroll');

  constructor() {
    effect(() => {
      this.chat.messages();
      queueMicrotask(() => {
        const el = this.scroll()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  enviar(ev?: Event) {
    if (ev) {
      const ke = ev as KeyboardEvent;
      if (ke.shiftKey) return;
      ev.preventDefault();
    }
    const t = this.texto.trim();
    if (!t || this.chat.thinking()) return;
    this.texto = '';
    void this.chat.send(t);
  }
}
