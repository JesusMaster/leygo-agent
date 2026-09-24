import axios from 'axios';
import { customAgentsService } from '../agents/custom/custom_agents.service.js';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { Runner } from '@google/adk';
import { RedisSessionService } from './redis_session.service.js';
import { telegramAuthService } from './telegram_auth.service.js';
import { beginUsageScope, flushUsageScope, anotarPasosDeEvento } from '../utils/usage_collector.js';
import { messageFormatter } from '../utils/message_formatter.js';
import { tokenTrackerService } from './token_tracker.service.js';
import { attachmentsService } from './attachments.service.js';
import { sqliteReminderService } from '../database/sqlite.service.js';

dotenv.config();

/**
 * Escapa caracteres reservados para Telegram HTML
 */
function escapeHtml(str: string): string {
  return messageFormatter.escapeHtml(str);
}

/**
 * Convierte markdown común a HTML compatible con Telegram
 */
function markdownToTelegramHtml(markdown: string): string {
  return messageFormatter.formatForTelegram(markdown);
}

/**
 * Divide un texto largo en trozos que no superen el límite de 4000 caracteres de Telegram
 */
function splitMessage(text: string, maxLength: number = 4000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      splitIdx = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      splitIdx = maxLength;
    }
    chunks.push(remaining.substring(0, splitIdx).trim());
    remaining = remaining.substring(splitIdx).trim();
  }

  return chunks;
}

export class TelegramBotService {
  private token: string;
  private chatId: string;
  private baseUrl: string;
  private webhookUrl: string;
  private isRunning: boolean = false;
  private lastUpdateId: number = 0;
  private runner: Runner | null = null;
  private sessionService: RedisSessionService | null = null;
  private ai: GoogleGenAI;

  constructor() {
    this.token = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    this.webhookUrl = process.env.WEBHOOK_URL ? process.env.WEBHOOK_URL.trim() : '';
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  }

  /**
   * Inicia el bot de Telegram (Modo Webhook si hay WEBHOOK_URL, o Long Polling si no)
   */
  public async start(runner: Runner, sessionService: RedisSessionService): Promise<void> {
    if (!this.token) {
      console.warn('⚠️ [TelegramBot] TELEGRAM_TOKEN no configurado. El bot interactivo no se iniciará.');
      return;
    }
    if (!this.chatId) {
      console.warn('⚠️ [TelegramBot] TELEGRAM_CHAT_ID no configurado. Solo responderá a chats autorizados.');
    }

    this.runner = runner;
    this.sessionService = sessionService;

    // Conectar este bot como despachador de callbacks hacia telegramAuthService
    telegramAuthService.setBotInstance(this);

    // MODO 1: WEBHOOK (Estilo Leygo con URL pública)
    if (this.webhookUrl) {
      const webhookEndpoint = `${this.webhookUrl.replace(/\/$/, '')}/webhook`;
      console.log(`🌐 [TelegramBot] Configurando Webhook en Telegram: ${webhookEndpoint}`);
      try {
        await axios.post(`${this.baseUrl}/setWebhook`, { url: webhookEndpoint });
        console.log(`✅ [TelegramBot] Webhook configurado exitosamente en ${webhookEndpoint}`);
      } catch (err: any) {
        console.error('❌ [TelegramBot] Error configurando webhook:', err.response?.data || err.message);
      }
      return;
    }

    // MODO 2: LONG POLLING (Sin necesidad de URL pública ni ngrok)
    console.log('🤖 [TelegramBot] Sin WEBHOOK_URL: Usando Long Polling (recibe mensajes directamente sin URL)...');
    try {
      // Limpiar webhook anterior para que Telegram permita getUpdates
      await axios.post(`${this.baseUrl}/deleteWebhook`, { drop_pending_updates: false });
    } catch (delErr: any) {
      console.warn('⚠️ [TelegramBot] Error al limpiar webhook previo:', delErr.message);
    }

    this.isRunning = true;
    // Lanzar loop en background
    this.pollingLoop().catch((err) => {
      console.error('❌ [TelegramBot] Error crítico en loop de Telegram:', err.message);
    });
  }

  /**
   * Recibe y procesa un update proveniente de una petición HTTP POST /webhook
   */
  public async handleWebhookUpdate(update: any): Promise<void> {
    await this.processUpdate(update);
  }

