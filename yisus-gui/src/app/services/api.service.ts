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

export interface A2APeer {
  name: string; card_url: string; tokenPreview: string | null; token_name: string | null; enabled: boolean;
  last_context_id: string | null; created_at: number; last_used_at: number | null; last_error: string | null;
}

export interface A2AToken {
  name: string; tools: string[]; enabled: boolean;
  created_at: number; last_used_at?: number; preview: string;
}

export interface Escalation {
  id: string; created_at: number; channel: string; requester: string;
  topic: string; summary: string; urgency: string; status: string;
  resolved_at?: number; resolution?: string;
  thread_id?: string | null; delivered_at?: number | null; delivery_note?: string | null;
}

export interface Reminder { id: string; target_time: number; message: string; status: string; created_at: number; }

export type TaskKind = 'once' | 'interval' | 'daily' | 'cron';
export type TaskChannel = 'telegram' | 'chat' | 'buzz' | 'email' | 'a2a';
export interface TaskDelivery { channel: TaskChannel; target?: string | null; }
export interface ScheduledTask {
  id: string; message: string; autonomous: number; kind: TaskKind;
  run_at: number | null; interval_minutes: number | null; time_of_day: string | null; cron_expr: string | null;
  status: 'active' | 'paused' | 'done'; channel: TaskChannel; target: string | null; delivery: TaskDelivery[]; model: string | null;
  created_at: number; updated_at: number;
  last_run_at: number | null; next_run_at: number | null; descripcion: string;
  integrada?: { key: string; titulo: string; descripcion: string };
}
export interface TareaIntegrada { key: string; titulo: string; descripcion: string; }
export interface TaskDestinos { chat: { name: string; displayName: string }[]; buzz: string[]; email: string | null; peers: string[]; errores: string[]; }
export interface TaskRun {
  id: number; task_id: string; started_at: number; duration_ms: number;
  status: 'success' | 'error'; trigger: 'scheduled' | 'manual'; result: string;
}
export type TaskInput = {
  message: string; autonomous: boolean | number; kind: TaskKind;
  run_at?: string | number | null; interval_minutes?: number | null; time_of_day?: string | null; cron_expr?: string | null;
  channel?: TaskChannel; target?: string | null; delivery?: TaskDelivery[]; model?: string | null;
};

export interface CustomWebhook {
  id: string; titulo: string; instrucciones: string; modelo: string;
  paused: number; created_at?: number; updated_at?: number; url?: string;
}

export interface CustomWebhookLog {
  id: number; webhook_id: string; payload: string; response: string;
  status: string; created_at: number; webhook_titulo?: string | null;
}

export interface WebhookProvider { id: string; name: string; kind: string; models: string[]; error?: string; }

