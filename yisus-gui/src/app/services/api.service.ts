import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

// ─── Tipos que devuelve el backend ──────────────────────────────────────────
export interface UsageByModel   { model: string; count: number; input_tokens: number; output_tokens: number; total_cost: number; }
export interface UsageByAgent   { agent: string; model: string; count: number; input_tokens: number; output_tokens: number; total_cost: number; }
export interface UsageByChannel { channel: string; count: number; input_tokens: number; output_tokens: number; total_cost: number; }
export interface BudgetStatus   { channel: string; currentCost: number; budget: number; percentUsed: number; isExceeded: boolean; isNearLimit: boolean; }

export interface UsageRecord {
  id?: number; timestamp: string; user_input: string; model: string;
  input_tokens: number; output_tokens: number; cost_usd: number;
  thread_id: string; channel?: string; agent?: string;
}

export interface UsageHistoryPage {
  rows: UsageRecord[]; total: number; page: number; pageSize: number;
  facets: { channels: string[]; agents: string[] };
}

export interface UsageSummary {
  allHistory: UsageRecord[];
  totalCost: number; totalTokens: number; inputTokens: number; outputTokens: number;
  monthlyBudget: number; percentUsed: number; isExceeded: boolean;
  byModel: UsageByModel[]; byAgent: UsageByAgent[]; byChannel: UsageByChannel[];
  channelBudgets: BudgetStatus[];
}

export interface ChannelsConfig {
  catalogo: string[];
  grupos: Record<string, string[]>;
  canales: {
    telegram: string[]; buzz: string[]; api: string[];
    a2a: { defaultTools: string[]; tokens: { name: string; configurado: boolean; tools: string[] }[] };
  };
}

export interface ToolDetalle {
  name: string; titulo: string; descripcion: string; grupo: string; etiqueta: string;
}

export interface A2AToken {
  name: string; tools: string[]; enabled: boolean;
  created_at: number; last_used_at?: number; preview: string;
}

export interface Escalation {
  id: string; created_at: number; channel: string; requester: string;
  topic: string; summary: string; urgency: string; status: string;
  resolved_at?: number; resolution?: string;
}

export interface Reminder { id: string; target_time: number; message: string; status: string; created_at: number; }

export type TaskKind = 'once' | 'interval' | 'daily' | 'cron';
export type TaskChannel = 'telegram' | 'chat' | 'buzz' | 'email';
export interface ScheduledTask {
  id: string; message: string; autonomous: number; kind: TaskKind;
  run_at: number | null; interval_minutes: number | null; time_of_day: string | null; cron_expr: string | null;
  status: 'active' | 'paused' | 'done'; channel: TaskChannel; target: string | null;
  created_at: number; updated_at: number;
  last_run_at: number | null; next_run_at: number | null; descripcion: string;
}
export interface TaskDestinos { chat: { name: string; displayName: string }[]; buzz: string[]; email: string | null; errores: string[]; }
export interface TaskRun {
  id: number; task_id: string; started_at: number; duration_ms: number;
  status: 'success' | 'error'; trigger: 'scheduled' | 'manual'; result: string;
}
export type TaskInput = {
  message: string; autonomous: boolean; kind: TaskKind;
  run_at?: string | number | null; interval_minutes?: number | null; time_of_day?: string | null; cron_expr?: string | null;
  channel?: TaskChannel; target?: string | null;
};

export interface CustomWebhook {
  id: string; titulo: string; instrucciones: string; modelo: string;
  paused: number; created_at?: number; updated_at?: number; url?: string;
}

export interface CustomWebhookLog {
  id: number; webhook_id: string; payload: string; response: string;
  status: string; created_at: number; webhook_titulo?: string | null;
}

