import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

export interface DbReminder {
  id: string;
  target_time: number;
  message: string;
  status: string; // 'pending' | 'completed' | 'cancelled'
  created_at: number;
  executed_at?: number | null;
}

export interface DbWebhookLog {
  id: string;
  provider: string;
  event_type: string;
  title: string;
  summary: string;
  raw_payload?: string;
  created_at: number;
}

export interface CustomWebhook {
  id: string;
  titulo: string;
  instrucciones: string;
  modelo: string;
  paused: number; // 0 = activo, 1 = pausado
  created_at: number;
  updated_at: number;
}

export interface CustomWebhookLog {
  id: number;
  webhook_id: string;
  payload: string;
  response: string;
  status: string; // 'success' | 'error' | 'skipped'
  created_at: number;
}

export type ScheduledTaskKind = 'once' | 'interval' | 'daily' | 'cron';
export type ScheduledTaskStatus = 'active' | 'paused' | 'done';
export type ScheduledTaskChannel = 'telegram' | 'chat' | 'buzz' | 'email';

export interface ScheduledTask {
  id: string;
  message: string;
  autonomous: number;          // 0 = recordatorio simple por Telegram, 1 = el agente ejecuta la instrucción
  kind: ScheduledTaskKind;
  run_at: number | null;       // once
  interval_minutes: number | null;
  time_of_day: string | null;  // daily, "HH:MM"
  cron_expr: string | null;
  status: ScheduledTaskStatus;
  channel: ScheduledTaskChannel;   // por dónde se entrega el resultado
  target: string | null;           // espacio de Chat, correo destino o canal de Buzz (según channel)
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
}

export interface ScheduledTaskRun {
  id: number;
  task_id: string;
  started_at: number;
  duration_ms: number;
  status: 'success' | 'error';
  trigger: 'scheduled' | 'manual';
  result: string;
}

export interface UsageRecord {
  id?: number;
  timestamp: string;
  user_input: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  thread_id: string;
  channel?: string;
  agent?: string;
}

export interface SystemConfig {
  key: string;
  value: string;
  updated_at: number;
}

export interface ConsolidatedThread {
  thread_id: string;
  source: string; // 'gmail' | 'google_chat'
  title: string;
  processed_at: number;
  message_count: number;
}

export class SqliteReminderService {
  /** Ruta efectiva del archivo SQLite en uso (para diagnóstico) */
  public readonly dbPath: string;

  private db: any;

  constructor() {
    // La ruta dependía SOLO de process.cwd(): dos procesos lanzados desde
    // directorios distintos (pm2, launchd, Docker, otra copia del repo) abrían
    // bases distintas sin decir nada, y los tokens creados en una no existían
    // en la otra. DATA_DIR lo hace explícito, y la ruta efectiva se loguea.
    const dataDir = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.resolve(process.cwd(), 'data');

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, 'reminders.db');
    const existia = fs.existsSync(dbPath);

    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.init();