  /**
   * Detiene el polling de Telegram
   */
  public stop(): void {
    console.log('🛑 [TelegramBot] Deteniendo polling de Telegram...');
    this.isRunning = false;
  }

  /**
   * Envía un mensaje directo a Jesús (chatId configurado)
   */
  public async sendDirectMessage(text: string, options: { parseMode?: 'HTML' | 'Markdown'; replyMarkup?: any } = {}): Promise<number | null> {
    if (!this.chatId) return null;
    return this.sendMessage(this.chatId, text, options);
  }

  /**
   * Envía un mensaje a un chat específico
   */
  /**
   * Sesión por chat con caducidad por inactividad: cada turno del Coordinator paga
   * TODO el historial de la sesión, así que un "Hola" del día siguiente no debe
   * arrastrar la conversación de ayer. Tras TELEGRAM_SESSION_IDLE_MIN minutos sin
   * mensajes (por defecto 240) se abre una sesión nueva; /nueva la fuerza.
   */
  private sessionIdPara(chatId: string | number): string {
    const clave = `telegram.session.${chatId}`;
    const idleMin = Number(process.env.TELEGRAM_SESSION_IDLE_MIN) || 240;
    let estado: { id: string; last: number } | null = null;
    try { const raw = sqliteReminderService.getConfig(clave, ''); estado = raw ? JSON.parse(raw) : null; } catch { estado = null; }
    const ahora = Date.now();
    if (!estado || ahora - estado.last > idleMin * 60_000) {
      if (estado) console.log(`🧹 [TelegramBot] Sesión de ${chatId} caducó por inactividad (${Math.round((ahora - estado.last) / 60000)} min): se abre una nueva.`);
      estado = { id: `telegram-${chatId}-${ahora.toString(36)}`, last: ahora };
    } else estado.last = ahora;
    sqliteReminderService.setConfig(clave, JSON.stringify(estado));
    return estado.id;
  }

  private nuevaSesion(chatId: string | number): void {
    sqliteReminderService.setConfig(`telegram.session.${chatId}`, JSON.stringify({ id: `telegram-${chatId}-${Date.now().toString(36)}`, last: Date.now() }));
  }

  public async sendMessage(
    chatId: string | number,
    text: string,
    options: { parseMode?: 'HTML' | 'Markdown'; replyMarkup?: any } = {}
  ): Promise<number | null> {
    try {
      // Marcadores [[adjunto:ID]] → se quitan del texto y se envían como foto/documento al final
      const { texto: sinAdjuntos, adjuntos } = attachmentsService.extraer(text, `telegram:${chatId}`);
      if (adjuntos.length) text = sinAdjuntos || (adjuntos[0].caption ? '' : '📎');
      const chunks = splitMessage(text, 4000);
      let firstMsgId: number | null = null;

      for (let i = 0; i < chunks.length; i++) {
        const payload: any = {
          chat_id: chatId,
          text: chunks[i],
        };
        if (options.parseMode) {
          payload.parse_mode = options.parseMode;
        }
        if (i === chunks.length - 1 && options.replyMarkup) {
          payload.reply_markup = options.replyMarkup;
        }

        try {
          const res = await axios.post(`${this.baseUrl}/sendMessage`, payload);
          if (i === 0) firstMsgId = res.data.result.message_id;
        } catch (postErr: any) {
          // Fallback a texto plano si falla el parse_mode
          if (payload.parse_mode) {
            delete payload.parse_mode;
            const res = await axios.post(`${this.baseUrl}/sendMessage`, payload);
            if (i === 0) firstMsgId = res.data.result.message_id;
          } else {
            throw postErr;
          }
        }
      }
      for (const a of adjuntos) await this.sendAttachment(chatId, a.id, a.caption);
      return firstMsgId;
    } catch (err: any) {
      console.error(`❌ [TelegramBot] Error enviando mensaje a ${chatId}:`, err.response?.data || err.message);
      return null;
    }
  }

