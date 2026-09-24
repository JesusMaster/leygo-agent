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

export interface A2APeer {
  name: string;
  card_url: string;
  token: string | null;
  /** Nombre del token entrante con el que ese agente nos escribe, para reconocerlo (escalamientos). */
  token_name: string | null;
  enabled: boolean;
  last_context_id: string | null;
  created_at: number;
  last_used_at: number | null;
  last_error: string | null;
}

export type ScheduledTaskKind = 'once' | 'interval' | 'daily' | 'cron';
export type ScheduledTaskStatus = 'active' | 'paused' | 'done';
export type ScheduledTaskChannel = 'telegram' | 'chat' | 'buzz' | 'email' | 'a2a';
/** Un destino de entrega. target: espacio de Chat, correo, o canal de Buzz (opcional). */
export interface TaskDelivery { channel: ScheduledTaskChannel; target?: string | null; }

export interface ScheduledTask {
  id: string;
  message: string;
  autonomous: number;          // 0 = recordatorio simple, 1 = el agente ejecuta la instrucción, 2 = rutina integrada (message = clave)
  kind: ScheduledTaskKind;
  run_at: number | null;       // once
  interval_minutes: number | null;
  time_of_day: string | null;  // daily, "HH:MM"
  cron_expr: string | null;
  status: ScheduledTaskStatus;
  channel: ScheduledTaskChannel;   // primer destino (compatibilidad); la lista completa está en delivery
  target: string | null;
  delivery: TaskDelivery[];        // uno o más destinos: el resultado se entrega por todos
  model: string | null;            // "<proveedor>/<modelo>" para tareas del agente; null = el del Coordinator
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
  cached_tokens?: number;
  thoughts_tokens?: number;
  /** llamadas al modelo dentro del turno (cada vuelta del loop de herramientas reenvía el contexto) */
  calls?: number;
  /** override | catalogo | local | familia | default (los dos últimos: costo aproximado) */
  price_source?: string;
  /** JSON: herramientas invocadas en el turno, en orden ("agente→tool") */
  steps?: string | null;
  /** imágenes generadas (modelos de imagen: se cobran por unidad) */
  images?: number;
}