    console.log(`🗄️  [SQLite] Base: ${dbPath}${existia ? '' : '  ← RECIÉN CREADA (estaba vacía)'}`);
    if (!existia) {
      console.warn('⚠️  [SQLite] Si esperabas encontrar datos acá (tokens A2A, consumo, recordatorios), este proceso está corriendo desde otro directorio. Usa DATA_DIR con una ruta absoluta.');
    }
  }

  private init(): void {
    // 1. Tabla de recordatorios
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        target_time INTEGER NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        executed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_status_time ON reminders(status, target_time);
    `);

    // 2. Tabla de historial de webhooks y alertas de proveedores fijos
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks_log (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event_type TEXT,
        title TEXT,
        summary TEXT,
        raw_payload TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhooks_created ON webhooks_log(created_at DESC);
    `);

    // 3. Tabla de Webhooks Personalizados con IA
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS custom_webhooks (
        id TEXT PRIMARY KEY,
        titulo TEXT NOT NULL,
        instrucciones TEXT NOT NULL,
        modelo TEXT NOT NULL,
        paused INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_custom_webhooks_created ON custom_webhooks(created_at DESC);
    `);

    // 4. Tabla de logs de ejecución de Webhooks Personalizados
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS custom_webhook_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id TEXT NOT NULL,
        payload TEXT,
        response TEXT,
        status TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_custom_webhook_logs_wh ON custom_webhook_logs(webhook_id, created_at DESC);
    `);

    // 5. Tabla de historial de consumo de tokens (Token Tracker)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        user_input TEXT,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0.0,
        thread_id TEXT DEFAULT 'system',
        channel TEXT DEFAULT 'unknown',
        agent TEXT DEFAULT 'unknown'
      );
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_history(timestamp DESC);
    `);

    // 6. Tabla de configuración del sistema (presupuestos, flags de alertas, etc.)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // 7. Tabla de hilos de conversación consolidados en la memoria episódica
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consolidated_threads (
        thread_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT,
        processed_at INTEGER NOT NULL,
        message_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_consolidated_source ON consolidated_threads(source, processed_at DESC);
    `);

    // 8. Estado de sincronización de archivos externos (Drive/Meet)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        version TEXT,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (source, external_id)
      );
    `);

    // 9. Escalamientos al Jesús real (triage_agent)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS escalations (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        channel TEXT DEFAULT 'unknown',
        requester TEXT,
        topic TEXT,
        summary TEXT,
        urgency TEXT DEFAULT 'media',
        status TEXT DEFAULT 'pendiente',
        resolved_at INTEGER,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status, created_at DESC);
    `);

    // 10. Tokens A2A administrables desde la GUI
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS a2a_tokens (
        name TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        tools TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `);

    // Tareas programadas (reemplazan a los recordatorios sueltos)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        autonomous INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        run_at INTEGER,
        interval_minutes INTEGER,
        time_of_day TEXT,
        cron_expr TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        channel TEXT NOT NULL DEFAULT 'telegram',
        target TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        next_run_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'scheduled',
        result TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs ON scheduled_task_runs(task_id, started_at DESC);
    `);

    // 11. Migraciones de esquema sobre bases ya existentes
    this.migrateUsageHistory();
    this.migrateScheduledTasks();
  }

  // ─── Recordatorios ──────────────────────────────────────────────────────────

  public saveReminder(id: string, targetTimeMs: number, message: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO reminders (id, target_time, message, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `);
    stmt.run(id, targetTimeMs, message, Date.now());
  }

  public getPendingReminders(): DbReminder[] {
    const stmt = this.db.prepare(`
      SELECT id, target_time, message, status, created_at, executed_at
      FROM reminders
      WHERE status = 'pending'
      ORDER BY target_time ASC
    `);
    return stmt.all() as DbReminder[];
  }

  public markCompleted(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE reminders
      SET status = 'completed', executed_at = ?
      WHERE id = ?
    `);
    stmt.run(Date.now(), id);
  }

  public cancel(id: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE reminders
      SET status = 'cancelled'
      WHERE id = ?
    `);
    const res = stmt.run(id);
    return Boolean(res && res.changes > 0);
  }

  // ─── Webhooks Log Fijo (GitHub, GitLab, Sentry) ─────────────────────────────

  public saveWebhookLog(
    id: string,
    provider: string,
    eventType: string,
    title: string,
    summary: string,
    rawPayload: string = ''
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO webhooks_log (id, provider, event_type, title, summary, raw_payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, provider, eventType, title, summary, rawPayload, Date.now());
  }

  public getRecentWebhooks(limit: number = 10): DbWebhookLog[] {
    const stmt = this.db.prepare(`
      SELECT id, provider, event_type, title, summary, created_at
      FROM webhooks_log
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as DbWebhookLog[];
  }

  // ─── Custom Webhooks con IA (CRUD y Ejecución) ──────────────────────────────

  public createCustomWebhook(titulo: string, instrucciones: string, modelo: string, customId?: string): CustomWebhook {
    const id = customId || crypto.randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO custom_webhooks (id, titulo, instrucciones, modelo, paused, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `);
    stmt.run(id, titulo, instrucciones, modelo, now, now);
    return {
      id,
      titulo,
      instrucciones,
      modelo,
      paused: 0,
      created_at: now,
      updated_at: now,
    };
  }

  public getCustomWebhooks(): CustomWebhook[] {
    const stmt = this.db.prepare(`
      SELECT id, titulo, instrucciones, modelo, paused, created_at, updated_at
      FROM custom_webhooks
      ORDER BY created_at DESC
    `);
    return stmt.all() as CustomWebhook[];
  }

  public getCustomWebhook(id: string): CustomWebhook | null {
    const stmt = this.db.prepare(`
      SELECT id, titulo, instrucciones, modelo, paused, created_at, updated_at
      FROM custom_webhooks
      WHERE id = ?
    `);
    const res = stmt.get(id);
    return res ? (res as CustomWebhook) : null;
  }

  public updateCustomWebhook(
    id: string,
    fields: { titulo?: string; instrucciones?: string; modelo?: string; paused?: number }
  ): CustomWebhook | null {
    const current = this.getCustomWebhook(id);
    if (!current) return null;

    const titulo = fields.titulo !== undefined ? fields.titulo : current.titulo;
    const instrucciones = fields.instrucciones !== undefined ? fields.instrucciones : current.instrucciones;
    const modelo = fields.modelo !== undefined ? fields.modelo : current.modelo;
    const paused = fields.paused !== undefined ? fields.paused : current.paused;
    const now = Date.now();

    const stmt = this.db.prepare(`
      UPDATE custom_webhooks
      SET titulo = ?, instrucciones = ?, modelo = ?, paused = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(titulo, instrucciones, modelo, paused, now, id);

    return {
      id,
      titulo,
      instrucciones,
      modelo,
      paused,
      created_at: current.created_at,
      updated_at: now,
    };
  }

  public deleteCustomWebhook(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM custom_webhooks WHERE id = ?`);
    const res = stmt.run(id);
    // Eliminar también sus logs asociados
    try {
      this.db.prepare(`DELETE FROM custom_webhook_logs WHERE webhook_id = ?`).run(id);
    } catch {}
    return Boolean(res && res.changes > 0);
  }

  public saveCustomWebhookLog(
    webhookId: string,
    payload: string,
    response: string,
    status: 'success' | 'error' | 'skipped'
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO custom_webhook_logs (webhook_id, payload, response, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(webhookId, payload, response, status, Date.now());
  }

  public deleteCustomWebhookLog(logId: number): boolean {
    const res = this.db.prepare(`DELETE FROM custom_webhook_logs WHERE id = ?`).run(logId) as any;
    return (res?.changes ?? 0) > 0;
  }

  /** Logs de todos los webhooks con el título de cada uno, para la vista "Ver ejecuciones". */
  public getAllCustomWebhookLogs(limit: number = 50): Array<CustomWebhookLog & { webhook_titulo: string | null }> {
    return this.db.prepare(`
      SELECT l.id, l.webhook_id, l.payload, l.response, l.status, l.created_at, w.titulo as webhook_titulo
      FROM custom_webhook_logs l
      LEFT JOIN custom_webhooks w ON w.id = l.webhook_id
      ORDER BY l.created_at DESC
      LIMIT ?
    `).all(limit) as any[];
  }

  public getCustomWebhookLogs(webhookId?: string, limit: number = 20): CustomWebhookLog[] {
    if (webhookId) {
      const stmt = this.db.prepare(`
        SELECT id, webhook_id, payload, response, status, created_at
        FROM custom_webhook_logs
        WHERE webhook_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      return stmt.all(webhookId, limit) as CustomWebhookLog[];
    } else {
      const stmt = this.db.prepare(`
        SELECT id, webhook_id, payload, response, status, created_at
        FROM custom_webhook_logs
        ORDER BY created_at DESC
        LIMIT ?
      `);
      return stmt.all(limit) as CustomWebhookLog[];
    }
  }

  // ─── Token Tracker & Budget ────────────────────────────────────────────────

  /**
   * Migración idempotente: agrega columnas nuevas a bases ya existentes.
   * (SQLite no soporta ADD COLUMN IF NOT EXISTS, hay que inspeccionar primero.)
   */
  private migrateUsageHistory(): void {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(usage_history)`).all() as any[];
      const existing = new Set(cols.map((c: any) => c.name));
      for (const col of ['channel', 'agent']) {
        if (!existing.has(col)) {
          this.db.exec(`ALTER TABLE usage_history ADD COLUMN ${col} TEXT DEFAULT 'unknown'`);
          console.log(`🛠️ [SQLite] usage_history migrada: columna "${col}" agregada.`);
        }
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_channel ON usage_history(channel)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_history(agent)`);
    } catch (err: any) {
      console.warn('⚠️ [SQLite] No se pudo migrar usage_history:', err.message);
    }
  }

  public logTokenUsage(record: Omit<UsageRecord, 'id'>): UsageRecord {
    const stmt = this.db.prepare(`
      INSERT INTO usage_history (timestamp, user_input, model, input_tokens, output_tokens, cost_usd, thread_id, channel, agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.timestamp,
      record.user_input,
      record.model,
      record.input_tokens,
      record.output_tokens,
      record.cost_usd,
      record.thread_id,
      record.channel || 'unknown',
      record.agent || 'unknown'
    );
    return record;
  }

  public getCurrentMonthCost(monthStartIso: string, channel?: string): number {
    const stmt = channel
      ? this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0.0) as total FROM usage_history WHERE timestamp >= ? AND channel = ?`)
      : this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0.0) as total FROM usage_history WHERE timestamp >= ?`);
    const row = (channel ? stmt.get(monthStartIso, channel) : stmt.get(monthStartIso)) as { total: number } | undefined;
    return row?.total ?? 0.0;
  }

  public getUsageByAgent(monthStartIso: string): Array<{ agent: string; model: string; count: number; input_tokens: number; output_tokens: number; total_cost: number }> {
    const stmt = this.db.prepare(`
      SELECT
        COALESCE(agent, 'unknown') as agent,
        model,
        COUNT(*) as count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cost_usd), 0.0) as total_cost
      FROM usage_history
      WHERE timestamp >= ?
      GROUP BY COALESCE(agent, 'unknown'), model
      ORDER BY total_cost DESC
    `);
    return stmt.all(monthStartIso) as any[];
  }

  public getUsageByChannel(monthStartIso: string): Array<{ channel: string; count: number; input_tokens: number; output_tokens: number; total_cost: number }> {
    const stmt = this.db.prepare(`
      SELECT
        COALESCE(channel, 'unknown') as channel,
        COUNT(*) as count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cost_usd), 0.0) as total_cost
      FROM usage_history
      WHERE timestamp >= ?
      GROUP BY COALESCE(channel, 'unknown')
      ORDER BY total_cost DESC
    `);
    return stmt.all(monthStartIso) as any[];
  }

  public getCurrentMonthTokens(monthStartIso: string): { inputTokens: number; outputTokens: number; totalTokens: number } {
    const stmt = this.db.prepare(`
      SELECT 
        COALESCE(SUM(input_tokens), 0) as total_in,
        COALESCE(SUM(output_tokens), 0) as total_out
      FROM usage_history
      WHERE timestamp >= ?
    `);
    const row = stmt.get(monthStartIso) as { total_in: number; total_out: number } | undefined;
    const inputTokens = row?.total_in ?? 0;
    const outputTokens = row?.total_out ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  public getUsageHistory(limit: number = 1000): UsageRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, user_input, model, input_tokens, output_tokens, cost_usd, thread_id, COALESCE(channel, 'unknown') as channel, COALESCE(agent, 'unknown') as agent
      FROM usage_history
      ORDER BY id DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as UsageRecord[];
    return rows.reverse(); // Cronológico como en Leygo
  }

  /**
   * Página del historial de consumo, más reciente primero.
   * Filtros opcionales por canal y agente; `total` es el conteo con esos filtros.
   */
  public getUsageHistoryPage(opts: { page?: number; pageSize?: number; channel?: string; agent?: string } = {}): { rows: UsageRecord[]; total: number; page: number; pageSize: number } {
    const pageSize = Math.min(Math.max(Number(opts.pageSize) || 25, 1), 200);
    const page = Math.max(Number(opts.page) || 1, 1);

    const where: string[] = [];
    const params: any[] = [];
    if (opts.channel) { where.push(`COALESCE(channel, 'unknown') = ?`); params.push(opts.channel); }
    if (opts.agent)   { where.push(`COALESCE(agent, 'unknown') = ?`);   params.push(opts.agent); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (this.db.prepare(`SELECT COUNT(*) as n FROM usage_history ${whereSql}`).get(...params) as any).n as number;
    const rows = this.db.prepare(`
      SELECT id, timestamp, user_input, model, input_tokens, output_tokens, cost_usd, thread_id, COALESCE(channel, 'unknown') as channel, COALESCE(agent, 'unknown') as agent
      FROM usage_history
      ${whereSql}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as UsageRecord[];

    return { rows, total, page, pageSize };
  }

  /** Valores distintos de canal y agente presentes en el historial, para los filtros de la GUI. */
  public getUsageFacets(): { channels: string[]; agents: string[] } {
    const channels = (this.db.prepare(`SELECT DISTINCT COALESCE(channel, 'unknown') as v FROM usage_history ORDER BY v`).all() as any[]).map((r) => r.v);
    const agents   = (this.db.prepare(`SELECT DISTINCT COALESCE(agent, 'unknown') as v FROM usage_history ORDER BY v`).all() as any[]).map((r) => r.v);
    return { channels, agents };
  }

  public getUsageByModel(monthStartIso: string): Array<{ model: string; count: number; input_tokens: number; output_tokens: number; total_cost: number }> {
    const stmt = this.db.prepare(`
      SELECT 
        model,
        COUNT(*) as count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cost_usd), 0.0) as total_cost
      FROM usage_history
      WHERE timestamp >= ?
      GROUP BY model
      ORDER BY total_cost DESC
    `);
    return stmt.all(monthStartIso) as any[];
  }

  // ─── Tokens A2A ────────────────────────────────────────────────────────────

  public listA2ATokens(): Array<{ name: string; token: string; tools: string[]; enabled: boolean; created_at: number; last_used_at?: number }> {
    const rows = this.db.prepare(`SELECT * FROM a2a_tokens ORDER BY created_at DESC`).all() as any[];
    return rows.map((r) => ({
      name: r.name,
      token: r.token,
      tools: JSON.parse(r.tools || '[]'),
      enabled: !!r.enabled,
      created_at: r.created_at,
      last_used_at: r.last_used_at || undefined,
    }));
  }

  public createA2AToken(name: string, token: string, tools: string[]): void {
    this.db.prepare(`INSERT INTO a2a_tokens (name, token, tools, enabled, created_at) VALUES (?, ?, ?, 1, ?)`)
      .run(name, token, JSON.stringify(tools || []), Date.now());
  }

  public updateA2AToken(name: string, changes: { tools?: string[]; enabled?: boolean }): boolean {
    const current = this.db.prepare(`SELECT * FROM a2a_tokens WHERE name = ?`).get(name) as any;
    if (!current) return false;
    const tools = changes.tools !== undefined ? JSON.stringify(changes.tools) : current.tools;
    const enabled = changes.enabled !== undefined ? (changes.enabled ? 1 : 0) : current.enabled;
    this.db.prepare(`UPDATE a2a_tokens SET tools = ?, enabled = ? WHERE name = ?`).run(tools, enabled, name);
    return true;
  }

  public deleteA2AToken(name: string): boolean {
    const res = this.db.prepare(`DELETE FROM a2a_tokens WHERE name = ?`).run(name) as any;
    return (res?.changes ?? 0) > 0;
  }

  public findA2ATokenByValue(token: string): { name: string; tools: string[] } | null {
    const row = this.db.prepare(`SELECT * FROM a2a_tokens WHERE token = ? AND enabled = 1`).get(token) as any;
    if (!row) return null;
    this.db.prepare(`UPDATE a2a_tokens SET last_used_at = ? WHERE name = ?`).run(Date.now(), row.name);
    return { name: row.name, tools: JSON.parse(row.tools || '[]') };
  }

  // ─── Tareas programadas ────────────────────────────────────────────────────

  private migrateScheduledTasks(): void {
    try {
      const cols = (this.db.prepare(`PRAGMA table_info(scheduled_tasks)`).all() as any[]).map((c) => c.name);
      if (!cols.includes('channel')) this.db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram'`);
      if (!cols.includes('target'))  this.db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN target TEXT`);
    } catch (err: any) {
      console.warn('⚠️ [SQLite] No se pudo migrar scheduled_tasks:', err.message);
    }
  }

  public listScheduledTasks(): ScheduledTask[] {
    return this.db.prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`).all() as ScheduledTask[];
  }

  public getScheduledTask(id: string): ScheduledTask | null {
    return (this.db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as ScheduledTask) || null;
  }

  public createScheduledTask(t: Omit<ScheduledTask, 'created_at' | 'updated_at' | 'last_run_at'>): ScheduledTask {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO scheduled_tasks (id, message, autonomous, kind, run_at, interval_minutes, time_of_day, cron_expr, status, channel, target, created_at, updated_at, last_run_at, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(t.id, t.message, t.autonomous ? 1 : 0, t.kind, t.run_at ?? null, t.interval_minutes ?? null, t.time_of_day ?? null, t.cron_expr ?? null, t.status, t.channel || 'telegram', t.target ?? null, now, now, t.next_run_at ?? null);
    return this.getScheduledTask(t.id)!;
  }

  public updateScheduledTask(id: string, cambios: Partial<Omit<ScheduledTask, 'id' | 'created_at'>>): ScheduledTask | null {
    const actual = this.getScheduledTask(id);
    if (!actual) return null;
    const n = { ...actual, ...cambios, updated_at: Date.now() };
    this.db.prepare(`
      UPDATE scheduled_tasks SET message = ?, autonomous = ?, kind = ?, run_at = ?, interval_minutes = ?, time_of_day = ?, cron_expr = ?,
        status = ?, channel = ?, target = ?, updated_at = ?, last_run_at = ?, next_run_at = ?
      WHERE id = ?
    `).run(n.message, n.autonomous ? 1 : 0, n.kind, n.run_at ?? null, n.interval_minutes ?? null, n.time_of_day ?? null, n.cron_expr ?? null,
      n.status, n.channel || 'telegram', n.target ?? null, n.updated_at, n.last_run_at ?? null, n.next_run_at ?? null, id);
    return this.getScheduledTask(id);
  }

  public deleteScheduledTask(id: string): boolean {
    this.db.prepare(`DELETE FROM scheduled_task_runs WHERE task_id = ?`).run(id);
    const res = this.db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id) as any;
    return (res?.changes ?? 0) > 0;
  }

  public addScheduledTaskRun(r: Omit<ScheduledTaskRun, 'id'>): void {
    this.db.prepare(`INSERT INTO scheduled_task_runs (task_id, started_at, duration_ms, status, trigger, result) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.task_id, r.started_at, r.duration_ms, r.status, r.trigger, r.result ?? '');
    // Se conservan las últimas 50 por tarea
    this.db.prepare(`
      DELETE FROM scheduled_task_runs WHERE task_id = ? AND id NOT IN (
        SELECT id FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 50
      )
    `).run(r.task_id, r.task_id);
  }

  public listScheduledTaskRuns(taskId: string, limit: number = 20): ScheduledTaskRun[] {
    return this.db.prepare(`SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`).all(taskId, limit) as ScheduledTaskRun[];
  }

  /**
   * Los recordatorios sueltos de la tabla vieja pasan a ser tareas de una vez.
   * Se marcan como migrados para no volver a importarlos.
   */
  public migrateRemindersToTasks(): number {
    const pendientes = this.db.prepare(`SELECT * FROM reminders WHERE status = 'pending'`).all() as any[];
    let n = 0;
    for (const r of pendientes) {
      if (!this.getScheduledTask(r.id)) {
        this.createScheduledTask({
          id: r.id, message: r.message, autonomous: 0, kind: 'once',
          run_at: r.target_time, interval_minutes: null, time_of_day: null, cron_expr: null,
          status: 'active', channel: 'telegram', target: null, next_run_at: r.target_time,
        });
        n++;
      }
      this.db.prepare(`UPDATE reminders SET status = 'migrated' WHERE id = ?`).run(r.id);
    }
    return n;
  }

  // ─── Escalamientos (triage_agent) ──────────────────────────────────────────

  public createEscalation(e: {
    id: string; channel: string; requester: string; topic: string; summary: string; urgency: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO escalations (id, created_at, channel, requester, topic, summary, urgency, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente')
    `);
    stmt.run(e.id, Date.now(), e.channel, e.requester, e.topic, e.summary, e.urgency);
  }

  public listEscalations(status?: string, limit: number = 20): any[] {
    const stmt = status
      ? this.db.prepare(`SELECT * FROM escalations WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      : this.db.prepare(`SELECT * FROM escalations ORDER BY created_at DESC LIMIT ?`);
    return (status ? stmt.all(status, limit) : stmt.all(limit)) as any[];
  }

  public countPendingEscalations(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM escalations WHERE status = 'pendiente'`).get() as { cnt: number };
    return row?.cnt ?? 0;
  }

  public resolveEscalation(id: string, resolution: string, status: string = 'resuelto'): boolean {
    const stmt = this.db.prepare(`UPDATE escalations SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?`);
    const res = stmt.run(status, resolution, Date.now(), id) as any;
    return (res?.changes ?? 0) > 0;
  }

  // ─── Estado de sincronización (Drive / Meet) ───────────────────────────────

  /** ¿El archivo externo ya fue sincronizado con esta misma versión (modifiedTime)? */
  public isSynced(source: string, externalId: string, version?: string): boolean {
    const stmt = this.db.prepare(`SELECT version FROM sync_state WHERE source = ? AND external_id = ?`);
    const row = stmt.get(source, externalId) as { version?: string } | undefined;
    if (!row) return false;
    if (!version) return true;
    return row.version === version;
  }

  public markSynced(source: string, externalId: string, version?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO sync_state (source, external_id, version, synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source, external_id) DO UPDATE SET version = excluded.version, synced_at = excluded.synced_at
    `);
    stmt.run(source, externalId, version || '', Date.now());
  }

  // ─── System Config (key-value) ─────────────────────────────────────────────

  public getConfig(key: string, defaultValue: string = ''): string {
    const stmt = this.db.prepare(`SELECT value FROM system_config WHERE key = ?`);
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value ?? defaultValue;
  }

  public setConfig(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmt.run(key, value, Date.now());
  }

  // ─── Memoria Episódica: Hilos Consolidados ───────────────────────────────────

  public isThreadConsolidated(threadId: string): boolean {
    const stmt = this.db.prepare(`SELECT 1 FROM consolidated_threads WHERE thread_id = ?`);
    const row = stmt.get(threadId);
    return !!row;
  }

  public markThreadConsolidated(threadId: string, source: string, title: string, messageCount: number = 0): void {
    const stmt = this.db.prepare(`
      INSERT INTO consolidated_threads (thread_id, source, title, processed_at, message_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET 
        title = excluded.title,
        processed_at = excluded.processed_at,
        message_count = excluded.message_count
    `);
    stmt.run(threadId, source, title, Date.now(), messageCount);
  }

  public getConsolidatedThreads(limit: number = 50): ConsolidatedThread[] {
    const stmt = this.db.prepare(`
      SELECT thread_id, source, title, processed_at, message_count
      FROM consolidated_threads
      ORDER BY processed_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as ConsolidatedThread[];
  }

  public getConsolidatedCount(source?: string): number {
    if (source) {
      const stmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM consolidated_threads WHERE source = ?`);
      const row = stmt.get(source) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } else {
      const stmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM consolidated_threads`);
      const row = stmt.get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    }
  }
}

export const sqliteReminderService = new SqliteReminderService();
