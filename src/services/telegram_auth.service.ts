import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  messageId: number;
  actionDescription: string;
}

export class TelegramAuthService {
  // Ventana de gracia en milisegundos: si autorizas una vez, tienes 5 minutos de acceso continuo sin re-preguntar
  private gracePeriodMs: number = 5 * 60 * 1000;
  private lastAuthorizedAt: number = 0;
  private botInstance: any = null;
  private pendingApprovals: Map<string, PendingApproval> = new Map();

  private get baseUrl(): string {
    const token = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
    return `https://api.telegram.org/bot${token}`;
  }

  private get chatId(): string {
    return process.env.TELEGRAM_CHAT_ID || '';
  }

  constructor() {}

  /**
   * Conecta la instancia activa de TelegramBotService para despachar eventos sin polling duplicado
   */
  public setBotInstance(bot: any): void {
    this.botInstance = bot;
  }

  /**
   * Verifica si la sesión actual cuenta con un pase temporal activo.
   */
  public hasActiveSession(): boolean {
    const now = Date.now();
    return now - this.lastAuthorizedAt < this.gracePeriodMs;
  }

  /**
   * Procesa un callback_query proveniente del bot de Telegram
   */
  public async handleCallbackQuery(cq: any): Promise<boolean> {
    const data = cq.data || '';
    const callbackId = cq.id;
    const messageId = cq.message?.message_id;

    let requestId = '';
    let isApproved = false;

    if (data.startsWith('auth_ok_')) {
      requestId = data.replace('auth_ok_', '');
      isApproved = true;
    } else if (data.startsWith('auth_no_')) {
      requestId = data.replace('auth_no_', '');
      isApproved = false;
    } else {
      return false;
    }

    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      // Ya expiró o fue respondida
      await axios.post(`${this.baseUrl}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text: 'Esta solicitud ya no está disponible.',
      }).catch(() => {});
      return true;
    }

    // Cancelar timer de timeout
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(requestId);

    const timeStr = new Date().toLocaleTimeString('es-CL');
    console.log(`🛡️ [TelegramAuth] Callback query recibido para ${requestId}: ${isApproved ? 'APROBADO' : 'DENEGADO'}`);

    if (isApproved) {
      this.lastAuthorizedAt = Date.now();
      // 1. Responder a Telegram con un toast nativo (desaparece solo en 2 segundos en el teléfono)
      await axios.post(`${this.baseUrl}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text: '✅ Acceso autorizado por 5 minutos.',
      }).catch((err) => console.warn('⚠️ [TelegramAuth] Error answerCallbackQuery:', err.message));

      // 2. Eliminar el mensaje de solicitud del chat para que no ensucie la conversación
      await axios.post(`${this.baseUrl}/deleteMessage`, {
        chat_id: this.chatId,
        message_id: pending.messageId || messageId,
      }).catch((err) => console.warn('⚠️ [TelegramAuth] Error deleteMessage:', err.message));

      pending.resolve(true);
    } else {
      this.lastAuthorizedAt = 0;
      await axios.post(`${this.baseUrl}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text: '❌ Acceso denegado.',
      }).catch((err) => console.warn('⚠️ [TelegramAuth] Error answerCallbackQuery:', err.message));

      // Eliminar el mensaje de confirmación
      await axios.post(`${this.baseUrl}/deleteMessage`, {
        chat_id: this.chatId,
        message_id: pending.messageId || messageId,
      }).catch((err) => console.warn('⚠️ [TelegramAuth] Error deleteMessage:', err.message));

      pending.resolve(false);
    }

    return true;
  }

  /**
   * Solicita confirmación en tiempo real al Telegram de Jesús.
   * Envía un mensaje interactivo con botones inline y espera la respuesta.
   *
   * @param actionDescription Descripción clara de la acción a autorizar
   * @param timeoutMs Tiempo máximo de espera en ms (default: 45 segundos)
   */
  async requestApproval(
    actionDescription: string,
    timeoutMs: number = 45000,
    scope?: { title?: string; subtitle?: string; question?: string }
  ): Promise<boolean> {
    if (!this.chatId) {
      console.warn('⚠️ [TelegramAuth] TELEGRAM_CHAT_ID no configurado en .env.');
      return false;
    }

    // 1. Si ya autorizó hace menos de 5 minutos, pasa directo
    if (this.hasActiveSession()) {
      const remainingSecs = Math.round((this.gracePeriodMs - (Date.now() - this.lastAuthorizedAt)) / 1000);
      console.log(`🛡️ [TelegramAuth] Acceso permitido por sesión activa (${remainingSecs}s restantes).`);
      return true;
    }

    const requestId = Math.random().toString(36).substring(2, 8);
    const allowData = `auth_ok_${requestId}`;
    const denyData = `auth_no_${requestId}`;

    const title    = scope?.title    || 'SOLICITUD DE AUTORIZACIÓN (Yisus Agent)';
    const subtitle = scope?.subtitle || 'Se solicita ejecutar una acción en tu nombre:';
    const question = scope?.question || '¿Autorizas esta acción por los próximos 5 minutos?';

    const text = `🔐 <b>${title}</b>\n\n` +
      `${subtitle}\n` +
      `📌 <b>Acción:</b> ${actionDescription}\n` +
      `⏰ <b>Hora:</b> ${new Date().toLocaleTimeString('es-CL')}\n\n` +
      `${question}\n\n` +
      `<i>Ojo: la autorización abre una ventana de 5 minutos para todas las acciones sensibles, no solo esta.</i>`;

    try {
      // Enviar mensaje con botones interactivos
      const sendRes = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Autorizar (5 min)', callback_data: allowData },
              { text: '❌ Denegar', callback_data: denyData },
            ],
          ],
        },
      });

      const messageId = sendRes.data.result.message_id;

      // Retornar promesa coordinada con el bot (o fallback si no hay bot corriendo)
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(async () => {
          this.pendingApprovals.delete(requestId);
          // Actualizar mensaje de Telegram con timeout expirado
          await axios.post(`${this.baseUrl}/editMessageText`, {
            chat_id: this.chatId,
            message_id: messageId,
            text: `⏳ <b>Solicitud Expirada</b>\n\n📌 ${actionDescription}\nNo hubo respuesta en ${Math.round(timeoutMs / 1000)}s (Acceso denegado por seguridad).`,
            parse_mode: 'HTML',
          }).catch(() => {});
          resolve(false);
        }, timeoutMs);

        this.pendingApprovals.set(requestId, {
          resolve,
          timer,
          messageId,
          actionDescription,
        });
      });
    } catch (error: any) {
      console.error('❌ [TelegramAuth] Error al solicitar autorización por Telegram:', error.message);
      return false;
    }
  }
}

export const telegramAuthService = new TelegramAuthService();