  /** Foto (imágenes hasta 10 MB) o documento, subido como multipart. */
  public async sendAttachment(chatId: string | number, adjuntoId: string, caption?: string): Promise<boolean> {
    const a = attachmentsService.leer(adjuntoId);
    if (!a) return false;
    const esFoto = a.meta.tipo === 'imagen' && a.meta.bytes <= 10 * 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(a.meta.mime);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption.slice(0, 1024));
    form.append(esFoto ? 'photo' : 'document', new Blob([new Uint8Array(a.buffer)], { type: a.meta.mime }), a.meta.nombre);
    try {
      await axios.post(`${this.baseUrl}/${esFoto ? 'sendPhoto' : 'sendDocument'}`, form, { maxBodyLength: Infinity });
      return true;
    } catch (err: any) {
      console.error(`❌ [TelegramBot] Error enviando adjunto ${adjuntoId}:`, err.response?.data || err.message);
      await this.sendMessage(chatId, `📎 ${a.meta.nombre}: ${attachmentsService.urlPublica(a.meta.id)}`);
      return false;
    }
  }

  /**
   * Edita el texto de un mensaje existente
   */
  public async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    options: { parseMode?: 'HTML' | 'Markdown'; replyMarkup?: any } = {}
  ): Promise<boolean> {
    try {
      const payload: any = {
        chat_id: chatId,
        message_id: messageId,
        text,
      };
      if (options.parseMode) {
        payload.parse_mode = options.parseMode;
      }
      if (options.replyMarkup) {
        payload.reply_markup = options.replyMarkup;
      }

      try {
        await axios.post(`${this.baseUrl}/editMessageText`, payload);
        return true;
      } catch (editErr: any) {
        // Fallback a texto plano
        if (payload.parse_mode) {
          delete payload.parse_mode;
          await axios.post(`${this.baseUrl}/editMessageText`, payload);
          return true;
        }
        throw editErr;
      }
    } catch (err: any) {
      console.error(`❌ [TelegramBot] Error editando mensaje ${messageId}:`, err.response?.data || err.message);
      return false;
    }
  }

  /**
   * Responde a un callback query (cierra el loading spinner en Telegram)
   */
  public async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await axios.post(`${this.baseUrl}/answerCallbackQuery`, {
        callback_query_id: callbackQueryId,
        text,
      });
    } catch (err: any) {
      console.error('❌ [TelegramBot] Error en answerCallbackQuery:', err.message);
    }
  }

  /**
   * Descarga un archivo de audio o voz de Telegram y retorna un Buffer
   */
  private async downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const fileInfoRes = await axios.get(`${this.baseUrl}/getFile?file_id=${fileId}`);
    const filePath = fileInfoRes.data.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;

    const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);

    let mimeType = 'audio/ogg';
    if (filePath.endsWith('.mp3')) mimeType = 'audio/mp3';
    else if (filePath.endsWith('.wav')) mimeType = 'audio/wav';
    else if (filePath.endsWith('.m4a')) mimeType = 'audio/m4a';

    return { buffer, mimeType };
  }

  /**
   * Transcribe una nota de voz o audio usando Gemini 2.5 Flash de forma nativa
   */
  private async transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
    const base64Data = buffer.toString('base64');
    const response = await this.ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Data,
              },
            },
            {
              text: 'Transcribe fielmente este audio en español (de Chile si corresponde). Devuelve ÚNICAMENTE el texto transcrito, sin preámbulos ni comillas adicionales.',
            },
          ],
        },
      ],
    });

    if (response.usageMetadata) {
      tokenTrackerService.logUsage(
        'Transcripción nota de voz',
        'gemini-2.5-flash',
        tokenTrackerService.extractUsage(response.usageMetadata).inputTokens,
        tokenTrackerService.extractUsage(response.usageMetadata).outputTokens,
        'audio_system',
          'telegram',
          'voice_transcription'
        ).catch(() => {});
    }

    return response.text?.trim() || '';
  }

  /**
   * Loop principal de long polling
   */
  private async pollingLoop(): Promise<void> {
    // Al arrancar, ignoramos mensajes antiguos para no procesar spam anterior
    try {
      const init = await axios.get(`${this.baseUrl}/getUpdates?offset=-1`);
      if (init.data.result && init.data.result.length > 0) {
        this.lastUpdateId = init.data.result[init.data.result.length - 1].update_id + 1;
      }
    } catch {
      // Si falla, el loop intentará con offset 0
    }

    while (this.isRunning) {
      try {
        const res = await axios.get(`${this.baseUrl}/getUpdates?offset=${this.lastUpdateId}&timeout=25`);
        const updates = res.data.result || [];

        for (const update of updates) {
          this.lastUpdateId = update.update_id + 1;
          await this.processUpdate(update);
        }
      } catch (err: any) {
        // Pausa breve ante desconexiones de red
        if (this.isRunning) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    }
  }

  /**
   * Procesa cada update recibido de Telegram
   */
  private async processUpdate(update: any): Promise<void> {
    // 1. Manejo de Callback Queries (botones inline, p. ej. 2FA)
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    // 2. Manejo de Mensajes (texto o audio) en background para NO bloquear el loop de getUpdates
    if (update.message) {
      this.handleIncomingMessage(update.message).catch((err) => {
        console.error('❌ [TelegramBot] Error procesando mensaje entrante:', err.message);
      });
    }
  }

  /**
   * Despacha callback queries hacia telegramAuthService, telegramQuickActionsService u otros receptores
   */
  private async handleCallbackQuery(cq: any): Promise<void> {
    const data = cq.data || '';
    if (data.startsWith('auth_ok_') || data.startsWith('auth_no_')) {
      await telegramAuthService.handleCallbackQuery(cq);
    } else if (data.startsWith('send_draft_') || data.startsWith('defer_draft_')) {
      const { telegramQuickActionsService } = await import('./telegram_quick_actions.service.js');
      await telegramQuickActionsService.handleCallbackQuery(cq);
    } else {
      await this.answerCallbackQuery(cq.id);
    }
  }

  /**
   * Procesa un mensaje entrante (validación de seguridad, audio/texto, ADK runner)
   */
  private async handleIncomingMessage(msg: any): Promise<void> {
    const senderChatId = msg.chat?.id?.toString();
    const senderName = msg.from?.first_name || 'Usuario';

    // 🛡️ Filtro de seguridad: solo el chat de Jesús está autorizado
    if (this.chatId && senderChatId !== this.chatId) {
      console.warn(`🛡️ [TelegramBot] Intento de acceso no autorizado desde Chat ID ${senderChatId} (${senderName}).`);
      await this.sendMessage(senderChatId, '⛔ Acceso restringido. Este bot es el asistente privado y clon digital de Jesús Leiva.');
      return;
    }

    let userPrompt: string = '';
    let isVoice = false;

    // Caso A: Mensaje de audio o nota de voz
    if (msg.voice || msg.audio) {
      isVoice = true;
      const fileId = msg.voice?.file_id || msg.audio?.file_id;
      try {
        await this.sendMessage(senderChatId, '🎧 <i>Procesando nota de voz con Gemini...</i>', { parseMode: 'HTML' });
        const { buffer, mimeType } = await this.downloadTelegramFile(fileId);
        userPrompt = await this.transcribeAudio(buffer, mimeType);
        
        if (!userPrompt) {
          await this.sendMessage(senderChatId, '⚠️ No pude distinguir audio claro en el mensaje.');
          return;
        }

        // Mostrar acuse de transcripción
        await this.sendMessage(
          senderChatId,
          `🎙️ <b>Transcripción:</b>\n<i>"${escapeHtml(userPrompt)}"</i>`,
          { parseMode: 'HTML' }
        );
      } catch (err: any) {
        console.error('❌ [TelegramBot] Error transcribiendo audio:', err.message);
        await this.sendMessage(senderChatId, `❌ Error al procesar audio: ${err.message}`);
        return;
      }
    } 
    // Caso B: Mensaje de texto
    else if (msg.text) {
      userPrompt = msg.text.trim();
    } else {
      // Ignorar otros tipos (stickers, ubicaciones, etc.)
      return;
    }

    if (!userPrompt) return;

    // Comandos rápidos
    if (userPrompt === '/start' || userPrompt === '/ayuda') {
      const welcome = `👋 <b>Hola Jesús, soy tu clon digital (Yisus Agent).</b>\n\n` +
        `Puedes hablarme directamente en texto o notas de voz:\n` +
        `• <b>Consultar agenda:</b> <i>"¿Qué reuniones tengo hoy?"</i>\n` +
        `• <b>Correos:</b> <i>"Revisa si tengo correos urgentes de Apprecio"</i>\n` +
        `• <b>Arquitectura:</b> <i>"Explícame el dominio de puntos"</i>\n` +
        `• <b>Recordatorios:</b> <i>"Recuérdame en 30 minutos revisar la PR de pagos"</i>\n` +
        `• <b>Google Meet:</b> <i>"Ingesta esta reunión: [link]"</i>\n\n` +
        `Todas las operaciones protegidas seguirán pidiendo tu 2FA cuando sea necesario.`;
      await this.sendMessage(senderChatId, welcome, { parseMode: 'HTML' });
      return;
    }

    // /nueva: empezar una conversación limpia (el historial anterior queda en memoria episódica)
    if (/^\/(nueva|new|reset)\b/i.test(userPrompt)) {
      this.nuevaSesion(senderChatId);
      await this.sendMessage(senderChatId, '🧹 Conversación nueva. Lo anterior queda en la memoria episódica.');
      return;
    }

    // 3. Ejecutar a través de ADK Runner
    if (!this.runner || !this.sessionService) {
      await this.sendMessage(senderChatId, '⚠️ El agente aún no está listo en el servidor.');
      return;
    }

    // Mensaje de estado
    const statusMsgId = await this.sendMessage(senderChatId, '⏳ <i>Pensando...</i>', { parseMode: 'HTML' });

    try {
      const appName = process.env.ADK_APP_NAME || 'yisus';
      const userId = 'jesus';
      const sessionId = this.sessionIdPara(senderChatId);

      let session = await this.sessionService.getSession({ appName, userId, sessionId });
      if (!session) {
        session = await this.sessionService.createSession({ appName, userId, sessionId });
      }

      let accumulatedText = '';
      let errorModelo = '';
      beginUsageScope('telegram', sessionId, userPrompt);

      // "@nami …" → directo al agente personalizado, sin Coordinator
      const turno = await customAgentsService.prepararTurno({
        canal: 'telegram', appName, sessionService: this.sessionService, runnerCoordinator: this.runner,
        newMessage: { role: 'user', parts: [{ text: userPrompt }] },
      });
      if (turno.aviso) accumulatedText = turno.aviso;
      else for await (const event of turno.runner.runAsync({
        userId,
        sessionId: session.id,
        newMessage: turno.newMessage,
      })) {
        anotarPasosDeEvento(event);
        if ((event as any).errorMessage) errorModelo = (event as any).errorMessage;
        if (event.content?.parts) {
          for (const part of event.content.parts) {
            if (part.text && event.author !== 'user') {
              accumulatedText += part.text;
            }
          }
        }
      }

      // Persistir el consumo del turno (incluye lo que gastaron los subagentes)
      flushUsageScope().catch(() => {});

      if (!accumulatedText.trim()) {
        accumulatedText = errorModelo
          ? `⚠️ El modelo no pudo responder: ${errorModelo}`
          : 'Listo. Acción ejecutada sin respuesta adicional.';
      }

      if (turno.directo && !turno.aviso) accumulatedText = `**${turno.directo.displayName}** (directo)\n\n${accumulatedText}`;
      const extraccion = attachmentsService.extraer(accumulatedText, `telegram:${senderChatId}`);
      accumulatedText = extraccion.texto || (extraccion.adjuntos.length ? '📎' : accumulatedText);
      const formattedHtml = markdownToTelegramHtml(accumulatedText);
      const chunks = splitMessage(formattedHtml, 4000);

      // Reemplazamos el mensaje de "Pensando..." con el primer chunk
      if (statusMsgId && chunks.length > 0) {
        const edited = await this.editMessageText(senderChatId, statusMsgId, chunks[0], { parseMode: 'HTML' });
        // Si falló por alguna razón de formato, enviar como nuevo
        if (!edited) {
          await this.sendMessage(senderChatId, chunks[0], { parseMode: 'HTML' });
        }
        // Enviar chunks subsiguientes si la respuesta era muy larga
        for (let i = 1; i < chunks.length; i++) {
          await this.sendMessage(senderChatId, chunks[i], { parseMode: 'HTML' });
        }
      } else {
        await this.sendMessage(senderChatId, formattedHtml, { parseMode: 'HTML' });
      }
      for (const a of extraccion.adjuntos) await this.sendAttachment(senderChatId, a.id, a.caption);
    } catch (err: any) {
      console.error('❌ [TelegramBot] Error ejecutando agente para Telegram:', err);
      const errMsg = `❌ Ocurrió un error al procesar tu solicitud:\n<code>${escapeHtml(err.message)}</code>`;
      if (statusMsgId) {
        await this.editMessageText(senderChatId, statusMsgId, errMsg, { parseMode: 'HTML' });
      } else {
        await this.sendMessage(senderChatId, errMsg, { parseMode: 'HTML' });
      }
    }
  }
}

export const telegramBotService = new TelegramBotService();
