import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { schedulerService } from "../../services/scheduler.service.js";
import { scheduledTasksService } from "../../services/scheduled_tasks.service.js";

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
  description: 'Lista los recordatorios y tareas programadas activas (una vez, cada N minutos, diarias o cron), con su próxima ejecución.',
  parameters: z.object({}) as any,
  execute: async () => {
    try {
      const reminders = schedulerService.listReminders();
      if (reminders.length === 0) {
        return { status: 'success', result: 'No hay recordatorios pendientes programados.' };
      }
      const formatted = reminders
        .map(r => `• [${r.id}] ${r.tipo} · próxima: ${r.targetTime} — "${r.message}"`)
        .join('\n');
      return { status: 'success', result: formatted, data: reminders };
    } catch (err: any) {
      return { status: 'error', message: `Error listando recordatorios: ${err.message}` };
    }
  },
});

/**
 * Tareas recurrentes o autónomas (lo que la GUI llama "Tareas programadas").
 */
export const scheduleTaskTool = new FunctionTool({
  name: 'schedule_task',
  description: 'Programa una tarea recurrente o una acción autónoma del agente: diaria a una hora, cada N minutos, con expresión cron, o una vez en una fecha. Si autonomous=true, en cada ejecución el agente recibe la instrucción y la trabaja con sus herramientas (ej: "revisa mi agenda y mándame un resumen"); si es false, solo se envía el texto como recordatorio a Telegram. Para un recordatorio simple de una vez usa schedule_reminder.',
  parameters: z.object({
    message: z.string().describe('Instrucción o texto del recordatorio.'),
    autonomous: z.boolean().optional().describe('true = el agente ejecuta la instrucción; false (por defecto) = solo se envía el texto.'),
    kind: z.enum(['once', 'interval', 'daily', 'cron']).describe('Tipo: once (fecha), interval (cada N minutos), daily (hora HH:MM), cron (expresión).'),
    targetIsoDate: z.string().optional().describe('Para once: fecha y hora ISO.'),
    intervalMinutes: z.number().optional().describe('Para interval: minutos entre ejecuciones.'),
    timeOfDay: z.string().optional().describe('Para daily: hora "HH:MM" en la zona de Jesús (America/Santiago).'),
    cronExpr: z.string().optional().describe('Para cron: expresión de 5 campos, ej "0 9 * * 1-5".'),
    delivery: z.array(z.object({
      channel: z.enum(['telegram', 'chat', 'buzz', 'email']),
      target: z.string().optional().describe('Espacio de Google Chat (spaces/…, búscalo con chat_find_dm o chat_list_spaces), correo para email, o canal de Buzz (opcional). Telegram no lleva.'),
    })).optional().describe('Uno o más destinos de entrega. Por defecto solo Telegram. Ej: [{channel:"telegram"},{channel:"buzz"}].'),
  }) as any,
  execute: async (args: any) => {
    try {
      const t = scheduledTasksService.create({
        message: args.message,
        autonomous: !!args.autonomous,
        kind: args.kind,
        run_at: args.targetIsoDate,
        interval_minutes: args.intervalMinutes,
        time_of_day: args.timeOfDay,
        cron_expr: args.cronExpr,
        delivery: args.delivery,
      });
      const proxima = t.next_run_at ? new Date(t.next_run_at).toLocaleString('es-CL', { timeZone: 'America/Santiago' }) : 'sin calcular';
      return { status: 'success', result: `Tarea [${t.id}] programada (${t.autonomous ? 'acción del agente' : 'recordatorio'}). Próxima ejecución: ${proxima}.`, data: t };
    } catch (err: any) {
      return { status: 'error', message: `No se pudo programar la tarea: ${err.message}` };
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
