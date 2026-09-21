import cron, { ScheduledTask } from 'node-cron';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { googleService } from './google.service.js';
import { telegramBotService } from './telegram_bot.service.js';
import { meetingIngestService } from './meeting_ingest.service.js';
import { sqliteReminderService } from '../database/sqlite.service.js';
import { tokenTrackerService } from './token_tracker.service.js';
import { messageFormatter } from '../utils/message_formatter.js';

dotenv.config();

export interface ActiveReminder {
  id: string;
  targetTime: Date;
  message: string;
  createdAt: Date;
  timerRef?: NodeJS.Timeout;
}

export class SchedulerService {
  private ai: GoogleGenAI;
  private timezone: string = 'America/Santiago';
  private morningDigestTask: ScheduledTask | null = null;
  private meetSyncTask: ScheduledTask | null = null;
  private activeReminders: Map<string, ActiveReminder> = new Map();

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  }

  /**
   * Inicia los cron jobs configurados y recupera recordatorios pendientes desde SQLite
   */
  public start(): void {
    console.log(`⏰ [SchedulerService] Inicializando tareas programadas (Timezone: ${this.timezone})...`);

    // 1. Restaurar recordatorios pendientes persistidos en SQLite
    this.restorePendingReminders();

    // 2. Morning Digest: Lunes a Domingo a las 08:30 AM CLT
    const digestCronExpr = process.env.MORNING_DIGEST_CRON || '30 8 * * *';
    this.morningDigestTask = cron.schedule(
      digestCronExpr,
      async () => {
        console.log('🌅 [SchedulerService] Ejecutando Morning Digest programado...');
        await this.runMorningDigest();
      },
      {
        timezone: this.timezone,
      }
    );
    console.log(`✅ [SchedulerService] Morning Digest programado para: "${digestCronExpr}" (${this.timezone})`);

    // 3. Sincronización de grabaciones de Google Meet: 20:00 CLT Lunes a Viernes
    const meetSyncCronExpr = process.env.MEET_SYNC_CRON || '0 20 * * 1-5';
    this.meetSyncTask = cron.schedule(
      meetSyncCronExpr,
      async () => {
        console.log('📹 [SchedulerService] Ejecutando sincronización nocturna de Google Meet...');
        try {
          const results = await meetingIngestService.syncMeetRecordings();
          if (results.length > 0) {
            await telegramBotService.sendDirectMessage(
              `📹 <b>Sincronización Meet completada:</b> Se procesaron e indexaron <b>${results.length}</b> nueva(s) reunión(es) en la memoria episódica.`,
              { parseMode: 'HTML' }
            );
          }
        } catch (err: any) {
          console.error('❌ [SchedulerService] Error en sync nocturno de Meet:', err.message);
        }
      },
      {
        timezone: this.timezone,
      }
    );
    console.log(`✅ [SchedulerService] Sincronización nocturna de Meet programada para: "${meetSyncCronExpr}"`);

    // 4. Actualización semanal de catálogo de precios de LiteLLM: Domingos 03:00 CLT
    cron.schedule(
      '0 3 * * 0',
      async () => {
        console.log('🔄 [SchedulerService] Ejecutando actualización periódica de precios LiteLLM...');
        try {
          await tokenTrackerService.checkAndUpdatePricingInBackground(true);
        } catch (err: any) {
          console.warn('⚠️ [SchedulerService] Error en actualización periódica de precios:', err.message);
        }
      },
      {
        timezone: this.timezone,
      }
    );
    console.log(`✅ [SchedulerService] Actualización semanal de precios LiteLLM programada (Domingos 03:00 CLT)`);

    // 5. Consolidación nocturna de contexto (Chat y Gmail): 21:00 CLT Lunes a Viernes
    const contextSyncCronExpr = process.env.CONTEXT_SYNC_CRON || '0 21 * * 1-5';
    cron.schedule(
      contextSyncCronExpr,
      async () => {
        console.log('🧠 [SchedulerService] Ejecutando consolidación nocturna de contexto (Chat + Gmail)...');
        try {
          const { contextConsolidationService } = await import('./context_consolidation.service.js');
          const result = await contextConsolidationService.consolidateAll(24);
          if (result.totalIndexed > 0) {
            await telegramBotService.sendDirectMessage(
              `🧠 <b>Consolidación Nocturna de Memoria Episódica</b>\n\n` +
              `Se indexaron <b>${result.totalIndexed}</b> nuevas decisiones/acuerdos en Qdrant:\n` +
              `• Google Chat: ${result.chat.indexed} acuerdos (${result.chat.processed} hilos analizados)\n` +
              `• Gmail: ${result.gmail.indexed} acuerdos (${result.gmail.processed} hilos analizados)`,
              { parseMode: 'HTML' }
            );
          }
        } catch (err: any) {
          console.error('❌ [SchedulerService] Error en consolidación nocturna de contexto:', err.message);
        }
      },
      {
        timezone: this.timezone,
      }
    );
    console.log(`✅ [SchedulerService] Consolidación nocturna de contexto programada para: "${contextSyncCronExpr}"`);
  }

  /**
   * Restaura desde SQLite los recordatorios que quedaron pendientes al reiniciar el servicio
   */
  private restorePendingReminders(): void {
    try {
      const pending = sqliteReminderService.getPendingReminders();
      if (!pending || pending.length === 0) return;

      console.log(`🔄 [SchedulerService] Restaurando ${pending.length} recordatorio(s) pendiente(s) desde SQLite...`);
      const now = Date.now();

      for (const r of pending) {
        const diffMs = r.target_time - now;

        if (diffMs <= 0) {
          // Ya pasó la hora mientras el servidor estaba apagado (si fue hace menos de 24h)
          const hoursAgo = Math.abs(diffMs) / (1000 * 60 * 60);
          if (hoursAgo <= 24) {
            console.log(`⏰ [SchedulerService] Disparando recordatorio atrasado tras reinicio: "${r.message}"`);
            telegramBotService.sendDirectMessage(
              `⏰ <b>RECORDATORIO PENDIENTE (Recuperado tras reinicio):</b>\n\n📌 ${r.message}\n\n<i>(Estaba programado para el ${new Date(r.target_time).toLocaleString('es-CL')})</i>`,
              { parseMode: 'HTML' }
            ).catch(() => {});
          }
          sqliteReminderService.markCompleted(r.id);
        } else {
          // Aún está en el futuro: volver a programar el temporizador
          this.scheduleMemoryTimer(r.id, new Date(r.target_time), r.message, diffMs);
        }
      }
    } catch (err: any) {
      console.warn('⚠️ [SchedulerService] Error restaurando recordatorios desde SQLite:', err.message);
    }
  }

  /**
   * Programa el temporizador en memoria y actualiza SQLite al completarse
   */
  private scheduleMemoryTimer(id: string, targetTime: Date, message: string, delayMs: number): void {
    const timerRef = setTimeout(async () => {
      console.log(`⏰ [SchedulerService] Disparando recordatorio ${id}: "${message}"`);
      await telegramBotService.sendDirectMessage(
        `⏰ <b>RECORDATORIO PROGRAMADO:</b>\n\n📌 ${message}\n\n<i>(Programado para las ${targetTime.toLocaleTimeString('es-CL')})</i>`,
        { parseMode: 'HTML' }
      );
      this.activeReminders.delete(id);
      sqliteReminderService.markCompleted(id);
    }, delayMs);

    this.activeReminders.set(id, {
      id,
      targetTime,
      message,
      createdAt: new Date(),
      timerRef,
    });
  }

  /**
   * Detiene los crons activos
   */
  public stop(): void {
    if (this.morningDigestTask) this.morningDigestTask.stop();
    if (this.meetSyncTask) this.meetSyncTask.stop();
    for (const reminder of this.activeReminders.values()) {
      if (reminder.timerRef) clearTimeout(reminder.timerRef);
    }
    this.activeReminders.clear();
    console.log('🛑 [SchedulerService] Tareas programadas detenidas.');
  }

  /**
   * Ejecuta el Morning Digest (disponible bajo demanda o por cron)
   */
  public async runMorningDigest(): Promise<string> {
    try {
      // 1. Obtener eventos de hoy
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

      let events: any[] = [];
      try {
        events = await googleService.listCalendarEvents(startOfDay.toISOString(), endOfDay.toISOString(), 15);
      } catch (calErr: any) {
        console.warn('⚠️ [SchedulerService] No se pudo obtener eventos de Calendar:', calErr.message);
      }

      // 2. Obtener correos sin leer recientes
      let unreadEmails: any[] = [];
      try {
        unreadEmails = await googleService.searchEmails('is:unread newer_than:1d', 8);
      } catch (gmailErr: any) {
        console.warn('⚠️ [SchedulerService] No se pudo obtener correos sin leer:', gmailErr.message);
      }

      // 3. Sintetizar con Gemini 2.5 Flash
      const contextPrompt = `
Eres el clon digital y asistente ejecutivo de Jesús Leiva (CTO de Apprecio).
Hoy es ${now.toLocaleDateString('es-CL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.
Genera un Morning Digest ejecutivo matutino para Telegram.
Tono: Directo, ejecutivo, sin saludos genéricos ni formalismos excesivos. Como un CTO que tiene control de su día.

Información recopilada:
--- CALENDARIO DE HOY ---
${events.length === 0 ? 'Sin reuniones programadas para hoy.' : events.map(e => `- ${e.start?.substring(11, 16) || 'Todo el día'}: ${e.summary} (Participantes: ${e.attendees.slice(0, 3).join(', ')})`).join('\n')}

--- CORREOS SIN LEER RECIENTES ---
${unreadEmails.length === 0 ? 'Bandeja al día sin correos sin leer recientes.' : unreadEmails.map(m => `- De: ${m.from} | Asunto: ${m.subject} (ID: ${m.id})`).join('\n')}

Instrucciones de formato:
- Usa encabezados claros y viñetas concisas.
- Resalta en negrita horas y nombres clave.
- Si hay un hueco importante en la agenda o temas que requieran foco, menciónalo brevemente al final.
- Máximo 300 palabras.
`;

      const aiRes = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: contextPrompt,
      });

      if (aiRes.usageMetadata) {
        tokenTrackerService.logUsage(
          'Morning Digest diario',
          'gemini-2.5-flash',
          tokenTrackerService.extractUsage(aiRes.usageMetadata).inputTokens,
          tokenTrackerService.extractUsage(aiRes.usageMetadata).outputTokens,
          'morning_digest',
          'system',
          'morning_digest'
        ).catch(() => {});
      }

      const digestText = aiRes.text?.trim() || 'No se pudo generar el texto del Morning Digest.';
      const formattedHtml = messageFormatter.formatForTelegram(digestText);

      // 4. Enviar a Telegram
      await telegramBotService.sendDirectMessage(
        `🌅 <b>MORNING DIGEST — ${now.toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' })}</b>\n\n${formattedHtml}`,
        { parseMode: 'HTML' }
      );

      return digestText;
    } catch (err: any) {
      console.error('❌ [SchedulerService] Error generando Morning Digest:', err.message);
      const errAlert = `⚠️ Error al generar tu Morning Digest matutino: ${err.message}`;
      await telegramBotService.sendDirectMessage(errAlert);
      return errAlert;
    }
  }

  /**
   * Programa un recordatorio para una fecha/hora específica y lo persiste en SQLite
   */
  public scheduleReminder(targetTime: Date, message: string): { id: string; scheduledFor: string; remainingMinutes: number } {
    const now = Date.now();
    const delayMs = targetTime.getTime() - now;

    if (delayMs <= 0) {
      throw new Error('La fecha/hora del recordatorio debe ser en el futuro.');
    }

    const id = Math.random().toString(36).substring(2, 9);
    const remainingMinutes = Math.round(delayMs / 60000);

    // 1. Persistir en SQLite local
    sqliteReminderService.saveReminder(id, targetTime.getTime(), message);

    // 2. Programar temporizador en memoria
    this.scheduleMemoryTimer(id, targetTime, message, delayMs);

    return {
      id,
      scheduledFor: targetTime.toLocaleString('es-CL'),
      remainingMinutes,
    };
  }

  /**
   * Cancela un recordatorio por su ID en SQLite y en memoria
   */
  public cancelReminder(id: string): boolean {
    const reminder = this.activeReminders.get(id);
    if (reminder) {
      if (reminder.timerRef) clearTimeout(reminder.timerRef);
      this.activeReminders.delete(id);
    }
    return sqliteReminderService.cancel(id);
  }

  /**
   * Lista los recordatorios activos consultando SQLite
   */
  public listReminders(): Array<{ id: string; targetTime: string; message: string }> {
    try {
      const pending = sqliteReminderService.getPendingReminders();
      if (pending && pending.length > 0) {
        return pending.map(r => ({
          id: r.id,
          targetTime: new Date(r.target_time).toLocaleString('es-CL'),
          message: r.message,
        }));
      }
    } catch {
      // Fallback a memoria
    }

    return Array.from(this.activeReminders.values()).map(r => ({
      id: r.id,
      targetTime: r.targetTime.toLocaleString('es-CL'),
      message: r.message,
    }));
  }
}

export const schedulerService = new SchedulerService();
