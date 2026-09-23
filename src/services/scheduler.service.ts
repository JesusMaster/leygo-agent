import cron from 'node-cron';
import dotenv from 'dotenv';
import { googleService } from './google.service.js';
import { meetingIngestService } from './meeting_ingest.service.js';
import { sqliteReminderService } from '../database/sqlite.service.js';
import { tokenTrackerService } from './token_tracker.service.js';
import { scheduledTasksService } from './scheduled_tasks.service.js';
import { commitmentsService } from './commitments.service.js';
import { generarTexto } from '../agents/llm/model_factory.js';
import { beginUsageScope, flushUsageScope } from '../utils/usage_collector.js';

dotenv.config();

/** "30 8 * * *" → "08:30" si es un cron diario simple; si no, null. */
function horaDeCron(expr: string | undefined): string | null {
  const m = (expr || '').trim().match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  return m ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : null;
}

export class SchedulerService {
  private timezone: string = process.env.SCHEDULER_TZ || 'America/Santiago';

  /**
   * Inicia los cron jobs configurados y recupera recordatorios pendientes desde SQLite
   */
  public start(): void {
    console.log(`⏰ [SchedulerService] Inicializando tareas programadas (Timezone: ${this.timezone})...`);

    // 1. Tareas programadas del usuario (recordatorios, rutinas, acciones del agente).
    //    Migra los recordatorios de la tabla vieja y programa las activas.
    scheduledTasksService.start();

    // 2. Rutinas del sistema como tareas programadas: se crean la primera vez y
    //    desde ahí se editan (hora, canales, pausa) en la GUI como cualquier otra.
    const digestHora = horaDeCron(process.env.MORNING_DIGEST_CRON) || '08:30';
    scheduledTasksService.registrarIntegrada({
      key: 'morning_digest',
      titulo: 'Morning Digest',
      descripcion: 'Agenda de hoy, correos sin leer y escalamientos pendientes, resumidos por la IA.',
      run: () => this.runMorningDigest(),
      defaults: process.env.MORNING_DIGEST_CRON && !horaDeCron(process.env.MORNING_DIGEST_CRON)
        ? { kind: 'cron', cron_expr: process.env.MORNING_DIGEST_CRON }
        : { kind: 'daily', time_of_day: digestHora },
    });

    scheduledTasksService.registrarIntegrada({
      key: 'commitments_reminder',
      titulo: 'Aviso de compromisos',
      descripcion: 'Te avisa A TI (por los canales de esta tarea) de los compromisos vencidos, los de hoy y los propuestos por revisar. Además dispara los friendly reminders automáticos: esos le llegan a cada persona por los canales guardados en su compromiso (la campana), y acá solo recibes el resumen de a quién se le escribió. Solo avisa si hay algo.',
      run: async () => {
        const recordatorios = await commitmentsService.enviarRecordatoriosAutomaticos();
        return [commitmentsService.textoAviso(), recordatorios].filter(Boolean).join('\n\n');
      },
      defaults: { kind: 'daily', time_of_day: '09:00' },
    });

    scheduledTasksService.registrarIntegrada({
      key: 'meet_sync',
      titulo: 'Sincronizar grabaciones de Meet',
      descripcion: 'Busca grabaciones nuevas de Google Meet en Drive y las indexa en la memoria episódica. Avisa solo si procesó algo.',
      run: async () => {
        const results = await meetingIngestService.syncMeetRecordings();
        return results.length ? `📹 **Sincronización Meet:** se procesaron e indexaron **${results.length}** reunión(es) nueva(s) en la memoria episódica.` : '';
      },
      defaults: { kind: 'cron', cron_expr: process.env.MEET_SYNC_CRON || '0 20 * * 1-5' },
    });

    scheduledTasksService.registrarIntegrada({
      key: 'context_sync',
      titulo: 'Consolidar contexto (Chat + Gmail)',
      descripcion: 'Extrae acuerdos y decisiones de las conversaciones de las últimas 24 h hacia la memoria episódica. Avisa solo si indexó algo.',
      run: async () => {
        const { contextConsolidationService } = await import('./context_consolidation.service.js');
        const r = await contextConsolidationService.consolidateAll(24);
        if (r.totalIndexed <= 0) return '';
        return `🧠 **Consolidación de memoria episódica**\n\nSe indexaron **${r.totalIndexed}** decisiones/acuerdos nuevos:\n• Google Chat: ${r.chat.indexed} acuerdos (${r.chat.processed} hilos analizados)\n• Gmail: ${r.gmail.indexed} acuerdos (${r.gmail.processed} hilos analizados)`;
      },
      defaults: { kind: 'cron', cron_expr: process.env.CONTEXT_SYNC_CRON || '0 21 * * 1-5' },
    });

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

  }

