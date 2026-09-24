import { firstValueFrom } from 'rxjs';
import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';

export interface Adjunto {
  name: string;
  mimeType: string;
  size: number;
  /** base64 sin prefijo data: (imágenes, PDF, etc.) */
  data?: string;
  /** contenido de texto plano (md, txt, csv, json, código) */
  text?: string;
}

export interface Paso {
  at: number;
  /** quién: Coordinator, knowledge_agent… */
  author: string;
  /** qué: 'pensando' | 'herramienta' | 'resultado' */
  kind: 'pensando' | 'herramienta' | 'resultado';
  detail?: string;
}

export interface Uso {
  inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number;
  cachedTokens?: number; thoughtsTokens?: number;
  /** algún modelo del turno se tarifó por familia/default: costo aproximado */
  aproximado?: boolean;
  porAgente?: Array<{ agent: string; model: string; tokens: number; cachedTokens?: number; costUsd: number; llamadas?: number; source?: string }>;
}

export interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  author?: string;
  /** Respondió un agente personalizado directamente (mención @slug), sin Coordinator */
  directo?: { name: string; displayName: string };
  at: number;
  adjuntos?: Adjunto[];
  pasos?: Paso[];
  uso?: Uso;
  error?: boolean;
  /** mientras llega el stream */
  streaming?: boolean;
}

const CLAVE_HISTORIAL = 'yisus_chat_history';

