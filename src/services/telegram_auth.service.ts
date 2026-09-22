import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  messageId: number;
  actionDescription: string;
  /** Canal que pidió la acción. Se fija al pedir, no al responder. */
  canal: string;
}

export class TelegramAuthService {
  // Ventana de gracia en milisegundos: si autorizas una vez, tienes 5 minutos de acceso continuo sin re-preguntar
  private gracePeriodMs: number = 5 * 60 * 1000;

  /**
   * Ventana de gracia POR CANAL.
   *
   * Antes era una sola marca global: aprobar algo por Telegram abría cinco
   * minutos en los que cualquier petición —incluida una que entrara por A2A o
   * por Buzz— ejecutaba acciones sensibles sin volver a preguntar. El permiso
   * que das en un canal no debe habilitar a otro.
   */
  private ultimaAprobacionPorCanal: Map<string, number> = new Map();

  /**
   * Enfriamiento por canal tras un "no": hasta este instante, las peticiones
   * sensibles de ese canal se rechazan sin mandar nada a Telegram.
   *
   * Sin esto, "denegar" solo cerraba UNA petición: el modelo probaba con la
   * siguiente conversación, la siguiente herramienta, y cada intento era otra
   * tarjeta en Telegram. Denegar debe significar "para".
   */
  private bloqueoHastaPorCanal: Map<string, number> = new Map();
  private readonly bloqueoTrasDenegarMs = 5 * 60 * 1000;
  private readonly bloqueoTrasExpirarMs = 60 * 1000;

  /** Canal que está pidiendo la acción (telegram, buzz, a2a, api, system) */
  private canalActual(): string {
    try {
      // Import perezoso: usage_collector arrastra al token tracker y este al bot,
      // que a su vez importa este servicio. En estático sería una dependencia circular.
      const mod = (globalThis as any).__yisusUsageScope;
      if (typeof mod === 'function') return mod()?.channel || 'system';
    } catch {}
    return 'system';
  }
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
  public hasActiveSession(canal?: string): boolean {
    const scope = canal || this.canalActual();
    const last = this.ultimaAprobacionPorCanal.get(scope) || 0;
    return Date.now() - last < this.gracePeriodMs;
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

    // OJO: acá NO sirve canalActual(). Este código corre en el contexto del
    // webhook de Telegram, no en el de la petición que pidió permiso: resolvía
    // "telegram"/"system" y la ventana se abría para el canal equivocado, así que
    // la siguiente acción del canal real volvía a preguntar.
    if (isApproved) {
      this.ultimaAprobacionPorCanal.set(pending.canal, Date.now());
      this.bloqueoHastaPorCanal.delete(pending.canal);
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
      this.ultimaAprobacionPorCanal.delete(pending.canal);
      this.bloqueoHastaPorCanal.set(pending.canal, Date.now() + this.bloqueoTrasDenegarMs);
      console.log(`🛡️ [TelegramAuth] Canal "${pending.canal}" bloqueado ${this.bloqueoTrasDenegarMs / 60000} min tras la denegación.`);
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

    const canal = this.canalActual();

    // 0. Si hace poco dijo que no (o no contestó), no se le vuelve a preguntar
    const bloqueadoHasta = this.bloqueoHastaPorCanal.get(canal) || 0;
    if (Date.now() < bloqueadoHasta) {
      const restante = Math.round((bloqueadoHasta - Date.now()) / 1000);
      console.log(`🛡️ [TelegramAuth] Rechazado sin preguntar: el canal "${canal}" está en enfriamiento (${restante}s). Acción: ${actionDescription}`);
      return false;
    }

    // 1. Si ya autorizó hace menos de 5 minutos, pasa directo
    if (this.hasActiveSession(canal)) {
      const last = this.ultimaAprobacionPorCanal.get(canal) || 0;
      const remainingSecs = Math.round((this.gracePeriodMs - (Date.now() - last)) / 1000);
      console.log(`🛡️ [TelegramAuth] Acceso permitido por sesión activa del canal "${canal}" (${remainingSecs}s restantes).`);
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
      `📡 <b>Canal:</b> ${canal}\n` +
      `⏰ <b>Hora:</b> ${new Date().toLocaleTimeString('es-CL')}\n\n` +
      `${question}\n\n` +
      `<i>Ojo: la autorización abre una ventana de 5 minutos para las acciones sensibles de ESTE canal (${canal}), no de los demás.</i>`;

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
          this.bloqueoHastaPorCanal.set(canal, Date.now() + this.bloqueoTrasExpirarMs);
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
          canal,
        });
      });
    } catch (error: any) {
      console.error('❌ [TelegramAuth] Error al solicitar autorización por Telegram:', error.message);
      return false;
    }
  }
}

export const telegramAuthService = new TelegramAuthService();