// ─── Ajustes: LLM y .env ────────────────────────────────────────────────────
export type ProviderKind = 'gemini' | 'openai' | 'anthropic' | 'ollama' | 'openai_compatible';
export interface ProviderPreset { id: string; name: string; kind: ProviderKind; baseUrl?: string; needsKey: boolean; keysUrl?: string; hint?: string; models?: string[]; }
export interface LlmProvider { id: string; name: string; kind: ProviderKind; baseUrl?: string; enabled: boolean; preset?: string; apiKeyMask: string | null; tieneKey: boolean; createdAt: string; updatedAt: string; }
export interface LlmProviderInput { id?: string; name: string; kind: ProviderKind; baseUrl?: string; apiKey?: string; enabled?: boolean; preset?: string; }
export interface AgenteLlm {
  name: string; titulo: string; descripcion: string; defaultModel: string;
  assignment: { provider: string; model: string } | null;
  efectivo: { provider: string; model: string };
  advertencia: string | null;
}
export interface LlmSettings { presets: ProviderPreset[]; providers: LlmProvider[]; agentes: AgenteLlm[]; }
export type CommitmentStatus = 'propuesto' | 'pendiente' | 'en_curso' | 'hecho' | 'cancelado' | 'descartado';
export interface Commitment {
  id: string; title: string; detail: string | null; owner: string; mine: number; counterpart: string | null;
  due_date: string | null; proposed_due: string | null; status: CommitmentStatus; priority: 'alta' | 'media' | 'baja';
  source_type: string | null; source_ref: string | null; source_title: string | null; source_link: string | null;
  created_at: number; updated_at: number; completed_at: number | null; last_notified_at: number | null; score?: number;
}
export interface CommitmentUpdate { id: number; commitment_id: string; at: number; kind: string; text: string; by: string; }
export interface CommitmentsPage { hoy: string; items: Commitment[]; stats: Record<string, number>; }
export interface BackfillEstado { corriendo: boolean; iniciado: number | null; terminado: number | null; puntos: number; procesados: number; saltados: number; nuevos: number; repetidos: number; error: string | null; ultimo: string | null; }
export interface EnvVar { key: string; grupo: string; descripcion: string; secreto: boolean; caliente?: boolean; placeholder?: string; valor: string | null; definida: boolean; enArchivo: boolean; }

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

  /** Protegido: devuelve la clave de administración para usar el API directo. */
  getAdminKey(): Observable<{ key: string | null; header: string }> { return this.http.get<any>(`${this.baseUrl}/api/admin/key`); }

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

  // ─── Agentes remotos (Yisus como cliente A2A) ─────────────────────────
  getPeers(): Observable<{ peers: A2APeer[]; tokensEntrantes: string[] }> { return this.http.get<any>(`${this.baseUrl}/api/a2a/peers`); }
  createPeer(data: { name: string; card_url: string; token?: string; token_name?: string }): Observable<any> { return this.http.post(`${this.baseUrl}/api/a2a/peers`, data); }
  updatePeer(name: string, data: Partial<{ card_url: string; token: string; token_name: string | null; enabled: boolean }>): Observable<any> {
    return this.http.patch(`${this.baseUrl}/api/a2a/peers/${encodeURIComponent(name)}`, data);
  }
  deletePeer(name: string): Observable<any> { return this.http.delete(`${this.baseUrl}/api/a2a/peers/${encodeURIComponent(name)}`); }
  testPeer(name: string): Observable<{ ok: boolean; agente?: string; skills?: number; version?: string; url?: string; error?: string }> {
    return this.http.post<any>(`${this.baseUrl}/api/a2a/peers/${encodeURIComponent(name)}/test`, {});
  }
  sendToPeer(name: string, text: string, newConversation = false): Observable<{ texto: string; contextId: string | null }> {
    return this.http.post<any>(`${this.baseUrl}/api/a2a/peers/${encodeURIComponent(name)}/send`, { text, newConversation });
  }

  // ─── Tareas programadas ───────────────────────────────────────────────
  getTasks(): Observable<{ tasks: ScheduledTask[]; integradas?: TareaIntegrada[] }> { return this.http.get<any>(`${this.baseUrl}/api/tasks`); }
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
  getWebhookModels(): Observable<{ providers: WebhookProvider[] }> { return this.http.get<any>(`${this.baseUrl}/api/webhooks/models`); }

  // ─── Ajustes ──────────────────────────────────────────────────────────────
  getLlmSettings(): Observable<LlmSettings> { return this.http.get<any>(`${this.baseUrl}/api/settings/llm`); }
  saveLlmProvider(data: LlmProviderInput): Observable<{ provider: LlmProvider }> {
    return data.id
      ? this.http.put<any>(`${this.baseUrl}/api/settings/llm/providers/${data.id}`, data)
      : this.http.post<any>(`${this.baseUrl}/api/settings/llm/providers`, data);
  }
  deleteLlmProvider(id: string): Observable<any> { return this.http.delete(`${this.baseUrl}/api/settings/llm/providers/${id}`); }
  getLlmModels(providerId: string): Observable<{ models: string[] }> { return this.http.get<any>(`${this.baseUrl}/api/settings/llm/providers/${providerId}/models`); }
  testLlm(providerId: string, model: string): Observable<{ ok: boolean; ms: number; respuesta?: string; error?: string }> {
    return this.http.post<any>(`${this.baseUrl}/api/settings/llm/providers/${providerId}/test`, { model });
  }
  setLlmAssignment(agent: string, a: { provider: string; model: string } | null): Observable<{ agentes: AgenteLlm[] }> {
    return this.http.put<any>(`${this.baseUrl}/api/settings/llm/assignments/${agent}`, a || {});
  }
  // ─── Compromisos ───────────────────────────────────────────────────────────
  getCommitments(params: Record<string, string> = {}): Observable<CommitmentsPage> {
    const qs = new URLSearchParams(params).toString();
    return this.http.get<any>(`${this.baseUrl}/api/commitments${qs ? '?' + qs : ''}`);
  }
  searchCommitments(q: string): Observable<{ items: Commitment[] }> { return this.http.get<any>(`${this.baseUrl}/api/commitments/search?q=${encodeURIComponent(q)}&abiertos=0`); }
  getCommitment(id: string): Observable<{ item: Commitment; updates: CommitmentUpdate[] }> { return this.http.get<any>(`${this.baseUrl}/api/commitments/${id}`); }
  createCommitment(data: Partial<Commitment> & { title: string }): Observable<{ item: Commitment }> { return this.http.post<any>(`${this.baseUrl}/api/commitments`, data); }
  updateCommitment(id: string, data: Partial<Commitment> & { note?: string }): Observable<{ item: Commitment }> { return this.http.put<any>(`${this.baseUrl}/api/commitments/${id}`, data); }
  acceptCommitment(id: string, due_date?: string | null): Observable<{ item: Commitment }> { return this.http.post<any>(`${this.baseUrl}/api/commitments/${id}/accept`, { due_date }); }
  addCommitmentNote(id: string, text: string): Observable<{ updates: CommitmentUpdate[] }> { return this.http.post<any>(`${this.baseUrl}/api/commitments/${id}/notes`, { text }); }
  notifyCommitment(id: string, delivery: TaskDelivery[], message: string): Observable<{ enviados: string[]; fallos: string[]; updates: CommitmentUpdate[] }> { return this.http.post<any>(`${this.baseUrl}/api/commitments/${id}/notify`, { delivery, message }); }
  getCommitmentDefaultMessage(id: string, status?: string): Observable<{ message: string }> { return this.http.get<any>(`${this.baseUrl}/api/commitments/${id}/default-message${status ? '?status=' + status : ''}`); }
  bulkCommitments(ids: string[], status: CommitmentStatus, note?: string): Observable<{ actualizados: number }> { return this.http.post<any>(`${this.baseUrl}/api/commitments/bulk`, { ids, status, note }); }
  deleteCommitment(id: string): Observable<any> { return this.http.delete(`${this.baseUrl}/api/commitments/${id}`); }
  getCommitmentsBackfill(): Observable<BackfillEstado> { return this.http.get<any>(`${this.baseUrl}/api/commitments/backfill`); }
  startCommitmentsBackfill(desde?: string): Observable<BackfillEstado> { return this.http.post<any>(`${this.baseUrl}/api/commitments/backfill`, { desde: desde || undefined }); }
  getLlmCatalogo(): Observable<{ providers: WebhookProvider[] }> { return this.http.get<any>(`${this.baseUrl}/api/settings/llm/catalogo`); }
  getEnv(): Observable<{ ruta: string; vars: EnvVar[] }> { return this.http.get<any>(`${this.baseUrl}/api/settings/env`); }
  saveEnv(cambios: Record<string, string | null>): Observable<{ cambiadas: string[]; requierenReinicio: string[] }> {
    return this.http.put<any>(`${this.baseUrl}/api/settings/env`, { cambios });
  }
  restartBackend(): Observable<{ modo: 'watch' | 'exit' }> { return this.http.post<any>(`${this.baseUrl}/api/settings/restart`, {}); }
}
