import cron from 'node-cron';
import { sqliteReminderService, ScheduledTask, ScheduledTaskKind, ScheduledTaskRun, ScheduledTaskChannel, TaskDelivery } from '../database/sqlite.service.js';
import { telegramBotService } from './telegram_bot.service.js';
import { messageFormatter } from '../utils/message_formatter.js';

/**
 * Tareas programadas, al estilo de las "Tareas Programadas" de Leygo.
 *
 * Cuatro formas de programar: una vez (fecha), cada N minutos, diaria a una
 * hora, o cron. Dos formas de ejecutar: un recordatorio simple (se manda el
 * texto a Telegram) o una acción autónoma (el agente recibe la instrucción,
 * la trabaja con sus herramientas, y el resultado se manda a Telegram).
 *
 * Cada ejecución queda en scheduled_task_runs con duración, estado y resultado.
 * Los recordatorios de la tabla vieja se migran al arrancar.
 */

type RunAgent = (instruction: string, taskId: string) => Promise<string>;

interface Programada {
  cronTask?: ReturnType<typeof cron.schedule>;
  timer?: NodeJS.Timeout;
}

export class ScheduledTasksService {
  private timezone = process.env.SCHEDULER_TZ || 'America/Santiago';
  private programadas = new Map<string, Programada>();
  private runAgent: RunAgent | null = null;
  private enCurso = new Set<string>();

  /** index.ts inyecta cómo correr una instrucción por el agente (necesita el Runner). */
  public setAgentRunner(fn: RunAgent) { this.runAgent = fn; }

  public start(): void {
    const migradas = sqliteReminderService.migrateRemindersToTasks();
    if (migradas > 0) console.log(`🔄 [Tareas] ${migradas} recordatorio(s) migrado(s) a tareas programadas.`);

    const tareas = sqliteReminderService.listScheduledTasks();
    let activas = 0;
    for (const t of tareas) {
      if (t.status !== 'active') continue;
      this.programar(t);
      activas++;
    }
    console.log(`⏰ [Tareas] ${activas} tarea(s) activa(s) programada(s) (${this.timezone}).`);
  }

