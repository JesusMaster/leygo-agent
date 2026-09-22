import dotenv from 'dotenv';
import { sqliteReminderService, CustomWebhook, CustomWebhookLog } from '../database/sqlite.service.js';
import { telegramBotService } from './telegram_bot.service.js';
import { messageFormatter, ChannelType } from '../utils/message_formatter.js';
import { llmSettingsService, type LlmProvider } from './llm_settings.service.js';
import { construirLlm } from '../agents/llm/model_factory.js';
import { beginUsageScope, flushUsageScope } from '../utils/usage_collector.js';

dotenv.config();

export interface ExecuteCustomWebhookResult {
  status: 'success' | 'paused' | 'not_found' | 'error';
  message: string;
  webhookId?: string;
  response?: string;
}

export class CustomWebhookService {

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
    modelo: string = 'gemini/gemini-3.5-flash-lite',
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
   * Proveedores configurados en Ajustes (solo los activos) con sus modelos.
   * El campo `modelo` del webhook se guarda como "<proveedor>/<modelo>".
   */
  public async listModels(): Promise<{ providers: Array<{ id: string; name: string; kind: string; models: string[]; error?: string }> }> {
    const providers = llmSettingsService.listProviders().filter((p) => p.enabled);
    const out = await Promise.all(providers.map(async (p) => {
      try {
        return { id: p.id, name: p.name, kind: p.kind, models: await llmSettingsService.listModels(p.id) };
      } catch (err: any) {
        return { id: p.id, name: p.name, kind: p.kind, models: [], error: err?.message };
      }
    }));
    return { providers: out };
  }

  /** "<proveedor>/<modelo>" → proveedor + modelo. Entiende los valores antiguos. */
  public resolverModelo(modelo: string): { provider: LlmProvider; model: string } | null {
    const v = (modelo || '').trim();
    const barra = v.indexOf('/');
    if (barra > 0) {
      const prov = llmSettingsService.getProvider(v.slice(0, barra));
      if (prov) return { provider: prov, model: v.slice(barra + 1) };
    }
    // Formato antiguo: "gemma3:12b (ollama)" o "gemini-2.5-flash"
    if (/\(ollama\)/i.test(v) || /^(gemma|llama|qwen|mistral|phi|deepseek|gpt-oss)/i.test(v)) {
      const prov = llmSettingsService.listProviders().find((p) => p.kind === 'ollama' && p.enabled);
      const provFull = prov && llmSettingsService.getProvider(prov.id);
      if (provFull) return { provider: provFull, model: v.replace(/\s*\(ollama\)\s*/i, '').trim() };
    }
    const gem = llmSettingsService.getProvider('gemini') || llmSettingsService.listProviders().filter((p) => p.kind === 'gemini' && p.enabled).map((p) => llmSettingsService.getProvider(p.id)!)[0];
    if (gem) return { provider: gem, model: v.startsWith('gemini') ? v : 'gemini-3.5-flash-lite' };
    return null;
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

    const r = this.resolverModelo(modelo);
    if (!r) throw new Error(`No hay proveedor para el modelo "${modelo}". Configúralo en Ajustes → Proveedores LLM.`);

    beginUsageScope('webhook' as any, `webhook-${titulo}`, `Webhook: ${titulo}`);
    try {
      const llm = construirLlm(r.provider, r.model, 'custom_webhook');
      let texto = '';
      let error: string | undefined;
      for await (const resp of llm.generateContentAsync({ model: r.model, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: {} } as any, false)) {
        if (resp?.errorMessage) error = resp.errorMessage;
        for (const p of resp?.content?.parts || []) if (p.text) texto += p.text;
      }
      if (error) throw new Error(error);
      return texto.trim() || '(Sin respuesta generada por la IA)';
    } finally {
      flushUsageScope().catch(() => {});
    }
  }
}

export const customWebhookService = new CustomWebhookService();
