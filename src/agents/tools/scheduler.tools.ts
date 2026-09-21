import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { schedulerService } from "../../services/scheduler.service.js";

/**
 * Herramienta para programar un recordatorio en Telegram
 */
export const scheduleReminderTool = new FunctionTool({
  name: 'schedule_reminder',
  description: 'Programa un recordatorio que enviará una alerta directa al Telegram de Jesús en una cantidad de minutos determinada o en una fecha/hora específica.',
  parameters: z.object({
    message: z.string().describe('El texto del recordatorio (ej: "Revisar PR de pagos", "Llamar a Pablo").'),
    minutesFromNow: z.number().optional().describe('Minutos a partir de este momento para enviar el recordatorio (ej: 15, 60, 120).'),
    targetIsoDate: z.string().optional().describe('Fecha y hora exacta en formato ISO (ej: "2026-09-21T15:30:00Z"). Si se pasa, tiene prioridad sobre minutesFromNow.')
  }) as any,
  execute: async (args: any) => {
    const { message, minutesFromNow, targetIsoDate } = args;

    try {
      let targetTime: Date;

      if (targetIsoDate) {
        targetTime = new Date(targetIsoDate);
        if (isNaN(targetTime.getTime())) {
          return { status: 'error', message: `Fecha ISO inválida: "${targetIsoDate}".` };
        }
      } else if (typeof minutesFromNow === 'number' && minutesFromNow > 0) {
        targetTime = new Date(Date.now() + minutesFromNow * 60 * 1000);
      } else {
        return {
          status: 'error',
          message: 'Debes especificar minutesFromNow (mayor a 0) o targetIsoDate con fecha futura.'
        };
      }

      const result = schedulerService.scheduleReminder(targetTime, message);

      return {
        status: 'success',
        result: `Recordatorio agendado exitosamente. Se enviará a Telegram el ${result.scheduledFor} (en aprox. ${result.remainingMinutes} minutos).`,
        data: result,
      };
    } catch (err: any) {
      return { status: 'error', message: `Error al agendar recordatorio: ${err.message}` };
    }
  },
});

/**
 * Herramienta para consultar los recordatorios activos programados
 */
export const listRemindersTool = new FunctionTool({
  name: 'list_scheduled_reminders',
  description: 'Lista todos los recordatorios activos actualmente programados en el sistema que aún no se han disparado.',
  parameters: z.object({}) as any,
  execute: async () => {
    try {
      const reminders = schedulerService.listReminders();
      if (reminders.length === 0) {
        return { status: 'success', result: 'No hay recordatorios pendientes programados.' };
      }
      const formatted = reminders
        .map(r => `• [${r.id}] Para: ${r.targetTime} — "${r.message}"`)
        .join('\n');
      return { status: 'success', result: formatted, data: reminders };
    } catch (err: any) {
      return { status: 'error', message: `Error listando recordatorios: ${err.message}` };
    }
  },
});

/**
 * Herramienta para forzar la ejecución del Morning Digest bajo demanda
 */
export const triggerMorningDigestTool = new FunctionTool({
  name: 'trigger_morning_digest',
  description: 'Genera y envía de inmediato el Morning Digest (resumen ejecutivo de reuniones del día y correos pendientes) al Telegram de Jesús.',
  parameters: z.object({}) as any,
  execute: async () => {
    try {
      const digest = await schedulerService.runMorningDigest();
      return {
        status: 'success',
        result: 'Morning Digest generado y enviado a Telegram exitosamente.',
        preview: digest,
      };
    } catch (err: any) {
      return { status: 'error', message: `Error ejecutando Morning Digest: ${err.message}` };
    }
  },
});