/**
 * Conversación con el agente por /run_sse.
 *
 * Se lee el stream con fetch y se parsean los `data:` a mano. Cada evento del
 * ADK trae el autor y, si hubo, las llamadas a herramientas: con eso se muestra
 * en vivo qué está haciendo (qué subagente, qué herramienta) y al final el
 * consumo del turno que manda el backend en un evento `usage`.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private api = inject(ApiService);
  private abort: AbortController | null = null;

  readonly messages = signal<ChatMessage[]>(this.leerHistorial());
  readonly thinking = signal(false);
  /** Paso actual mientras responde (para la línea de estado) */
  readonly pasoActual = signal<Paso | null>(null);
  readonly sessionId = signal<string>(this.sesionValida(localStorage.getItem('yisus_chat_session')) || this.nuevaSesion());

  /** Solo ids de chat propios: si quedó algo raro (p. ej. un token), se descarta. */
  private sesionValida(v: string | null): string | null { return v && /^gui-[a-z0-9]+$/.test(v) ? v : null; }

  private nuevaSesion(): string {
    const id = `gui-${Date.now().toString(36)}`;
    localStorage.setItem('yisus_chat_session', id);
    return id;
  }

  reset() {
    this.cancelar();
    this.messages.set([]);
    this.guardarHistorial();
    this.sessionId.set(this.nuevaSesion());
  }

  cancelar() {
    this.abort?.abort();
    this.abort = null;
  }

  /**
   * Vuelve la conversación al estado ANTERIOR al mensaje de usuario en la posición `idx`
   * (índice dentro de messages): se quitan ese mensaje y todo lo posterior, tanto acá como
   * en la sesión del backend. Devuelve el texto del mensaje quitado (para editar/reenviar).
   */
  async rebobinar(idx: number): Promise<{ text: string; adjuntos?: Adjunto[] } | null> {
    const lista = this.messages();
    const m = lista[idx];
    if (!m || m.role !== 'user') return null;
    this.cancelar();
    // k-ésimo mensaje de usuario (así lo cuenta el backend en la sesión)
    const userIndex = lista.slice(0, idx).filter((x) => x.role === 'user').length;
    try {
      await firstValueFrom(this.api.rewindSession(this.sessionId(), userIndex));
    } catch (err: any) {
      throw new Error(err?.error?.error || 'No se pudo rebobinar la sesión');
    }
    this.messages.set(lista.slice(0, idx));
    this.guardarHistorial();
    this.thinking.set(false);
    return { text: m.text, adjuntos: m.adjuntos };
  }

  async send(text: string, adjuntos: Adjunto[] = []): Promise<void> {
    const userId = 'gui';
    const appName = 'yisus';

    this.messages.update((m) => [...m, { role: 'user', text, at: Date.now(), adjuntos: adjuntos.length ? adjuntos : undefined }]);
    this.thinking.set(true);
    this.pasoActual.set({ at: Date.now(), author: 'Coordinator', kind: 'pensando' });

    // Burbuja del agente que se va llenando con el stream
    const respuesta: ChatMessage = { role: 'agent', text: '', at: Date.now(), pasos: [], streaming: true };
    this.messages.update((m) => [...m, respuesta]);
    const actualizar = (patch: Partial<ChatMessage>) => {
      Object.assign(respuesta, patch);
      this.messages.update((m) => [...m]);
    };

    // Partes del mensaje: texto + adjuntos (inline para binarios, texto embebido para archivos de texto)
    const parts: any[] = [];
    const textosAdjuntos = adjuntos.filter((a) => a.text !== undefined);
    const binarios = adjuntos.filter((a) => a.data);
    let cuerpo = text;
    if (textosAdjuntos.length) {
      cuerpo += '\n\n' + textosAdjuntos.map((a) => `--- Archivo adjunto: ${a.name} ---\n${a.text}\n--- fin de ${a.name} ---`).join('\n\n');
    }
    if (cuerpo.trim()) parts.push({ text: cuerpo });
    for (const b of binarios) parts.push({ inlineData: { mimeType: b.mimeType, data: b.data } });
    if (!parts.length) parts.push({ text: '(adjunto)' });

    this.abort = new AbortController();

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const sesion = localStorage.getItem('yisus_auth_token');
      const adminKey = localStorage.getItem('yisus_admin_key');
      if (sesion) headers['Authorization'] = `Bearer ${sesion}`;
      else if (adminKey) headers['X-Admin-Key'] = adminKey;

      const res = await fetch(`${this.api.baseUrl}/run_sse`, {
        method: 'POST',
        headers,
        signal: this.abort.signal,
        body: JSON.stringify({ appName, userId, sessionId: this.sessionId(), newMessage: { role: 'user', parts } }),
      });

      if (res.status === 401) throw new Error('No autorizado: tu sesión venció, vuelve a iniciar sesión.');
      if (!res.ok) throw new Error(`El backend respondió HTTP ${res.status}`);
      if (!res.body) throw new Error('El backend no devolvió un stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const textos: string[] = [];
      let ultimoAutor: string | undefined;

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

          let evento: any;
          try { evento = JSON.parse(payload); } catch { continue; }

          if (evento?.type === 'directo') { actualizar({ directo: { name: evento.agent, displayName: evento.displayName } }); continue; }
          if (evento?.type === 'usage') {
            actualizar({ uso: { inputTokens: evento.inputTokens, outputTokens: evento.outputTokens, totalTokens: evento.totalTokens, costUsd: evento.costUsd, cachedTokens: evento.cachedTokens, thoughtsTokens: evento.thoughtsTokens, aproximado: !!evento.aproximado, porAgente: evento.porAgente } });
            continue;
          }
          if (evento?.error) throw new Error(evento.error);
          if (evento?.author === 'user') continue;
          // Error del modelo (clave sin crédito, proveedor caído…): el ADK lo manda
          // como evento con errorMessage y, a veces, sin texto.
          if (evento?.errorMessage && !(evento?.content?.parts || []).some((p: any) => p?.text)) {
            textos.push(`⚠️ ${evento.errorMessage}`);
            actualizar({ text: textos.join('\n\n'), error: true });
            continue;
          }

          const author = evento?.author || 'agente';
          const partsEv: any[] = evento?.content?.parts || [];

          // Pasos: llamadas a herramientas y sus respuestas
          for (const p of partsEv) {
            if (p?.functionCall) {
              const paso: Paso = { at: Date.now(), author, kind: 'herramienta', detail: p.functionCall.name };
              respuesta.pasos!.push(paso);
              this.pasoActual.set(paso);
            } else if (p?.functionResponse) {
              const paso: Paso = { at: Date.now(), author, kind: 'resultado', detail: p.functionResponse.name };
              respuesta.pasos!.push(paso);
              this.pasoActual.set({ at: Date.now(), author, kind: 'pensando' });
            }
          }
          if (author !== ultimoAutor) {
            ultimoAutor = author;
            if (!partsEv.some((p) => p?.functionCall || p?.functionResponse)) {
              this.pasoActual.set({ at: Date.now(), author, kind: 'pensando' });
            }
          }

          const texto = partsEv.map((p) => p?.text || '').filter(Boolean).join('');
          if (texto && evento.partial !== true) {
            textos.push(texto);
            actualizar({ text: textos.join('\n\n'), author });
          } else {
            actualizar({});
          }
        }
      }

      if (!respuesta.text.trim()) actualizar({ text: '(sin respuesta)' });
    } catch (err: any) {
      const cancelado = err?.name === 'AbortError';
      actualizar({ text: cancelado ? (respuesta.text.trim() ? respuesta.text + '\n\n_(detenido)_' : '_(detenido)_') : `Error: ${err?.message || err}`, error: !cancelado });
    } finally {
      actualizar({ streaming: false });
      this.thinking.set(false);
      this.pasoActual.set(null);
      this.abort = null;
      this.guardarHistorial();
    }
  }

  // ─── historial local (por sesión del navegador) ──────────────────────────
  private leerHistorial(): ChatMessage[] {
    try {
      const raw = localStorage.getItem(CLAVE_HISTORIAL);
      const lista: ChatMessage[] = raw ? JSON.parse(raw) : [];
      return lista.map((m) => ({ ...m, streaming: false, adjuntos: m.adjuntos?.map((a) => ({ ...a, data: undefined, text: undefined })) }));
    } catch { return []; }
  }
  private guardarHistorial() {
    try {
      // Sin los bytes de los adjuntos: solo nombre y tamaño
      const ligera = this.messages().slice(-60).map((m) => ({ ...m, adjuntos: m.adjuntos?.map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.size })) }));
      localStorage.setItem(CLAVE_HISTORIAL, JSON.stringify(ligera));
    } catch {}
  }
}
