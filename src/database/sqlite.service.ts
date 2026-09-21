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

    // 11. Migraciones de esquema sobre bases ya existentes
    this.migrateUsageHistory();
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