export interface WebhookModel { id: string; label: string; provider: 'ollama' | 'gemini'; }

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  /** Base del backend. Configurable desde Ajustes; por defecto el mismo host en :4000 */
  get baseUrl(): string {
    return localStorage.getItem('yisus_api_url') || `${window.location.protocol}//${window.location.hostname}:4000`;
  }
  setBaseUrl(url: string) { localStorage.setItem('yisus_api_url', url.replace(/\/$/, '')); }

  // ─── Estado ───────────────────────────────────────────────────────────

  /** Público: responde aunque falte la clave. Sirve para saber si el backend está vivo. */
  getStatus(): Observable<{ status: string; protegido: boolean; agente: string }> {
    return this.http.get<any>(`${this.baseUrl}/api/status`);
  }

  /** Protegido: falla con 401 si la clave cargada no sirve. */
  validarClave(): Observable<{ autenticado: boolean; agente: string }> {
    return this.http.get<any>(`${this.baseUrl}/api/admin/me`);
  }

  // ─── Consumo ──────────────────────────────────────────────────────────
  getUsage(limit = 200): Observable<UsageSummary> {
    return this.http.get<UsageSummary>(`${this.baseUrl}/api/usage?limit=${limit}`);
  }

  /** Historial paginado con filtros; el servidor pagina, la GUI no trae de más. */
  getUsageHistory(opts: { page: number; pageSize: number; channel?: string; agent?: string }): Observable<UsageHistoryPage> {
    const q = new URLSearchParams({ page: String(opts.page), pageSize: String(opts.pageSize) });
    if (opts.channel) q.set('channel', opts.channel);
    if (opts.agent) q.set('agent', opts.agent);
    return this.http.get<UsageHistoryPage>(`${this.baseUrl}/api/usage/history?${q.toString()}`);
  }
  getBudgets(): Observable<{ global: BudgetStatus; canales: BudgetStatus[] }> {
    return this.http.get<any>(`${this.baseUrl}/api/budgets`);
  }
  setBudget(budgetUsd: number, channel?: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/api/usage/budget`, channel ? { budgetUsd, channel } : { budgetUsd });
  }
  refreshPricing(): Observable<any> {
    return this.http.post(`${this.baseUrl}/api/usage/refresh-pricing`, {});
  }

  // ─── Canales y herramientas ───────────────────────────────────────────
  getChannels(): Observable<ChannelsConfig> {
    return this.http.get<ChannelsConfig>(`${this.baseUrl}/api/channels`);
  }
  saveChannelTools(channel: string, tools: string[]): Observable<any> {
    return this.http.put(`${this.baseUrl}/api/channels/${channel}`, { tools });
  }
  reloadChannels(): Observable<any> {
    return this.http.post(`${this.baseUrl}/api/channels/reload`, {});
  }

  // ─── Tokens A2A ───────────────────────────────────────────────────────
  /** Techo del canal A2A: qué se monta en el agente público y se publica como skill */
  getDisponiblesA2A(): Observable<{ disponibles: string[]; catalogo: string[]; detalle: ToolDetalle[] }> {
    return this.http.get<{ disponibles: string[]; catalogo: string[]; detalle: ToolDetalle[] }>(`${this.baseUrl}/api/a2a/disponibles`);
  }
  saveDisponiblesA2A(tools: string[]): Observable<any> {
    return this.http.put(`${this.baseUrl}/api/a2a/disponibles`, { tools });
  }

  getTokens(): Observable<{ tokens: A2AToken[] }> {
    return this.http.get<any>(`${this.baseUrl}/api/a2a/tokens`);
  }
  createToken(name: string, tools: string[]): Observable<{ name: string; token: string; tools: string[] }> {
    return this.http.post<any>(`${this.baseUrl}/api/a2a/tokens`, { name, tools });
  }
  updateToken(name: string, changes: { tools?: string[]; enabled?: boolean }): Observable<any> {
    return this.http.patch(`${this.baseUrl}/api/a2a/tokens/${encodeURIComponent(name)}`, changes);
  }
  deleteToken(name: string): Observable<any> {
    return this.http.delete(`${this.baseUrl}/api/a2a/tokens/${encodeURIComponent(name)}`);
  }

  // ─── Escalamientos ────────────────────────────────────────────────────
  getEscalations(status = 'pendiente'): Observable<{ escalations: Escalation[] }> {
    return this.http.get<any>(`${this.baseUrl}/api/escalations?status=${status}`);
  }
  resolveEscalation(id: string, resolution: string, status = 'resuelto'): Observable<any> {
    return this.http.post(`${this.baseUrl}/api/escalations/${id}/resolve`, { resolution, status });
  }

  // ─── Recordatorios ────────────────────────────────────────────────────
  getReminders(): Observable<{ reminders: Reminder[] }> {
    return this.http.get<any>(`${this.baseUrl}/api/reminders`);
  }

  // ─── Tareas programadas ───────────────────────────────────────────────
  getTasks(): Observable<{ tasks: ScheduledTask[] }> { return this.http.get<any>(`${this.baseUrl}/api/tasks`); }
  createTask(data: TaskInput): Observable<{ task: ScheduledTask }> { return this.http.post<any>(`${this.baseUrl}/api/tasks`, data); }
  updateTask(id: string, data: Partial<TaskInput & { status: 'active' | 'paused' }>): Observable<{ task: ScheduledTask }> {
    return this.http.put<any>(`${this.baseUrl}/api/tasks/${id}`, data);
  }
  deleteTask(id: string): Observable<any> { return this.http.delete(`${this.baseUrl}/api/tasks/${id}`); }
  runTask(id: string): Observable<{ run: TaskRun }> { return this.http.post<any>(`${this.baseUrl}/api/tasks/${id}/run`, {}); }
  getTaskDestinos(): Observable<TaskDestinos> { return this.http.get<any>(`${this.baseUrl}/api/tasks/destinos`); }
  getTaskRuns(id: string, limit = 20): Observable<{ runs: TaskRun[] }> { return this.http.get<any>(`${this.baseUrl}/api/tasks/${id}/runs?limit=${limit}`); }

  // ─── Webhooks con IA ──────────────────────────────────────────────────
  getWebhooks(): Observable<{ webhooks: CustomWebhook[] }> { return this.http.get<any>(`${this.baseUrl}/api/webhooks`); }
  createWebhook(data: { titulo: string; instrucciones: string; modelo: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}/api/webhooks`, data);
  }
  updateWebhook(id: string, fields: Partial<{ titulo: string; instrucciones: string; modelo: string; paused: number }>): Observable<any> {
    return this.http.put(`${this.baseUrl}/api/webhooks/${id}`, fields);
  }
  deleteWebhook(id: string): Observable<any> { return this.http.delete(`${this.baseUrl}/api/webhooks/${id}`); }
  getWebhookLogs(id: string, limit = 30): Observable<{ logs: CustomWebhookLog[] }> {
    return this.http.get<any>(`${this.baseUrl}/api/webhooks/${id}/logs?limit=${limit}`);
  }
  getAllWebhookLogs(limit = 50): Observable<{ logs: CustomWebhookLog[] }> {
    return this.http.get<any>(`${this.baseUrl}/api/webhooks/logs?limit=${limit}`);
  }
  deleteWebhookLog(webhookId: string, logId: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/api/webhooks/${webhookId}/logs/${logId}`);
  }
  getWebhookModels(): Observable<{ models: WebhookModel[] }> { return this.http.get<any>(`${this.baseUrl}/api/webhooks/models`); }
}
