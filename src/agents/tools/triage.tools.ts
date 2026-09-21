import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { sqliteReminderService } from '../../database/sqlite.service.js';
import { currentUsageScope } from '../../utils/usage_collector.js';

const URGENCIA_ICONO: Record<string, string> = { alta: '🔴', media: '🟠', baja: '🟢' };

/**
 * Registra un tema sensible para que lo resuelva el Jesús real y avisa por Telegram.
 */
export const escalateToJesus = new FunctionTool({
  name: 'escalate_to_jesus',
  description: 'Registra un tema que debe resolver Jesús en persona (sueldos, contrataciones, evaluaciones de personas, compromisos legales o comerciales, credenciales, o cualquier cosa sensible o ambigua) y le avisa por Telegram. Devuelve el ID del escalamiento.',
  parameters: z.object({
    topic: z.string().describe('Categoría corta del tema: sueldos, contratación, evaluación, legal, comercial, credenciales, opinión sobre persona, otro.'),
    summary: z.string().describe('Contexto COMPLETO: qué se preguntó o pidió, por quién, y cualquier dato necesario para que Jesús decida sin tener que reconstruirlo.'),
    requester: z.string().optional().describe('Quién lo pidió (nombre, pubkey, correo o identificador del canal).'),
    urgency: z.enum(['baja', 'media', 'alta']).optional().describe('Urgencia percibida. Por defecto media.'),
  }) as any,
  execute: async (args: any) => {
    const { topic, summary, requester, urgency = 'media' } = args;
    try {
      const id = randomUUID().slice(0, 8);
      const channel = currentUsageScope()?.channel || 'system';

      sqliteReminderService.createEscalation({
        id,
        channel,
        requester: requester || 'desconocido',
        topic,
        summary,
        urgency,
      });

      const { telegramBotService } = await import('../../services/telegram_bot.service.js');
      const icono = URGENCIA_ICONO[urgency] || '🟠';
      await telegramBotService.sendDirectMessage(
        `${icono} <b>ESCALAMIENTO PARA TI</b> <code>${id}</code>\n\n` +
        `• <b>Tema:</b> ${topic}\n` +
        `• <b>Pidió:</b> ${requester || 'desconocido'}\n` +
        `• <b>Canal:</b> ${channel}\n\n` +
        `${summary}\n\n` +
        `<i>Cuando lo resuelvas, dime "resuelve el escalamiento ${id}" con lo que decidiste.</i>`,
        { parseMode: 'HTML' }
      ).catch(() => {});

      return {
        status: 'success',
        result: `Escalamiento ${id} registrado y notificado a Jesús por Telegram.`,
        data: { id, topic, urgency, channel },
      };
    } catch (error: any) {
      return { status: 'error', message: `No se pudo registrar el escalamiento: ${error.message}` };
    }
  },
});

export const listEscalations = new FunctionTool({
  name: 'list_escalations',
  description: 'Lista los escalamientos registrados para Jesús. Por defecto muestra los pendientes.',
  parameters: z.object({
    status: z.enum(['pendiente', 'resuelto', 'descartado']).optional().describe('Filtro por estado. Por defecto: pendiente.'),
    limit: z.number().optional().describe('Máximo de resultados (por defecto 20).'),
  }) as any,
  execute: async (args: any) => {
    const { status = 'pendiente', limit = 20 } = args;
    try {
      const rows = sqliteReminderService.listEscalations(status, limit);
      if (rows.length === 0) {
        return { status: 'success', result: `No hay escalamientos en estado "${status}".` };
      }

      const formatted = rows.map((r: any) => {
        const fecha = new Date(r.created_at).toLocaleString('es-CL');
        const icono = URGENCIA_ICONO[r.urgency] || '🟠';
        return `${icono} **${r.id}** · ${r.topic} · ${fecha}\n   Pidió: ${r.requester} (${r.channel})\n   ${String(r.summary).slice(0, 200)}`;
      }).join('\n\n');

      return { status: 'success', result: `Escalamientos (${status}):\n\n${formatted}`, data: rows };
    } catch (error: any) {
      return { status: 'error', message: `Error listando escalamientos: ${error.message}` };
    }
  },
});

export const resolveEscalation = new FunctionTool({
  name: 'resolve_escalation',
  description: 'Marca un escalamiento como resuelto o descartado, dejando registrada la decisión de Jesús. Solo debe usarse cuando el propio Jesús indica la resolución.',
  parameters: z.object({
    id: z.string().describe('ID del escalamiento (8 caracteres).'),
    resolution: z.string().describe('Qué decidió Jesús. Queda registrado como antecedente.'),
    status: z.enum(['resuelto', 'descartado']).optional().describe('Estado final. Por defecto: resuelto.'),
  }) as any,
  execute: async (args: any) => {
    const { id, resolution, status = 'resuelto' } = args;
    try {
      const ok = sqliteReminderService.resolveEscalation(id, resolution, status);
      return ok
        ? { status: 'success', result: `Escalamiento ${id} marcado como ${status}.` }
        : { status: 'error', message: `No existe un escalamiento con ID ${id}.` };
    } catch (error: any) {
      return { status: 'error', message: `Error resolviendo el escalamiento: ${error.message}` };
    }
  },
});
