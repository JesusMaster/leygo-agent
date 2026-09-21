import dotenv from 'dotenv';
import crypto from 'crypto';
import { googleService } from './google.service.js';
import { telegramBotService } from './telegram_bot.service.js';
import { messageFormatter } from '../utils/message_formatter.js';

dotenv.config();

export interface PendingDraftAction {
  draftId: string;
  to: string;
  subject: string;
  bodySnippet: string;
  createdAt: number;
  messageId?: number;
}

export class TelegramQuickActionsService {
  private pendingDrafts: Map<string, PendingDraftAction> = new Map();

  constructor() {}

  /**
   * Envía a Telegram una tarjeta interactiva para un nuevo borrador de correo
   */
  public async sendDraftApprovalCard(
    draftId: string,
    to: string,
    subject: string,
    body: string
  ): Promise<string | null> {
    try {
      const actionId = crypto.randomBytes(4).toString('hex'); // 8 caracteres
      const bodySnippet = body ? body.trim() : '';

      const cardHtml =
        `✉️ <b>NUEVO BORRADOR DE CORREO</b>\n\n` +
        `📌 <b>Para:</b> <code>${messageFormatter.escapeHtml(to)}</code>\n` +
        `📌 <b>Asunto:</b> <b>${messageFormatter.escapeHtml(subject)}</b>\n\n` +
        `📝 <b>Vista previa:</b>\n` +
        `<i>"${messageFormatter.escapeHtml(bodySnippet.length > 280 ? bodySnippet.substring(0, 280) + '...' : bodySnippet)}"</i>\n\n` +
        `¿Qué deseas hacer con este borrador?`;

      const replyMarkup = {
        inline_keyboard: [
          [
            { text: '🚀 Enviar ahora', callback_data: `send_draft_${actionId}` },
            { text: '⏳ Enviar después', callback_data: `defer_draft_${actionId}` },
          ],
        ],
      };

      const messageId = await telegramBotService.sendDirectMessage(cardHtml, {
        parseMode: 'HTML',
        replyMarkup,
      });

      this.pendingDrafts.set(actionId, {
        draftId,
        to,
        subject,
        bodySnippet,
        createdAt: Date.now(),
        messageId: messageId || undefined,
      });

      console.log(`✉️ [TelegramQuickActions] Tarjeta de borrador enviada a Telegram (ActionID: ${actionId}, DraftID: ${draftId})`);
      return actionId;
    } catch (err: any) {
      console.error('❌ [TelegramQuickActions] Error enviando tarjeta de borrador a Telegram:', err.message);
      return null;
    }
  }

  /**
   * Procesa los callbacks interactivos de borradores de correo
   */
  public async handleCallbackQuery(cq: any): Promise<boolean> {
    const data = cq.data || '';
    const callbackId = cq.id;
    const messageId = cq.message?.message_id;
    const chatId = cq.message?.chat?.id;

    if (!data.startsWith('send_draft_') && !data.startsWith('defer_draft_')) {
      return false;
    }

    const isSend = data.startsWith('send_draft_');
    const actionId = isSend ? data.replace('send_draft_', '') : data.replace('defer_draft_', '');
    const pending = this.pendingDrafts.get(actionId);

    if (!pending) {
      await telegramBotService.answerCallbackQuery(callbackId, 'Esta acción ya fue procesada o expiró.');
      if (chatId && messageId) {
        await telegramBotService.editMessageText(
          chatId,
          messageId,
          '⚠️ <i>Esta acción de borrador ya no está disponible o fue procesada anteriormente.</i>',
          { parseMode: 'HTML', replyMarkup: { inline_keyboard: [] } }
        );
      }
      return true;
    }

    const timeStr = new Date().toLocaleTimeString('es-CL');

    if (isSend) {
      try {
        console.log(`🚀 [TelegramQuickActions] Enviando borrador ${pending.draftId} a "${pending.to}" vía Gmail API...`);
        await googleService.sendDraft(pending.draftId);

        await telegramBotService.answerCallbackQuery(callbackId, '✅ Correo enviado con éxito');

        const updatedHtml =
          `✅ <b>CORREO ENVIADO CON ÉXITO</b>\n\n` +
          `📌 <b>Para:</b> <code>${messageFormatter.escapeHtml(pending.to)}</code>\n` +
          `📌 <b>Asunto:</b> <b>${messageFormatter.escapeHtml(pending.subject)}</b>\n` +
          `⏰ <b>Despachado:</b> ${timeStr}\n\n` +
          `<i>(Enviado oficialmente a través de tu cuenta de Google Workspace)</i>`;

        if (chatId && (messageId || pending.messageId)) {
          await telegramBotService.editMessageText(
            chatId,
            messageId || pending.messageId!,
            updatedHtml,
            { parseMode: 'HTML', replyMarkup: { inline_keyboard: [] } }
          );
        }

        this.pendingDrafts.delete(actionId);
        return true;
      } catch (err: any) {
        console.error('❌ [TelegramQuickActions] Error al despachar borrador:', err.message);
        await telegramBotService.answerCallbackQuery(callbackId, `❌ Error al enviar: ${err.message}`);
        return true;
      }
    } else {
      // Opción: Enviar después (dejar en borrador)
      console.log(`⏳ [TelegramQuickActions] Borrador ${pending.draftId} conservado en Gmail para enviar después.`);
      await telegramBotService.answerCallbackQuery(callbackId, '⏳ Guardado en borradores de Gmail');

      const updatedHtml =
        `⏳ <b>GUARDADO EN BORRADORES</b>\n\n` +
        `📌 <b>Para:</b> <code>${messageFormatter.escapeHtml(pending.to)}</code>\n` +
        `📌 <b>Asunto:</b> <b>${messageFormatter.escapeHtml(pending.subject)}</b>\n` +
        `💾 <b>Estado:</b> Conservado intacto en tu bandeja de Gmail para que lo revises o envíes después.\n` +
        `⏰ <b>Hora:</b> ${timeStr}`;

      if (chatId && (messageId || pending.messageId)) {
        await telegramBotService.editMessageText(
          chatId,
          messageId || pending.messageId!,
          updatedHtml,
          { parseMode: 'HTML', replyMarkup: { inline_keyboard: [] } }
        );
      }

      this.pendingDrafts.delete(actionId);
      return true;
    }
  }
}

export const telegramQuickActionsService = new TelegramQuickActionsService();
