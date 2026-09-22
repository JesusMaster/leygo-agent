import axios from 'axios';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { sqliteReminderService, CustomWebhook, CustomWebhookLog } from '../database/sqlite.service.js';
import { telegramBotService } from './telegram_bot.service.js';
import { messageFormatter, ChannelType } from '../utils/message_formatter.js';
import { tokenTrackerService } from './token_tracker.service.js';

dotenv.config();

export interface ExecuteCustomWebhookResult {
  status: 'success' | 'paused' | 'not_found' | 'error';
  message: string;
  webhookId?: string;
  response?: string;
}

export class CustomWebhookService {
  private ai: GoogleGenAI;
  private ollamaUrl: string;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
    this.ollamaUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL || 'https://ollama.openip.cl';
  }

  /**
   * Obtiene la URL pública o base para invocar el webhook
   */
  public getWebhookUrl(id: string, hostHeader?: string): string {
    const baseUrl = process.env.WEBHOOK_BASE_URL || (hostHeader ? `http://${hostHeader}` : 'http://localhost:8000');
    return `${baseUrl.replace(/\/$/, '')}/api/webhook/${id}`;
  }

  /**
   * Crea un webhook personalizado con IA
   */
  public createWebhook(
    titulo: string,
    instrucciones: string,
    modelo: string = 'gemini-2.5-flash',
    hostHeader?: string
  ): CustomWebhook & { url: string } {
    const wh = sqliteReminderService.createCustomWebhook(titulo, instrucciones, modelo);
    const url = this.getWebhookUrl(wh.id, hostHeader);
    return {
      ...wh,
      url,
    };
  }

  /**
   * Lista todos los webhooks creados con su URL armada
   */
  public listWebhooks(hostHeader?: string): Array<CustomWebhook & { url: string }> {
    const items = sqliteReminderService.getCustomWebhooks();
    return items.map((wh) => ({
      ...wh,
      url: this.getWebhookUrl(wh.id, hostHeader),
    }));
  }

  /**
   * Obtiene un webhook por su ID
   */
  public getWebhook(id: string, hostHeader?: string): (CustomWebhook & { url: string }) | null {
    const wh = sqliteReminderService.getCustomWebhook(id);
    if (!wh) return null;
    return {
      ...wh,
      url: this.getWebhookUrl(wh.id, hostHeader),
    };
  }

  /**
   * Actualiza los datos o estado de un webhook
   */
  public updateWebhook(
    id: string,
    fields: { titulo?: string; instrucciones?: string; modelo?: string; paused?: number },
    hostHeader?: string
  ): (CustomWebhook & { url: string }) | null {
    const updated = sqliteReminderService.updateCustomWebhook(id, fields);
    if (!updated) return null;
    return {
      ...updated,
      url: this.getWebhookUrl(updated.id, hostHeader),
    };
  }

  /**
   * Elimina un webhook y sus registros
   */
  public deleteWebhook(id: string): boolean {
    return sqliteReminderService.deleteCustomWebhook(id);
  }

  /**
   * Obtiene los logs de ejecución de un webhook
   */
  public deleteLog(logId: number): boolean {
    return sqliteReminderService.deleteCustomWebhookLog(logId);
  }

  public getAllLogs(limit: number = 50) {
    return sqliteReminderService.getAllCustomWebhookLogs(limit);
  }

  /**
   * Modelos que la GUI puede ofrecer: los de Ollama (consultando /api/tags) más
   * los de Gemini que se usan en el proyecto. Si Ollama no responde, solo Gemini.
   */
  public async listModels(): Promise<Array<{ id: string; label: string; provider: 'ollama' | 'gemini' }>> {
    const gemini = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
      .map((id) => ({ id, label: id, provider: 'gemini' as const }));

    let ollama: Array<{ id: string; label: string; provider: 'ollama' }> = [];
    try {
      const res = await axios.get(`${this.ollamaUrl.replace(/\/$/, '')}/api/tags`, { timeout: 4000 });
      ollama = (res.data?.models || [])
        .map((m: any) => m.name as string)
        .filter((n: string) => n && !/embed/i.test(n)) // los de embeddings no generan texto
        .map((n: string) => ({ id: `${n} (ollama)`, label: `${n} (ollama)`, provider: 'ollama' as const }));
    } catch {
      // Ollama caído o inalcanzable: se ofrece solo Gemini
    }
    return [...ollama, ...gemini];
  }

  public getLogs(webhookId?: string, limit: number = 20): CustomWebhookLog[] {
    return sqliteReminderService.getCustomWebhookLogs(webhookId, limit);
  }

  /**
   * Ejecuta el webhook cuando un servicio externo le hace un HTTP POST
   */
  public async executeWebhook(
    id: string,
    payload: any,
    headers: Record<string, any> = {}
  ): Promise<ExecuteCustomWebhookResult> {
    const wh = sqliteReminderService.getCustomWebhook(id);

    if (!wh) {
      return {
        status: 'not_found',
        message: `Webhook con ID "${id}" no fue encontrado en el sistema.`,
      };
    }

    if (wh.paused === 1) {
      sqliteReminderService.saveCustomWebhookLog(id, JSON.stringify(payload).substring(0, 3000), 'Webhook pausado', 'skipped');
      return {
        status: 'paused',
        webhookId: id,
        message: `El webhook "${wh.titulo}" se encuentra pausado actualmente.`,
      };
    }

    const payloadStr = typeof payload === 'object' ? JSON.stringify(payload, null, 2) : String(payload);

    try {
      // 1. Sintetizar con la IA según el modelo seleccionado
      const aiResponse = await this.generateAiResponse(wh.modelo, wh.titulo, wh.instrucciones, payloadStr, headers);

      // 2. Guardar log exitoso en SQLite
      sqliteReminderService.saveCustomWebhookLog(
        id,
        payloadStr.substring(0, 5000),
        aiResponse,
        'success'
      );

      // 3. Detectar canal objetivo (Telegram, Google Chat, Email) según las instrucciones
      const targetChannel: ChannelType = messageFormatter.detectChannel(wh.instrucciones);

      // 4. Formatear y notificar según el canal
      if (targetChannel === 'telegram') {
        const formattedBody = messageFormatter.formatForTelegram(aiResponse);
        const telegramMessage = `🔗 <b>Webhook: ${messageFormatter.escapeHtml(wh.titulo)}</b>\n\n${formattedBody}`;
        await telegramBotService.sendDirectMessage(telegramMessage, { parseMode: 'HTML' });
      } else if (targetChannel === 'google_chat') {
        // Formato para Google Chat y notificación
        const gchatBody = messageFormatter.formatForGoogleChat(aiResponse);
        // También enviamos aviso a Telegram con formato adecuado
        const telegramMessage = `🔗 <b>Webhook: ${messageFormatter.escapeHtml(wh.titulo)}</b> <i>[Google Chat]</i>\n\n${messageFormatter.formatForTelegram(aiResponse)}`;
        await telegramBotService.sendDirectMessage(telegramMessage, { parseMode: 'HTML' });
      } else if (targetChannel === 'email') {
        // Formato Email HTML
        const emailHtml = messageFormatter.formatForEmail(aiResponse, wh.titulo);
        const telegramMessage = `🔗 <b>Webhook: ${messageFormatter.escapeHtml(wh.titulo)}</b> <i>[Email]</i>\n\n${messageFormatter.formatForTelegram(aiResponse)}`;
        await telegramBotService.sendDirectMessage(telegramMessage, { parseMode: 'HTML' });
      } else {
        const formattedBody = messageFormatter.formatForTelegram(aiResponse);
        const telegramMessage = `🔗 <b>Webhook: ${messageFormatter.escapeHtml(wh.titulo)}</b>\n\n${formattedBody}`;
        await telegramBotService.sendDirectMessage(telegramMessage, { parseMode: 'HTML' });
      }

      return {
        status: 'success',
        webhookId: id,
        message: 'Webhook ejecutado y notificado con éxito.',
        response: aiResponse,
      };
    } catch (err: any) {
      console.error(`❌ [CustomWebhookService] Error ejecutando webhook ${id}:`, err.message);
      sqliteReminderService.saveCustomWebhookLog(
        id,
        payloadStr.substring(0, 5000),
        `Error: ${err.message}`,
        'error'
      );

      return {
        status: 'error',
        webhookId: id,
        message: `Error al procesar el webhook con IA: ${err.message}`,
      };
    }
  }

  /**
   * Despacha la ejecución al modelo correcto (Gemini u Ollama)
   */
  private async generateAiResponse(
    modelo: string,
    titulo: string,
    instrucciones: string,
    payloadStr: string,
    headers: Record<string, any>
  ): Promise<string> {
    const prompt = `
Has recibido una carga de datos (payload) en el webhook titulado: "${titulo}".

TUS INSTRUCCIONES:
${instrucciones}

PAYLOAD RECIBIDO:
\`\`\`json
${payloadStr.length > 20000 ? payloadStr.substring(0, 20000) + '\n... (payload recortado)' : payloadStr}
\`\`\`

REGLAS DE RESPUESTA:
- Genera una respuesta ejecutiva, directa y concisa cumpliendo estrictamente tus instrucciones.
- La respuesta será enviada automáticamente al Telegram del usuario, así que no inventes despedidas ni digas "te notifico por Telegram".
- Si las instrucciones piden un resumen o alertar problemas, sé específico con las causas y variables clave.
`;

    const modelNormalized = (modelo || 'gemini-2.5-flash').trim();

    // Caso A: Modelo de Ollama
    if (modelNormalized.toLowerCase().includes('ollama') || modelNormalized.startsWith('gemma') || modelNormalized.startsWith('llama')) {
      const cleanOllamaModel = modelNormalized.replace(/\s*\(ollama\)\s*/i, '').trim();
      try {
        const ollamaRes = await axios.post(
          `${this.ollamaUrl.replace(/\/$/, '')}/api/generate`,
          {
            model: cleanOllamaModel,
            prompt,
            stream: false,
          },
          { timeout: 45000 }
        );

        if (ollamaRes.data && ollamaRes.data.response) {
          tokenTrackerService.logUsage(
            `Webhook: ${titulo}`,
            cleanOllamaModel,
            ollamaRes.data.prompt_eval_count || 0,
            ollamaRes.data.eval_count || 0,
            'webhook',
          'system',
          'custom_webhook'
        ).catch(() => {});
          return ollamaRes.data.response.trim();
        }
      } catch (ollamaErr: any) {
        console.warn(`⚠️ [CustomWebhookService] Falló Ollama (${cleanOllamaModel}), usando fallback a Gemini:`, ollamaErr.message);
      }
    }

    // Caso B: Modelo de Gemini (o fallback)
    let geminiModel = modelNormalized.replace(/\s*\(ollama\)\s*/i, '').trim();
    if (!geminiModel.startsWith('gemini')) {
      geminiModel = 'gemini-2.5-flash';
    }

    try {
      const aiRes = await this.ai.models.generateContent({
        model: geminiModel,
        contents: prompt,
      });

      if (aiRes.usageMetadata) {
        tokenTrackerService.logUsage(
          `Webhook: ${titulo}`,
          geminiModel,
          tokenTrackerService.extractUsage(aiRes.usageMetadata).inputTokens,
          tokenTrackerService.extractUsage(aiRes.usageMetadata).outputTokens,
          'webhook',
          'system',
          'custom_webhook'
        ).catch(() => {});
      }

      return aiRes.text?.trim() || '(Sin respuesta generada por la IA)';
    } catch (geminiErr: any) {
      if (geminiModel !== 'gemini-2.5-flash') {
        console.warn(`⚠️ [CustomWebhookService] Modelo ${geminiModel} falló, usando fallback a gemini-2.5-flash:`, geminiErr.message);
        const fallbackRes = await this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        });

        if (fallbackRes.usageMetadata) {
          tokenTrackerService.logUsage(
            `Webhook: ${titulo}`,
            'gemini-2.5-flash',
            tokenTrackerService.extractUsage(fallbackRes.usageMetadata).inputTokens,
            tokenTrackerService.extractUsage(fallbackRes.usageMetadata).outputTokens,
            'webhook',
          'system',
          'custom_webhook'
        ).catch(() => {});
        }

        return fallbackRes.text?.trim() || '(Sin respuesta generada por la IA)';
      }
      throw geminiErr;
    }
  }
}

export const customWebhookService = new CustomWebhookService();