  /**
   * Detiene los crons activos
   */
  public stop(): void {
    scheduledTasksService.stop();
    console.log('🛑 [SchedulerService] Tareas programadas detenidas.');
  }

  /**
   * Ejecuta el Morning Digest (disponible bajo demanda o por cron)
   */
  public async runMorningDigest(): Promise<string> {
    beginUsageScope('system', 'morning_digest', 'Morning Digest diario');
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

      // 3. Escalamientos pendientes de tu decisión (triage_agent)
      let pendingEscalations: any[] = [];
      try {
        pendingEscalations = sqliteReminderService.listEscalations('pendiente', 10);
      } catch (escErr: any) {
        console.warn('⚠️ [SchedulerService] No se pudieron leer los escalamientos:', escErr.message);
      }

      // 4. Sintetizar con el modelo asignado a 'morning_digest' en Ajustes
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

--- COMPROMISOS (lista viva) ---
${commitmentsService.textoDigest() || 'Sin vencidos ni compromisos para hoy.'}

--- PENDIENTES DE TU DECISIÓN (escalamientos) ---
${pendingEscalations.length === 0 ? 'Nada pendiente de decisión.' : pendingEscalations.map((e: any) => `- [${e.id}] (${e.urgency}) ${e.topic} — pidió ${e.requester} por ${e.channel}: ${String(e.summary).slice(0, 180)}`).join('\n')}

Instrucciones de formato:
- No pongas título ni fecha al inicio (ya van en el encabezado del mensaje): parte directo por la agenda.
- Usa encabezados claros y viñetas concisas.
- Resalta en negrita horas y nombres clave.
- Si hay compromisos vencidos o para hoy, van en su propia sección con el id entre corchetes; los "propuestos sin revisar" se mencionan en una línea.
- Si hay escalamientos pendientes, ábrelos en su propia sección al final con su ID entre corchetes: son decisiones que solo Jesús puede tomar y son lo más importante del digest.
- Si hay un hueco importante en la agenda o temas que requieran foco, menciónalo brevemente al final.
- Máximo 300 palabras.
`;

      const digestText = await generarTexto('morning_digest', 'gemini-3.5-flash-lite', contextPrompt);
      const fecha = now.toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' });
      return `🌅 **MORNING DIGEST — ${fecha}**\n\n${digestText || 'No se pudo generar el texto del Morning Digest.'}`;
    } catch (err: any) {
      console.error('❌ [SchedulerService] Error generando Morning Digest:', err.message);
      throw err;
    } finally {
      flushUsageScope().catch(() => {});
    }
  }

  /**
   * Programa un recordatorio para una fecha/hora específica y lo persiste en SQLite
   */
  public scheduleReminder(targetTime: Date, message: string): { id: string; scheduledFor: string; remainingMinutes: number } {
    const tarea = scheduledTasksService.create({ message, autonomous: false, kind: 'once', run_at: targetTime.getTime() });
    return {
      id: tarea.id,
      scheduledFor: targetTime.toLocaleString('es-CL', { timeZone: this.timezone }),
      remainingMinutes: Math.round((targetTime.getTime() - Date.now()) / 60000),
    };
  }

  public cancelReminder(id: string): boolean {
    return scheduledTasksService.delete(id);
  }

  /** Recordatorios y tareas activas (para la herramienta list_scheduled_reminders) */
  public listReminders(): Array<{ id: string; targetTime: string; message: string; tipo: string }> {
    return scheduledTasksService.list()
      .filter((t) => t.status === 'active')
      .map((t) => ({
        id: t.id,
        targetTime: t.next_run_at ? new Date(t.next_run_at).toLocaleString('es-CL', { timeZone: this.timezone }) : '—',
        message: t.message,
        tipo: (t.autonomous ? 'acción del agente · ' : 'recordatorio · ') + t.descripcion,
      }));
  }
}

export const schedulerService = new SchedulerService();
