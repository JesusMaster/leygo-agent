import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { sqliteReminderService, CustomWebhook, CustomWebhookLog, TaskDelivery } from '../database/sqlite.service.js';
import { telegramBotService } from './telegram_bot.service.js';
import { messageFormatter } from '../utils/message_formatter.js';
import { llmSettingsService, type LlmProvider } from './llm_settings.service.js';
import { construirLlm } from '../agents/llm/model_factory.js';
import { beginUsageScope, flushUsageScope } from '../utils/usage_collector.js';

dotenv.config();

export type ModoWebhook = 'siempre' | 'importante';

export interface ExecuteCustomWebhookResult {
  status: 'success' | 'silenced' | 'paused' | 'not_found' | 'unauthorized' | 'error';
  message: string;
  webhookId?: string;
  response?: string;
  entrega?: string;
  ms?: number;
}

/** Lo que la GUI y las herramientas ven de un webhook: sin el hash del secreto. */
export type WebhookPublico = Omit<CustomWebhook, 'secret_hash' | 'delivery'> & {
  url: string;
  delivery: TaskDelivery[];
  modo: ModoWebhook;
  tieneSecreto: boolean;
  stats?: { total: number; semana: number; errores: number; silenciados: number; ultimo: number | null; ultimoEstado: string | null };
};

