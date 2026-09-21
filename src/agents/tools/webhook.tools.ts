import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { webhookService } from "../../services/webhook.service.js";
import { customWebhookService } from "../../services/custom_webhook.service.js";

/**
 * Herramienta para consultar los últimos webhooks y alertas recibidos
 */
export const getRecentWebhooksTool = new FunctionTool({
  name: 'get_recent_webhooks',
  description: 'Consulta las últimas alertas, eventos o webhooks recibidos (GitHub, GitLab, Sentry, despliegues o alertas genéricas).',
  parameters: z.object({
    limit: z.number().optional().describe('Cantidad máxima de eventos recientes a retornar (por defecto 5).')
  }) as any,
  execute: async (args: any) => {
    const { limit = 5 } = args;
    try {
      const events = webhookService.getRecentEvents(limit);
      if (!events || events.length === 0) {
        return {
          status: 'success',
          result: 'No se han recibido eventos o alertas por webhook recientemente.',
        };
      }

      const formatted = events.map((e) => {
        const dateStr = new Date(e.created_at).toLocaleString('es-CL');
        return `• [${dateStr}] [${e.provider.toUpperCase()} / ${e.event_type}] ${e.title}\n  Detalle: ${e.summary}`;
      }).join('\n\n');

      return {
        status: 'success',
        result: formatted,
        data: events,
      };
    } catch (err: any) {
      return {
        status: 'error',
        message: `Error al consultar webhooks recientes: ${err.message}`,
      };
    }
  },
});

/**
 * Herramienta para crear un Webhook personalizado con IA (estilo Leygo)
 */
export const createCustomWebhookTool = new FunctionTool({
  name: 'create_custom_webhook',
  description: 'Crea un nuevo endpoint webhook HTTP POST personalizado. Permite recibir datos de sistemas externos (n8n, grafana, alertas, etc.), procesarlos con un modelo de IA (Gemini u Ollama) según instrucciones dadas, y notificar a Telegram.',
  parameters: z.object({
    titulo: z.string().describe('Título descriptivo del webhook (ej: "Problemas de n8n", "Alertas de Servidor")'),
    instrucciones: z.string().describe('Instrucciones para la IA sobre cómo interpretar el payload recibido (ej: "debes darme un resumen del problema presentado en n8n, notificame via telegram")'),
    modelo: z.string().optional().describe('Modelo a utilizar, por defecto "gemini-2.5-flash". Puede ser "gemma4:latest (ollama)", "llama3:latest (ollama)", o cualquier modelo disponible.'),
  }) as any,
  execute: async (args: any) => {
    try {
      const { titulo, instrucciones, modelo = 'gemini-2.5-flash' } = args;
      const created = customWebhookService.createWebhook(titulo, instrucciones, modelo);

      return {
        status: 'success',
        result: `✅ Webhook creado con éxito!\n\n📌 **Título:** ${created.titulo}\n🤖 **Modelo:** ${created.modelo}\n📋 **Instrucciones:** ${created.instrucciones}\n\n🔗 **URL del Webhook (HTTP POST):**\n${created.url}\n\nPuedes usar esta URL en n8n o cualquier servicio externo. Cuando reciba una petición POST, la IA procesará los datos y te enviará un resumen a Telegram.`,
        webhook: created,
        url: created.url,
      };
    } catch (err: any) {
      return {
        status: 'error',
        message: `Error al crear el webhook: ${err.message}`,
      };
    }
  },
});

/**
 * Herramienta para listar los webhooks creados
 */
export const listCustomWebhooksTool = new FunctionTool({
  name: 'list_custom_webhooks',
  description: 'Lista todos los webhooks personalizados configurados en el sistema con su estado (activo/pausado), modelo asignado y URL.',
  parameters: z.object({}) as any,
  execute: async () => {
    try {
      const webhooks = customWebhookService.listWebhooks();
      if (!webhooks || webhooks.length === 0) {
        return {
          status: 'success',
          result: 'No hay webhooks personalizados creados todavía.',
          webhooks: [],
        };
      }

      const formatted = webhooks.map((wh) => {
        const estado = wh.paused === 1 ? '⏸️ [PAUSADO]' : '▶️ [ACTIVO]';
        return `• ${estado} **${wh.titulo}** (ID: \`${wh.id}\`)\n  🤖 Modelo: \`${wh.modelo}\`\n  📝 Instrucciones: ${wh.instrucciones}\n  🔗 URL: ${wh.url}`;
      }).join('\n\n');

      return {
        status: 'success',
        result: `📋 Webhooks configurados:\n\n${formatted}`,
        webhooks,
      };
    } catch (err: any) {
      return {
        status: 'error',
        message: `Error al listar webhooks: ${err.message}`,
      };
    }
  },
});

/**
 * Herramienta para pausar o reanudar un webhook
 */
export const toggleCustomWebhookTool = new FunctionTool({
  name: 'toggle_custom_webhook',
  description: 'Pausa o reanuda un webhook personalizado por su ID o título.',
  parameters: z.object({
    id: z.string().describe('ID o UUID del webhook a pausar o reanudar'),
    paused: z.boolean().describe('true para pausar el webhook, false para reactivarlo/reanudarlo'),
  }) as any,
  execute: async (args: any) => {
    try {
      const { id, paused } = args;
      const updated = customWebhookService.updateWebhook(id, { paused: paused ? 1 : 0 });
      if (!updated) {
        return {
          status: 'error',
          message: `No se encontró ningún webhook con el ID "${id}".`,
        };
      }

      const estadoStr = updated.paused === 1 ? 'Pausado ⏸️' : 'Reanudado ▶️';
      return {
        status: 'success',
        result: `Webhook "${updated.titulo}" ha sido ${estadoStr}.`,
        webhook: updated,
      };
    } catch (err: any) {
      return {
        status: 'error',
        message: `Error al actualizar estado del webhook: ${err.message}`,
      };
    }
  },
});

/**
 * Herramienta para consultar logs de un webhook
 */
export const getCustomWebhookLogsTool = new FunctionTool({
  name: 'get_custom_webhook_logs',
  description: 'Consulta los logs de ejecuciones anteriores de un webhook personalizado.',
  parameters: z.object({
    id: z.string().optional().describe('ID del webhook específico, o déjalo vacío para ver los últimos logs globales'),
    limit: z.number().optional().describe('Cantidad máxima de registros (por defecto 10)'),
  }) as any,
  execute: async (args: any) => {
    try {
      const { id, limit = 10 } = args;
      const logs = customWebhookService.getLogs(id, limit);
      if (!logs || logs.length === 0) {
        return {
          status: 'success',
          result: 'No hay logs registrados para este webhook.',
          logs: [],
        };
      }

      const formatted = logs.map((l) => {
        const fecha = new Date(l.created_at).toLocaleString('es-CL');
        return `• [${fecha}] Estado: ${l.status.toUpperCase()}\n  📥 Payload: ${l.payload.substring(0, 100)}...\n  🤖 Respuesta: ${(l.response || '').substring(0, 150)}...`;
      }).join('\n\n');

      return {
        status: 'success',
        result: `📋 Logs de ejecución:\n\n${formatted}`,
        logs,
      };
    } catch (err: any) {
      return {
        status: 'error',
        message: `Error al obtener logs: ${err.message}`,
      };
    }
  },
});