export type CommitmentStatus = 'propuesto' | 'pendiente' | 'en_curso' | 'hecho' | 'cancelado' | 'descartado';
export interface Commitment {
  id: string;
  title: string;
  detail: string | null;
  owner: string;             // responsable (nombre)
  mine: number;              // 1 = lo debe Jesús, 0 = se lo deben a Jesús (seguimiento)
  counterpart: string | null;
  due_date: string | null;       // YYYY-MM-DD comprometida
  proposed_due: string | null;   // sugerida por el agente, pendiente de visto bueno
  status: CommitmentStatus;
  priority: 'alta' | 'media' | 'baja';
  source_type: string | null;    // google_chat | gmail | meet | manual | backfill
  source_ref: string | null;
  source_title: string | null;
  source_link: string | null;
  fingerprint: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  last_notified_at: number | null;
  reminder_auto: number;                 // 1 = friendly reminder automático (1 día antes y cada día vencido)
  reminder_delivery: string | null;      // JSON TaskDelivery[] para el reminder
  last_reminded_at: number | null;
}
export interface CommitmentUpdate { id: number; commitment_id: string; at: number; kind: string; text: string; by: string; }

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
        resolution TEXT,
        thread_id TEXT,
        delivered_at INTEGER,
        delivery_note TEXT,
        a2a_token TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status, created_at DESC);
    `);

    // 9b. Compromisos (lista viva de acuerdos, con estado y feedback)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        detail TEXT,
        owner TEXT NOT NULL DEFAULT 'Jesús',
        mine INTEGER NOT NULL DEFAULT 1,
        counterpart TEXT,
        due_date TEXT,
        proposed_due TEXT,
        status TEXT NOT NULL DEFAULT 'propuesto',
        priority TEXT NOT NULL DEFAULT 'media',
        source_type TEXT,
        source_ref TEXT,
        source_title TEXT,
        source_link TEXT,
        fingerprint TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        last_notified_at INTEGER,
        reminder_auto INTEGER NOT NULL DEFAULT 0,
        reminder_delivery TEXT,
        last_reminded_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status, due_date);
      CREATE INDEX IF NOT EXISTS idx_commitments_fp ON commitments(fingerprint);
      CREATE TABLE IF NOT EXISTS commitment_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        commitment_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        by TEXT NOT NULL DEFAULT 'jesus'
      );
      CREATE INDEX IF NOT EXISTS idx_commitment_updates ON commitment_updates(commitment_id, at DESC);
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

    // Sesiones de la GUI (solo el hash del token)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gui_sessions (
        token_hash TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        user_agent TEXT
      );
    `);

    // Agentes A2A remotos a los que Yisus puede escribir (lado cliente)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS a2a_peers (
        name TEXT PRIMARY KEY,
        card_url TEXT NOT NULL,
        token TEXT,
        token_name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_context_id TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        last_error TEXT
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
        delivery TEXT,
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
    this.migrateEscalations();
    this.migrateCommitments();
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
      if (!existing.has('cached_tokens'))   this.db.exec(`ALTER TABLE usage_history ADD COLUMN cached_tokens INTEGER DEFAULT 0`);
      if (!existing.has('thoughts_tokens')) this.db.exec(`ALTER TABLE usage_history ADD COLUMN thoughts_tokens INTEGER DEFAULT 0`);
      if (!existing.has('price_source'))    this.db.exec(`ALTER TABLE usage_history ADD COLUMN price_source TEXT`);
      if (!existing.has('calls'))           this.db.exec(`ALTER TABLE usage_history ADD COLUMN calls INTEGER DEFAULT 1`);
      if (!existing.has('steps'))           this.db.exec(`ALTER TABLE usage_history ADD COLUMN steps TEXT`);
      if (!existing.has('images'))          this.db.exec(`ALTER TABLE usage_history ADD COLUMN images INTEGER DEFAULT 0`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_channel ON usage_history(channel)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_history(agent)`);
    } catch (err: any) {
      console.warn('⚠️ [SQLite] No se pudo migrar usage_history:', err.message);
    }
  }

  public logTokenUsage(record: Omit<UsageRecord, 'id'>): UsageRecord {
    const stmt = this.db.prepare(`
      INSERT INTO usage_history (timestamp, user_input, model, input_tokens, output_tokens, cost_usd, thread_id, channel, agent, cached_tokens, thoughts_tokens, price_source, calls, steps, images)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.agent || 'unknown',
      record.cached_tokens || 0,
      record.thoughts_tokens || 0,
      record.price_source || null,
      record.calls || 1,
      record.steps || null,
      record.images || 0
    );
    return record;
  }

  /** Filas de consumo desde una fecha (para retarifar con los precios vigentes). */
  public listUsageSince(sinceIso: string): Array<{ id: number; model: string; input_tokens: number; output_tokens: number; cached_tokens: number; images: number; cost_usd: number }> {
    return this.db.prepare(`SELECT id, model, input_tokens, output_tokens, COALESCE(cached_tokens, 0) as cached_tokens, COALESCE(images, 0) as images, cost_usd FROM usage_history WHERE timestamp >= ?`).all(sinceIso) as any[];
  }

  public updateUsageCost(id: number, costUsd: number, priceSource: string): void {
    this.db.prepare(`UPDATE usage_history SET cost_usd = ?, price_source = ? WHERE id = ?`).run(costUsd, priceSource, id);
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

  public getUsageByModel(monthStartIso: string): Array<{ model: string; count: number; input_tokens: number; output_tokens: number; cached_tokens: number; total_cost: number; aproximados: number }> {
    const stmt = this.db.prepare(`
      SELECT 
        model,
        COUNT(*) as count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cached_tokens), 0) as cached_tokens,
        COALESCE(SUM(cost_usd), 0.0) as total_cost,
        COALESCE(SUM(CASE WHEN price_source IN ('familia', 'default') OR price_source IS NULL THEN 1 ELSE 0 END), 0) as aproximados
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

  // ─── Sesiones de la GUI ─────────────────────────────────────────────────────

  public createGuiSession(tokenHash: string, user: string, expiresAt: number, userAgent: string): void {
    this.db.prepare(`INSERT INTO gui_sessions (token_hash, user, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(tokenHash, user, Date.now(), expiresAt, Date.now(), (userAgent || '').slice(0, 200));
    this.db.prepare(`DELETE FROM gui_sessions WHERE expires_at < ?`).run(Date.now());
  }
  public getGuiSession(tokenHash: string): { user: string; expires_at: number } | null {
    return (this.db.prepare(`SELECT user, expires_at FROM gui_sessions WHERE token_hash = ?`).get(tokenHash) as any) || null;
  }
  public touchGuiSession(tokenHash: string, expiresAt: number): void {
    this.db.prepare(`UPDATE gui_sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?`).run(expiresAt, Date.now(), tokenHash);
  }
  public deleteGuiSession(tokenHash: string): void {
    this.db.prepare(`DELETE FROM gui_sessions WHERE token_hash = ?`).run(tokenHash);
  }

  // ─── Agentes A2A remotos (peers) ───────────────────────────────────────────

  public listA2APeers(): A2APeer[] {
    return (this.db.prepare(`SELECT * FROM a2a_peers ORDER BY created_at ASC`).all() as any[]).map((r) => ({ ...r, enabled: !!r.enabled }));
  }

  public getA2APeer(name: string): A2APeer | null {
    const r = this.db.prepare(`SELECT * FROM a2a_peers WHERE name = ?`).get(name) as any;
    return r ? { ...r, enabled: !!r.enabled } : null;
  }

  public createA2APeer(p: { name: string; card_url: string; token?: string | null; token_name?: string | null }): void {
    this.db.prepare(`INSERT INTO a2a_peers (name, card_url, token, token_name, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
      .run(p.name, p.card_url, p.token ?? null, p.token_name ?? null, Date.now());
  }

  public updateA2APeer(name: string, cambios: Partial<{ card_url: string; token: string | null; token_name: string | null; enabled: boolean; last_context_id: string | null; last_used_at: number; last_error: string | null }>): boolean {
    const actual = this.getA2APeer(name);
    if (!actual) return false;
    const n: any = { ...actual, ...cambios };
    this.db.prepare(`UPDATE a2a_peers SET card_url = ?, token = ?, token_name = ?, enabled = ?, last_context_id = ?, last_used_at = ?, last_error = ? WHERE name = ?`)
      .run(n.card_url, n.token ?? null, n.token_name ?? null, n.enabled ? 1 : 0, n.last_context_id ?? null, n.last_used_at ?? null, n.last_error ?? null, name);
    return true;
  }

  public deleteA2APeer(name: string): boolean {
    const res = this.db.prepare(`DELETE FROM a2a_peers WHERE name = ?`).run(name) as any;
    return (res?.changes ?? 0) > 0;
  }

  // ─── Tareas programadas ────────────────────────────────────────────────────

  private migrateScheduledTasks(): void {
    try {
      const cols = (this.db.prepare(`PRAGMA table_info(scheduled_tasks)`).all() as any[]).map((c) => c.name);
      if (!cols.includes('channel')) this.db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram'`);
      if (!cols.includes('target'))  this.db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN target TEXT`);
      if (!cols.includes('delivery')) this.db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN delivery TEXT`);
      if (!cols.includes('model'))    this.db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN model TEXT`);
    } catch (err: any) {
      console.warn('⚠️ [SQLite] No se pudo migrar scheduled_tasks:', err.message);
    }
  }

  private hidratarTarea(row: any): ScheduledTask {
    let delivery: TaskDelivery[] = [];
    try { delivery = row.delivery ? JSON.parse(row.delivery) : []; } catch { delivery = []; }
    if (!delivery.length) delivery = [{ channel: row.channel || 'telegram', target: row.target || null }];
    return { ...row, delivery, model: row.model ?? null };
  }

  public listScheduledTasks(): ScheduledTask[] {
    return (this.db.prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`).all() as any[]).map((r) => this.hidratarTarea(r));
  }

  public getScheduledTask(id: string): ScheduledTask | null {
    const row = this.db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as any;
    return row ? this.hidratarTarea(row) : null;
  }

  public createScheduledTask(t: Omit<ScheduledTask, 'created_at' | 'updated_at' | 'last_run_at'>): ScheduledTask {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO scheduled_tasks (id, message, autonomous, kind, run_at, interval_minutes, time_of_day, cron_expr, status, channel, target, delivery, model, created_at, updated_at, last_run_at, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(t.id, t.message, Number(t.autonomous) || 0, t.kind, t.run_at ?? null, t.interval_minutes ?? null, t.time_of_day ?? null, t.cron_expr ?? null, t.status,
      t.delivery?.[0]?.channel || t.channel || 'telegram', t.delivery?.[0]?.target ?? t.target ?? null, JSON.stringify(t.delivery || []), t.model ?? null, now, now, t.next_run_at ?? null);
    return this.getScheduledTask(t.id)!;
  }

  public updateScheduledTask(id: string, cambios: Partial<Omit<ScheduledTask, 'id' | 'created_at'>>): ScheduledTask | null {
    const actual = this.getScheduledTask(id);
    if (!actual) return null;
    const n = { ...actual, ...cambios, updated_at: Date.now() };
    this.db.prepare(`
      UPDATE scheduled_tasks SET message = ?, autonomous = ?, kind = ?, run_at = ?, interval_minutes = ?, time_of_day = ?, cron_expr = ?,
        status = ?, channel = ?, target = ?, delivery = ?, model = ?, updated_at = ?, last_run_at = ?, next_run_at = ?
      WHERE id = ?
    `).run(n.message, Number(n.autonomous) || 0, n.kind, n.run_at ?? null, n.interval_minutes ?? null, n.time_of_day ?? null, n.cron_expr ?? null,
      n.status, n.delivery?.[0]?.channel || n.channel || 'telegram', n.delivery?.[0]?.target ?? n.target ?? null, JSON.stringify(n.delivery || []), n.model ?? null,
      n.updated_at, n.last_run_at ?? null, n.next_run_at ?? null, id);
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
          status: 'active', channel: 'telegram', target: null, delivery: [{ channel: 'telegram' }], model: null, next_run_at: r.target_time,
        });
        n++;
      }
      this.db.prepare(`UPDATE reminders SET status = 'migrated' WHERE id = ?`).run(r.id);
    }
    return n;
  }

  // ─── Escalamientos (triage_agent) ──────────────────────────────────────────

  private migrateCommitments(): void {
    try {
      const cols = (this.db.prepare(`PRAGMA table_info(commitments)`).all() as any[]).map((c) => c.name);
      if (!cols.includes('reminder_auto'))     this.db.exec(`ALTER TABLE commitments ADD COLUMN reminder_auto INTEGER NOT NULL DEFAULT 0`);
      if (!cols.includes('reminder_delivery')) this.db.exec(`ALTER TABLE commitments ADD COLUMN reminder_delivery TEXT`);
      if (!cols.includes('last_reminded_at'))  this.db.exec(`ALTER TABLE commitments ADD COLUMN last_reminded_at INTEGER`);
    } catch (err: any) {
      console.warn('⚠️ [SQLite] No se pudo migrar commitments:', err.message);
    }
  }

  private migrateEscalations(): void {
    try {
      const cols = (this.db.prepare(`PRAGMA table_info(escalations)`).all() as any[]).map((c) => c.name);
      if (!cols.includes('thread_id'))     this.db.exec(`ALTER TABLE escalations ADD COLUMN thread_id TEXT`);
      if (!cols.includes('delivered_at'))  this.db.exec(`ALTER TABLE escalations ADD COLUMN delivered_at INTEGER`);
      if (!cols.includes('delivery_note')) this.db.exec(`ALTER TABLE escalations ADD COLUMN delivery_note TEXT`);
      if (!cols.includes('a2a_token'))     this.db.exec(`ALTER TABLE escalations ADD COLUMN a2a_token TEXT`);
      // El índice va DESPUÉS de garantizar la columna: en una base existente, crearlo en el
      // bloque inicial rompía el arranque con "no such column: thread_id".
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_escalations_thread ON escalations(thread_id)`);
    } catch (err: any) {
      console.warn('⚠️ [SQLite] No se pudo migrar escalations:', err.message);
    }
  }

  public createEscalation(e: {
    id: string; channel: string; requester: string; topic: string; summary: string; urgency: string; thread_id?: string | null; a2a_token?: string | null;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO escalations (id, created_at, channel, requester, topic, summary, urgency, status, thread_id, a2a_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)
    `);
    stmt.run(e.id, Date.now(), e.channel, e.requester, e.topic, e.summary, e.urgency, e.thread_id ?? null, e.a2a_token ?? null);
  }

  public getEscalation(id: string): any | null {
    return (this.db.prepare(`SELECT * FROM escalations WHERE id = ?`).get(id) as any) || null;
  }

  /** Resueltos que todavía no se le comunicaron a quien preguntó en esa conversación. */
  public listResolvedUndelivered(threadId: string): any[] {
    return this.db.prepare(`
      SELECT * FROM escalations
      WHERE thread_id = ? AND status IN ('resuelto', 'descartado') AND delivered_at IS NULL AND resolution IS NOT NULL AND resolution != ''
      ORDER BY resolved_at ASC
    `).all(threadId) as any[];
  }

  public markEscalationDelivered(id: string, note: string): void {
    this.db.prepare(`UPDATE escalations SET delivered_at = ?, delivery_note = ? WHERE id = ?`).run(Date.now(), note, id);
  }

  // ─── Compromisos ─────────────────────────────────────────────────────────

  public createCommitment(c: Omit<Commitment, 'created_at' | 'updated_at' | 'completed_at' | 'last_notified_at' | 'reminder_auto' | 'reminder_delivery' | 'last_reminded_at'>): Commitment {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO commitments (id, title, detail, owner, mine, counterpart, due_date, proposed_due, status, priority, source_type, source_ref, source_title, source_link, fingerprint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c.id, c.title, c.detail ?? null, c.owner, c.mine ? 1 : 0, c.counterpart ?? null, c.due_date ?? null, c.proposed_due ?? null, c.status, c.priority, c.source_type ?? null, c.source_ref ?? null, c.source_title ?? null, c.source_link ?? null, c.fingerprint ?? null, now, now);
    return this.getCommitment(c.id)!;
  }

  public getCommitment(id: string): Commitment | null {
    return (this.db.prepare(`SELECT * FROM commitments WHERE id = ?`).get(id) as Commitment) || null;
  }

  public updateCommitment(id: string, cambios: Partial<Omit<Commitment, 'id' | 'created_at'>>): Commitment | null {
    const actual = this.getCommitment(id);
    if (!actual) return null;
    const n = { ...actual, ...cambios, updated_at: Date.now() };
    this.db.prepare(`
      UPDATE commitments SET title = ?, detail = ?, owner = ?, mine = ?, counterpart = ?, due_date = ?, proposed_due = ?, status = ?, priority = ?,
        source_type = ?, source_ref = ?, source_title = ?, source_link = ?, fingerprint = ?, updated_at = ?, completed_at = ?, last_notified_at = ?,
        reminder_auto = ?, reminder_delivery = ?, last_reminded_at = ?
      WHERE id = ?
    `).run(n.title, n.detail ?? null, n.owner, n.mine ? 1 : 0, n.counterpart ?? null, n.due_date ?? null, n.proposed_due ?? null, n.status, n.priority,
      n.source_type ?? null, n.source_ref ?? null, n.source_title ?? null, n.source_link ?? null, n.fingerprint ?? null, n.updated_at, n.completed_at ?? null, n.last_notified_at ?? null,
      n.reminder_auto ? 1 : 0, n.reminder_delivery ?? null, n.last_reminded_at ?? null, id);
    return this.getCommitment(id);
  }

  public deleteCommitment(id: string): boolean {
    this.db.prepare(`DELETE FROM commitment_updates WHERE commitment_id = ?`).run(id);
    const r = this.db.prepare(`DELETE FROM commitments WHERE id = ?`).run(id) as any;
    return (r?.changes ?? 0) > 0;
  }

  /** Lista con filtros. `abiertos` = propuesto + pendiente + en_curso. */
  public listCommitments(f: { status?: CommitmentStatus[]; mine?: boolean; vencidos?: boolean; sinFecha?: boolean; hasta?: string; q?: string; source_ref?: string; limit?: number } = {}): Commitment[] {
    const where: string[] = [];
    const args: any[] = [];
    if (f.status?.length) { where.push(`status IN (${f.status.map(() => '?').join(',')})`); args.push(...f.status); }
    if (f.mine !== undefined) { where.push(`mine = ?`); args.push(f.mine ? 1 : 0); }
    if (f.vencidos) { where.push(`due_date IS NOT NULL AND due_date < date('now','localtime') AND status IN ('pendiente','en_curso')`); }
    if (f.sinFecha) { where.push(`due_date IS NULL`); }
    if (f.hasta) { where.push(`due_date IS NOT NULL AND due_date <= ?`); args.push(f.hasta); }
    if (f.source_ref) { where.push(`source_ref = ?`); args.push(f.source_ref); }
    if (f.q) { where.push(`(title LIKE ? OR detail LIKE ? OR counterpart LIKE ? OR owner LIKE ?)`); const like = `%${f.q}%`; args.push(like, like, like, like); }
    const sql = `SELECT * FROM commitments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE status WHEN 'en_curso' THEN 0 WHEN 'pendiente' THEN 1 WHEN 'propuesto' THEN 2 ELSE 3 END,
               CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, created_at DESC
      LIMIT ?`;
    args.push(f.limit ?? 200);
    return this.db.prepare(sql).all(...args) as Commitment[];
  }

  public commitmentStats(): Record<string, number> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) as n FROM commitments GROUP BY status`).all() as any[];
    const out: Record<string, number> = { propuesto: 0, pendiente: 0, en_curso: 0, hecho: 0, cancelado: 0, descartado: 0, vencidos: 0 };
    for (const r of rows) out[r.status] = r.n;
    out.vencidos = (this.db.prepare(`SELECT COUNT(*) as n FROM commitments WHERE due_date IS NOT NULL AND due_date < date('now','localtime') AND status IN ('pendiente','en_curso')`).get() as any).n;
    return out;
  }

  public addCommitmentUpdate(u: Omit<CommitmentUpdate, 'id'>): void {
    this.db.prepare(`INSERT INTO commitment_updates (commitment_id, at, kind, text, by) VALUES (?, ?, ?, ?, ?)`).run(u.commitment_id, u.at, u.kind, u.text, u.by);
  }

  public listCommitmentUpdates(commitmentId: string, limit = 50): CommitmentUpdate[] {
    return this.db.prepare(`SELECT * FROM commitment_updates WHERE commitment_id = ? ORDER BY at DESC LIMIT ?`).all(commitmentId, limit) as CommitmentUpdate[];
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