/** Marca con la que la IA indica que el payload no amerita aviso (modo 'importante'). */
const SIN_AVISO = 'SIN_AVISO';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export class CustomWebhookService {

  /**
   * URL pública para invocar el webhook. Prioridad: WEBHOOK_BASE_URL, A2A_BASE_URL (la
   * URL pública del despliegue) y, si no, el origen de la petición (esquema incluido).
   */
  public getWebhookUrl(id: string, origen?: string): string {
    const base = process.env.WEBHOOK_BASE_URL || process.env.A2A_BASE_URL
      || (origen ? (origen.includes('://') ? origen : `http://${origen}`) : 'http://localhost:4000');
    return `${base.replace(/\/$/, '')}/api/webhook/${id}`;
  }

  private publico(wh: CustomWebhook, origen?: string, stats?: WebhookPublico['stats']): WebhookPublico {
    const { secret_hash, delivery, ...resto } = wh;
    return {
      ...resto,
      url: this.getWebhookUrl(wh.id, origen),
      delivery: this.parsearEntrega(delivery),
      modo: wh.modo === 'importante' ? 'importante' : 'siempre',
      tieneSecreto: !!secret_hash,
      ...(stats ? { stats } : {}),
    };
  }

  private parsearEntrega(raw?: string | null): TaskDelivery[] {
    if (!raw) return [];
    try {
      const l = JSON.parse(raw);
      return Array.isArray(l) ? l.filter((d) => d && typeof d.channel === 'string').map((d) => ({ channel: d.channel, target: d.target ?? null })) : [];
    } catch { return []; }
  }

  private normalizarEntrega(v: any): string | null {
    if (!Array.isArray(v)) return null;
    const validos = ['telegram', 'chat', 'buzz', 'email', 'a2a'];
    const l = v.filter((d) => d && validos.includes(d.channel)).map((d) => ({ channel: d.channel, target: d.target ? String(d.target).trim() : null }));
    return l.length ? JSON.stringify(l) : null;
  }

  public createWebhook(
    titulo: string,
    instrucciones: string,
    modelo: string = 'gemini/gemini-3.5-flash-lite',
    origen?: string,
    extra: { delivery?: TaskDelivery[]; modo?: ModoWebhook } = {},
  ): WebhookPublico {
    const wh = sqliteReminderService.createCustomWebhook(titulo, instrucciones, modelo);
    const conExtra = (extra.delivery || extra.modo)
      ? sqliteReminderService.updateCustomWebhook(wh.id, { delivery: this.normalizarEntrega(extra.delivery), modo: extra.modo === 'importante' ? 'importante' : 'siempre' }) || wh
      : wh;
    return this.publico(conExtra, origen);
  }

  public listWebhooks(origen?: string): WebhookPublico[] {
    const stats = sqliteReminderService.getCustomWebhookStats();
    return sqliteReminderService.getCustomWebhooks().map((wh) => this.publico(wh, origen, stats[wh.id] || { total: 0, semana: 0, errores: 0, silenciados: 0, ultimo: null, ultimoEstado: null }));
  }

  public getWebhook(id: string, origen?: string): WebhookPublico | null {
    const wh = sqliteReminderService.getCustomWebhook(id);
    return wh ? this.publico(wh, origen) : null;
  }

  /**
   * Actualiza solo campos permitidos. El secreto NO se cambia por aquí (ver rotarSecreto):
   * así un PUT con el body crudo no puede fijar ni borrar la autenticación.
   */
  public updateWebhook(
    id: string,
    fields: { titulo?: string; instrucciones?: string; modelo?: string; paused?: number; delivery?: TaskDelivery[] | null; modo?: string },
    origen?: string,
  ): WebhookPublico | null {
    const limpio: Parameters<typeof sqliteReminderService.updateCustomWebhook>[1] = {};
    if (typeof fields.titulo === 'string' && fields.titulo.trim()) limpio.titulo = fields.titulo.trim();
    if (typeof fields.instrucciones === 'string' && fields.instrucciones.trim()) limpio.instrucciones = fields.instrucciones.trim();
    if (typeof fields.modelo === 'string' && fields.modelo.trim()) limpio.modelo = fields.modelo.trim();
    if (fields.paused === 0 || fields.paused === 1) limpio.paused = fields.paused;
    if (fields.delivery !== undefined) limpio.delivery = this.normalizarEntrega(fields.delivery);
    if (fields.modo !== undefined) limpio.modo = fields.modo === 'importante' ? 'importante' : 'siempre';
    const updated = sqliteReminderService.updateCustomWebhook(id, limpio);
    return updated ? this.publico(updated, origen) : null;
  }

  /** Genera (y devuelve UNA vez) un secreto nuevo, o lo quita. Solo se guarda su hash. */
  public rotarSecreto(id: string, quitar = false): { secreto: string | null } | null {
    if (!sqliteReminderService.getCustomWebhook(id)) return null;
    if (quitar) { sqliteReminderService.updateCustomWebhook(id, { secret_hash: null }); return { secreto: null }; }
    const secreto = `whs_${crypto.randomBytes(24).toString('base64url')}`;
    sqliteReminderService.updateCustomWebhook(id, { secret_hash: sha256(secreto) });
    return { secreto };
  }

  public deleteWebhook(id: string): boolean {
    return sqliteReminderService.deleteCustomWebhook(id);
  }

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
    return { providers: await llmSettingsService.catalogo() };
  }

  /** "<proveedor>/<modelo>" → proveedor + modelo (entiende los valores antiguos). */
  public resolverModelo(modelo: string): { provider: LlmProvider; model: string } | null {
    return llmSettingsService.resolverRef(modelo);
  }

  public getLogs(webhookId?: string, limit: number = 20): CustomWebhookLog[] {
    return sqliteReminderService.getCustomWebhookLogs(webhookId, limit);
  }

  /** Compara el secreto recibido con el hash guardado sin filtrar tiempos. */
  private secretoValido(wh: CustomWebhook, recibido?: string | null): boolean {
    if (!wh.secret_hash) return true;
    if (!recibido) return false;
    const a = Buffer.from(sha256(String(recibido)), 'hex');
    const b = Buffer.from(wh.secret_hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Procesa un payload. Lo llama el POST público (origen 'externo') o la GUI para
   * probar (origen 'prueba': no exige secreto, corre aunque esté pausado y solo
   * entrega si se pide explícitamente).
   */
  public async executeWebhook(
    id: string,
    payload: any,
    headers: Record<string, any> = {},
    opts: { prueba?: boolean; entregar?: boolean; token?: string | null } = {},
  ): Promise<ExecuteCustomWebhookResult> {
    const wh = sqliteReminderService.getCustomWebhook(id);
    if (!wh) return { status: 'not_found', message: `Webhook con ID "${id}" no fue encontrado en el sistema.` };

    if (!opts.prueba) {
      const recibido = headers['x-webhook-secret'] || headers['x-yisus-secret'] || opts.token;
      // Sin log a propósito: un tercero con la URL no debe poder llenar la tabla.
      if (!this.secretoValido(wh, recibido)) return { status: 'unauthorized', webhookId: id, message: 'Falta o no coincide el secreto (cabecera X-Webhook-Secret).' };
    }

    const payloadStr = typeof payload === 'object' ? JSON.stringify(payload, null, 2) : String(payload ?? '');
    const origen = opts.prueba ? 'prueba' : 'externo';

    if (wh.paused === 1 && !opts.prueba) {
      sqliteReminderService.saveCustomWebhookLog(id, payloadStr.substring(0, 3000), 'Webhook pausado', 'skipped', { origen });
      return { status: 'paused', webhookId: id, message: `El webhook "${wh.titulo}" se encuentra pausado actualmente.` };
    }

    const t0 = Date.now();
    const modo: ModoWebhook = wh.modo === 'importante' ? 'importante' : 'siempre';
    try {
      const aiResponse = await this.generateAiResponse(wh.modelo, wh.titulo, wh.instrucciones, payloadStr, modo);
      // Tolera formato del modelo alrededor de la marca (**SIN_AVISO**, `SIN_AVISO`, espacios).
      const silenciado = modo === 'importante' && aiResponse.replace(/^[\s*`>"']+/, '').toUpperCase().startsWith(SIN_AVISO);
      const destinos = this.parsearEntrega(wh.delivery);
      let entrega = '';

      if (silenciado) {
        entrega = 'sin aviso: la IA lo consideró no importante';
      } else if (!opts.prueba || opts.entregar) {
        entrega = await this.entregar(wh, aiResponse, destinos);
      } else {
        entrega = 'prueba: no se entregó';
      }

      const ms = Date.now() - t0;
      sqliteReminderService.saveCustomWebhookLog(id, payloadStr.substring(0, 5000), aiResponse, silenciado ? 'silenced' : 'success', { entrega, ms, origen });
      return {
        status: silenciado ? 'silenced' : 'success',
        webhookId: id,
        message: silenciado ? 'Procesado: no amerita aviso.' : 'Webhook ejecutado y notificado con éxito.',
        response: aiResponse,
        entrega,
        ms,
      };
    } catch (err: any) {
      const ms = Date.now() - t0;
      console.error(`❌ [CustomWebhookService] Error ejecutando webhook ${id}:`, err.message);
      sqliteReminderService.saveCustomWebhookLog(id, payloadStr.substring(0, 5000), `Error: ${err.message}`, 'error', { ms, origen });
      return { status: 'error', webhookId: id, message: `Error al procesar el webhook con IA: ${err.message}`, ms };
    }
  }

  /** Entrega por los destinos configurados (o Telegram si no hay ninguno). Devuelve el resumen. */
  private async entregar(wh: CustomWebhook, respuesta: string, destinos: TaskDelivery[]): Promise<string> {
    if (!destinos.length) {
      const cuerpo = messageFormatter.formatForTelegram(respuesta);
      await telegramBotService.sendDirectMessage(`🔗 <b>Webhook: ${messageFormatter.escapeHtml(wh.titulo)}</b>\n\n${cuerpo}`, { parseMode: 'HTML' });
      return 'Telegram ✓';
    }
    const { scheduledTasksService } = await import('./scheduled_tasks.service.js');
    const texto = `🔗 **Webhook: ${wh.titulo}**\n\n${respuesta}`;
    const fallos = await scheduledTasksService.entregarPor(destinos, texto);
    const partes = destinos.map((d) => {
      const nombre = scheduledTasksService.etiquetaDestino(d);
      const fallo = fallos.find((f) => f.startsWith(nombre.split(' (')[0]));
      return fallo ? `${nombre} ✗ (${fallo.split(': ').slice(1).join(': ')})` : `${nombre} ✓`;
    });
    if (fallos.length === destinos.length) throw new Error(`No se pudo entregar: ${fallos.join(' · ')}`);
    return partes.join(' · ');
  }

  private async generateAiResponse(modelo: string, titulo: string, instrucciones: string, payloadStr: string, modo: ModoWebhook): Promise<string> {
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
- La respuesta se envía automáticamente a Jesús por los canales configurados: no inventes despedidas ni digas "te notifico por…".
- Si las instrucciones piden un resumen o alertar problemas, sé específico con las causas y variables clave.
${modo === 'importante' ? `- Si según tus instrucciones este payload NO requiere la atención de Jesús (todo OK, ruido, evento rutinario), responde EXACTAMENTE "${SIN_AVISO}" seguido de una frase corta con el motivo, y nada más.` : ''}
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
        for (const p of resp?.content?.parts || []) if (p.text && !(p as any).thought) texto += p.text;
      }
      if (error) throw new Error(error);
      return texto.trim() || '(Sin respuesta generada por la IA)';
    } finally {
      flushUsageScope().catch(() => {});
    }
  }
}

export const customWebhookService = new CustomWebhookService();