  public stop(): void {
    for (const id of [...this.programadas.keys()]) this.desprogramar(id);
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────

  public list(): Array<ScheduledTask & { descripcion: string }> {
    return sqliteReminderService.listScheduledTasks().map((t) => ({ ...t, descripcion: this.describir(t) }));
  }

  public get(id: string) { return sqliteReminderService.getScheduledTask(id); }

  public create(input: {
    message: string; autonomous: boolean; kind: ScheduledTaskKind;
    run_at?: number | string | null; interval_minutes?: number | null; time_of_day?: string | null; cron_expr?: string | null;
    channel?: ScheduledTaskChannel | null; target?: string | null; delivery?: TaskDelivery[] | null;
  }): ScheduledTask {
    const base = this.normalizar(input);
    const entrega = this.normalizarEntregas(input.delivery, input.channel, input.target);
    const id = Math.random().toString(36).substring(2, 9);
    const tarea = sqliteReminderService.createScheduledTask({
      id, message: input.message.trim(), autonomous: input.autonomous ? 1 : 0, kind: input.kind,
      ...base, ...entrega, status: 'active', next_run_at: this.proximaEjecucion({ ...base, kind: input.kind } as any),
    });
    this.programar(tarea);
    return tarea;
  }

  public update(id: string, cambios: Partial<{
    message: string; autonomous: boolean; kind: ScheduledTaskKind;
    run_at: number | string | null; interval_minutes: number | null; time_of_day: string | null; cron_expr: string | null;
    status: 'active' | 'paused'; channel: ScheduledTaskChannel; target: string | null; delivery: TaskDelivery[];
  }>): ScheduledTask | null {
    const actual = sqliteReminderService.getScheduledTask(id);
    if (!actual) return null;

    const kind = cambios.kind || actual.kind;
    const horario = this.normalizar({
      kind,
      run_at: cambios.run_at !== undefined ? cambios.run_at : actual.run_at,
      interval_minutes: cambios.interval_minutes !== undefined ? cambios.interval_minutes : actual.interval_minutes,
      time_of_day: cambios.time_of_day !== undefined ? cambios.time_of_day : actual.time_of_day,
      cron_expr: cambios.cron_expr !== undefined ? cambios.cron_expr : actual.cron_expr,
    });

    const status = cambios.status || (actual.status === 'done' ? 'active' : actual.status);
    const entrega = cambios.delivery !== undefined
      ? this.normalizarEntregas(cambios.delivery)
      : (cambios.channel !== undefined || cambios.target !== undefined)
        ? this.normalizarEntregas(null, cambios.channel ?? actual.channel, cambios.target !== undefined ? cambios.target : actual.target)
        : this.normalizarEntregas(actual.delivery);
    const actualizada = sqliteReminderService.updateScheduledTask(id, {
      message: cambios.message !== undefined ? cambios.message.trim() : actual.message,
      autonomous: cambios.autonomous !== undefined ? (cambios.autonomous ? 1 : 0) : actual.autonomous,
      kind, ...horario, ...entrega, status,
      next_run_at: status === 'active' ? this.proximaEjecucion({ ...horario, kind } as any) : null,
    });

    this.desprogramar(id);
    if (actualizada && actualizada.status === 'active') this.programar(actualizada);
    return actualizada;
  }

  public delete(id: string): boolean {
    this.desprogramar(id);
    return sqliteReminderService.deleteScheduledTask(id);
  }

  public runs(id: string, limit = 20): ScheduledTaskRun[] {
    return sqliteReminderService.listScheduledTaskRuns(id, limit);
  }

  // ─── Ejecución ───────────────────────────────────────────────────────────

  public async runNow(id: string): Promise<ScheduledTaskRun | null> {
    const t = sqliteReminderService.getScheduledTask(id);
    if (!t) return null;
    return this.ejecutar(t, 'manual');
  }

  private async ejecutar(t: ScheduledTask, trigger: 'scheduled' | 'manual'): Promise<ScheduledTaskRun> {
    if (this.enCurso.has(t.id)) {
      const r = { task_id: t.id, started_at: Date.now(), duration_ms: 0, status: 'error' as const, trigger, result: 'Se omitió: la ejecución anterior todavía está en curso.' };
      sqliteReminderService.addScheduledTaskRun(r);
      return { id: 0, ...r };
    }
    this.enCurso.add(t.id);
    const inicio = Date.now();
    let status: 'success' | 'error' = 'success';
    let result = '';

    try {
      let fallos: string[] = [];
      if (t.autonomous) {
        if (!this.runAgent) throw new Error('El agente no está disponible para ejecutar tareas autónomas.');
        result = await this.runAgent(t.message, t.id);
        fallos = await this.entregar(t, result, true);
      } else {
        result = t.message;
        fallos = await this.entregar(t, result, false);
      }
      if (fallos.length) result += `\n\n⚠️ No se pudo entregar por: ${fallos.join(' · ')}`;
    } catch (err: any) {
      status = 'error';
      result = err?.message || String(err);
      console.error(`❌ [Tareas] Falló la tarea ${t.id}:`, result);
    } finally {
      this.enCurso.delete(t.id);
    }

    const run = { task_id: t.id, started_at: inicio, duration_ms: Date.now() - inicio, status, trigger, result };
    sqliteReminderService.addScheduledTaskRun(run);

    // Estado posterior: una tarea de una vez termina; el resto recalcula la próxima
    const fresca = sqliteReminderService.getScheduledTask(t.id);
    if (fresca) {
      if (fresca.kind === 'once' && trigger === 'scheduled') {
        sqliteReminderService.updateScheduledTask(t.id, { last_run_at: inicio, status: 'done', next_run_at: null });
        this.desprogramar(t.id);
      } else {
        sqliteReminderService.updateScheduledTask(t.id, { last_run_at: inicio, next_run_at: fresca.status === 'active' ? this.proximaEjecucion(fresca) : null });
      }
    }
    return { id: 0, ...run };
  }

  // ─── Entrega ─────────────────────────────────────────────────────────────

  /**
   * Entrega el resultado por TODOS los destinos de la tarea. Se manda solo el
   * contenido: la instrucción de la tarea no viaja en el mensaje (el que la
   * programó ya sabe qué pidió). Falla solo si fallan todos los destinos; si
   * falla alguno, el error queda anotado en el resultado de la corrida.
   */
  private async entregar(t: ScheduledTask, texto: string, autonoma: boolean): Promise<string[]> {
    const destinos = t.delivery?.length ? t.delivery : [{ channel: t.channel || 'telegram', target: t.target }];
    const fallos: string[] = [];

    for (const d of destinos) {
      try {
        await this.entregarEn(d, texto, autonoma);
      } catch (err: any) {
        fallos.push(`${this.nombreCanal(d.channel)}: ${err?.message || err}`);
      }
    }
    if (fallos.length === destinos.length) throw new Error(`No se pudo entregar por ningún canal — ${fallos.join(' · ')}`);
    return fallos;
  }

  private async entregarEn(d: TaskDelivery, texto: string, autonoma: boolean): Promise<void> {
    switch (d.channel) {
      case 'chat': {
        if (!d.target) throw new Error('falta el espacio de Google Chat');
        const { googleService } = await import('./google.service.js');
        await googleService.sendChatMessage(d.target, messageFormatter.formatForGoogleChat(autonoma ? texto : `⏰ ${texto}`));
        return;
      }
      case 'email': {
        if (!d.target) throw new Error('falta el correo de destino');
        const { googleService } = await import('./google.service.js');
        const asunto = autonoma ? `[Yisus] ${primeraLinea(texto)}` : `[Yisus] Recordatorio: ${primeraLinea(texto)}`;
        const borrador = await googleService.createDraft(d.target, asunto, texto);
        await googleService.sendDraft(borrador.draftId!);
        return;
      }
      case 'buzz': {
        const { nostrGatewayService } = await import('./nostr_gateway.service.js');
        const r = await nostrGatewayService.publishToChannel(messageFormatter.formatForPlainText(autonoma ? texto : `⏰ ${texto}`), d.target || undefined);
        if (r.status !== 'success') throw new Error(r.message || 'no se pudo publicar');
        return;
      }
      case 'telegram':
      default:
        await telegramBotService.sendDirectMessage(autonoma ? formatear(texto) : `⏰ ${escapar(texto)}`, { parseMode: 'HTML' });
    }
  }

  private nombreCanal(c: ScheduledTaskChannel): string {
    return { telegram: 'Telegram', chat: 'Google Chat', buzz: 'Buzz', email: 'Email' }[c] || c;
  }

  /** Valida y normaliza la lista de destinos; acepta también el par channel/target antiguo. */
  private normalizarEntregas(delivery?: TaskDelivery[] | null, channel?: ScheduledTaskChannel | null, target?: string | null): { channel: ScheduledTaskChannel; target: string | null; delivery: TaskDelivery[] } {
    let lista: TaskDelivery[] = Array.isArray(delivery) && delivery.length ? delivery : [{ channel: channel || 'telegram', target }];
    const vistos = new Set<string>();
    const limpia: TaskDelivery[] = [];
    for (const d of lista) {
      const c = (d?.channel || 'telegram') as ScheduledTaskChannel;
      const tg = (d?.target || '').trim() || null;
      switch (c) {
        case 'telegram': break;
        case 'chat':
          if (!tg || !/^spaces\/[A-Za-z0-9_-]+$/.test(tg)) throw new Error('Para Google Chat indica el espacio de destino (spaces/…).');
          break;
        case 'email':
          if (!tg || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tg)) throw new Error('Para email indica un correo de destino válido.');
          break;
        case 'buzz': break;
        default: throw new Error(`Canal desconocido: ${c}`);
      }
      const clave = `${c}|${c === 'telegram' ? '' : tg || ''}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      limpia.push({ channel: c, target: c === 'telegram' ? null : tg });
    }
    if (!limpia.length) throw new Error('La tarea necesita al menos un canal de entrega.');
    return { channel: limpia[0].channel, target: limpia[0].target ?? null, delivery: limpia };
  }

  // ─── Programación ────────────────────────────────────────────────────────

  private programar(t: ScheduledTask): void {
    this.desprogramar(t.id);
    const p: Programada = {};

    if (t.kind === 'once') {
      const delay = (t.run_at || 0) - Date.now();
      if (delay <= 0) {
        // Se pasó la hora mientras el servicio estaba apagado: si fue hace menos de 24 h, se dispara igual
        if (delay > -24 * 3600 * 1000) void this.ejecutar(t, 'scheduled');
        else sqliteReminderService.updateScheduledTask(t.id, { status: 'done', next_run_at: null });
        return;
      }
      // setTimeout no acepta más de ~24.8 días: se reprograma por tramos
      const tramo = Math.min(delay, 2_000_000_000);
      p.timer = setTimeout(() => {
        if (tramo < delay) this.programar(sqliteReminderService.getScheduledTask(t.id)!);
        else void this.ejecutar(t, 'scheduled');
      }, tramo);
    } else if (t.kind === 'interval') {
      const ms = Math.max(1, t.interval_minutes || 1) * 60_000;
      p.timer = setInterval(() => void this.ejecutar(t, 'scheduled'), ms);
    } else {
      const expr = t.kind === 'daily' ? this.cronDeHora(t.time_of_day || '09:00') : (t.cron_expr || '');
      if (!cron.validate(expr)) {
        console.warn(`⚠️ [Tareas] Expresión cron inválida en ${t.id}: "${expr}". Tarea pausada.`);
        sqliteReminderService.updateScheduledTask(t.id, { status: 'paused', next_run_at: null });
        return;
      }
      p.cronTask = cron.schedule(expr, () => void this.ejecutar(t, 'scheduled'), { timezone: this.timezone });
    }
    this.programadas.set(t.id, p);
  }

  private desprogramar(id: string): void {
    const p = this.programadas.get(id);
    if (!p) return;
    if (p.timer) { clearTimeout(p.timer); clearInterval(p.timer); }
    if (p.cronTask) { try { p.cronTask.stop(); (p.cronTask as any).destroy?.(); } catch {} }
    this.programadas.delete(id);
  }

  // ─── Utilidades ──────────────────────────────────────────────────────────

  private normalizar(i: { kind: ScheduledTaskKind; run_at?: number | string | null; interval_minutes?: number | null; time_of_day?: string | null; cron_expr?: string | null }) {
    const out = { run_at: null as number | null, interval_minutes: null as number | null, time_of_day: null as string | null, cron_expr: null as string | null };
    switch (i.kind) {
      case 'once': {
        const ts = typeof i.run_at === 'string' ? new Date(i.run_at).getTime() : Number(i.run_at);
        if (!ts || isNaN(ts)) throw new Error('Falta la fecha y hora (run_at).');
        if (ts <= Date.now()) throw new Error('La fecha y hora deben ser en el futuro.');
        out.run_at = ts; break;
      }
      case 'interval': {
        const n = Number(i.interval_minutes);
        if (!n || n < 1) throw new Error('El intervalo debe ser de al menos 1 minuto.');
        out.interval_minutes = Math.round(n); break;
      }
      case 'daily': {
        const h = String(i.time_of_day || '').trim();
        if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(h)) throw new Error('La hora debe tener formato HH:MM.');
        out.time_of_day = h.padStart(5, '0'); break;
      }
      case 'cron': {
        const e = String(i.cron_expr || '').trim();
        if (!cron.validate(e)) throw new Error(`Expresión cron inválida: "${e}".`);
        out.cron_expr = e; break;
      }
      default: throw new Error(`Tipo de tarea desconocido: ${i.kind}`);
    }
    return out;
  }

  private cronDeHora(hhmm: string): string {
    const [h, m] = hhmm.split(':').map(Number);
    return `${m} ${h} * * *`;
  }

  private proximaEjecucion(t: Pick<ScheduledTask, 'kind' | 'run_at' | 'interval_minutes' | 'time_of_day' | 'cron_expr'>): number | null {
    try {
      if (t.kind === 'once') return t.run_at;
      if (t.kind === 'interval') return Date.now() + (t.interval_minutes || 1) * 60_000;
      const expr = t.kind === 'daily' ? this.cronDeHora(t.time_of_day || '09:00') : (t.cron_expr || '');
      // getNextRun() solo responde en una tarea iniciada: createTask() la deja detenida y devuelve null.
      const tmp = cron.schedule(expr, () => {}, { timezone: this.timezone });
      const next = tmp.getNextRun();
      tmp.stop();
      (tmp as any).destroy?.();
      return next ? next.getTime() : null;
    } catch { return null; }
  }

  private describir(t: ScheduledTask): string {
    return `${this.describirHorario(t)} · ${this.describirCanal(t)}`;
  }

  private describirCanal(t: ScheduledTask): string {
    const destinos = t.delivery?.length ? t.delivery : [{ channel: t.channel || 'telegram', target: t.target }];
    const partes = destinos.map((d) => {
      switch (d.channel) {
        case 'chat': return 'Google Chat';
        case 'email': return `email a ${d.target}`;
        case 'buzz': return 'Buzz';
        default: return 'Telegram';
      }
    });
    return `por ${partes.join(' + ')}`;
  }

  private describirHorario(t: ScheduledTask): string {
    switch (t.kind) {
      case 'once': return `Una vez, el ${new Date(t.run_at || 0).toLocaleString('es-CL', { timeZone: this.timezone, dateStyle: 'medium', timeStyle: 'short' })}`;
      case 'interval': return `Cada ${t.interval_minutes} min`;
      case 'daily': return `Todos los días a las ${t.time_of_day}`;
      case 'cron': return `Cron: ${t.cron_expr}`;
    }
  }
}

function primeraLinea(t: string): string {
  const l = (t || '').split('\n').map((x) => x.replace(/^[#*>\-\s]+/, '').trim()).find(Boolean) || 'Resultado';
  return l.length > 70 ? l.slice(0, 70) + '…' : l;
}

function escapar(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatear(markdown: string): string {
  try { return messageFormatter.formatForTelegram(markdown); } catch { return escapar(markdown); }
}

export const scheduledTasksService = new ScheduledTasksService();
