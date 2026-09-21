import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';

export interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  author?: string;
  at: number;
}

/**
 * Conversación con el agente por /run_sse.
 *
 * No se usa EventSource porque el endpoint es POST: se lee el stream con fetch y se
 * parsean los `data:` a mano. Cada evento del ADK trae el autor, así se ve qué
 * subagente respondió en vez de solo el texto final.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private api = inject(ApiService);

  readonly messages = signal<ChatMessage[]>([]);
  readonly thinking = signal(false);
  readonly sessionId = signal<string>(localStorage.getItem('yisus_session') || this.nuevaSesion());

  private nuevaSesion(): string {
    const id = `gui-${Date.now().toString(36)}`;
    localStorage.setItem('yisus_session', id);
    return id;
  }

  reset() {
    this.messages.set([]);
    this.sessionId.set(this.nuevaSesion());
  }

  async send(text: string): Promise<void> {
    const userId = 'gui';
    const appName = 'yisus';

    this.messages.update((m) => [...m, { role: 'user', text, at: Date.now() }]);
    this.thinking.set(true);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const adminKey = localStorage.getItem('yisus_admin_key');
      if (adminKey) headers['X-Admin-Key'] = adminKey;

      const res = await fetch(`${this.api.baseUrl}/run_sse`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          appName,
          userId,
          sessionId: this.sessionId(),
          newMessage: { role: 'user', parts: [{ text }] },
        }),
      });

      if (!res.body) throw new Error('El backend no devolvió un stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let ultimo: ChatMessage | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const partes = buffer.split('\n\n');
        buffer = partes.pop() || '';

        for (const parte of partes) {
          const linea = parte.trim();
          if (!linea.startsWith('data:')) continue;

          const payload = linea.slice(5).trim();
          if (payload === '[DONE]') continue;

          try {
            const evento = JSON.parse(payload);
            const partesTexto = evento?.content?.parts || [];
            const texto = partesTexto.map((p: any) => p?.text || '').filter(Boolean).join('');
            if (!texto || evento.author === 'user' || evento.partial === true) continue;

            ultimo = { role: 'agent', text: texto, author: evento.author, at: Date.now() };
            this.messages.update((m) => [...m, ultimo!]);
          } catch {
            // Un chunk suelto que no es JSON válido se ignora
          }
        }
      }

      if (!ultimo) {
        this.messages.update((m) => [...m, { role: 'agent', text: '(sin respuesta)', at: Date.now() }]);
      }
    } catch (err: any) {
      this.messages.update((m) => [...m, { role: 'agent', text: `Error: ${err?.message || err}`, at: Date.now() }]);
    } finally {
      this.thinking.set(false);
    }
  }
}
