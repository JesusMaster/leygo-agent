import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { sqliteReminderService } from '../database/sqlite.service.js';

/**
 * Proveedores de LLM y asignación de modelo por agente.
 *
 * Todo vive en `system_config` (claves `llm.providers` y `llm.assignments`),
 * así que un cambio desde la GUI aplica en la siguiente llamada al modelo sin
 * reiniciar: los agentes usan un `DynamicLlm` que consulta este servicio en cada
 * turno (ver agents/llm/model_factory.ts).
 */

export type ProviderKind = 'gemini' | 'openai' | 'anthropic' | 'ollama' | 'openai_compatible';

export interface LlmProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Base de la API. Para gemini/anthropic es opcional (usa la oficial). */
  baseUrl?: string;
  apiKey?: string;
  enabled: boolean;
  /** Preset del que salió (openai, xai, moonshot…), solo informativo */
  preset?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LlmAssignment { provider: string; model: string; }

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  needsKey: boolean;
  keysUrl?: string;
  hint?: string;
  /** Modelos sugeridos por si el proveedor no expone /models */
  models?: string[];
}

/** Agentes que aceptan un modelo propio (nombre = agentName del usage). */
export const AGENTES_LLM: Array<{ name: string; titulo: string; descripcion: string; defaultModel: string }> = [
  { name: 'Coordinator',        titulo: 'Coordinator',          descripcion: 'Coordinador interno (Telegram, API, Buzz, tareas programadas). Delega en los demás.', defaultModel: 'gemini-3.8-flash' },
  { name: 'knowledge_agent',    titulo: 'Conocimiento',         descripcion: 'Cerebro digital: Obsidian, minutas de Meet y memoria episódica (Qdrant).', defaultModel: 'gemini-3.8-flash' },
  { name: 'faq_agent',          titulo: 'FAQs',                 descripcion: 'Preguntas frecuentes y respuestas cortas. Conviene un modelo barato.', defaultModel: 'gemini-3.5-flash-lite' },
  { name: 'account_agent',      titulo: 'Cuenta Google',        descripcion: 'Gmail, Calendar, Drive y Chat de Jesús. Usa muchas herramientas: necesita buen function calling.', defaultModel: 'gemini-3.8-flash' },
  { name: 'triage_agent',       titulo: 'Triage',               descripcion: 'Decide si algo se escala a Jesús y con qué prioridad.', defaultModel: 'gemini-3.8-flash' },
  { name: 'public_coordinator', titulo: 'Coordinator público',  descripcion: 'Coordinador para el canal público (webhooks/Buzz sin sesión).', defaultModel: 'gemini-3.8-flash' },
  { name: 'knowledge_public',   titulo: 'Conocimiento público', descripcion: 'Versión acotada del conocimiento para el canal público.', defaultModel: 'gemini-3.8-flash' },
  { name: 'morning_digest',     titulo: 'Morning Digest',       descripcion: 'Resumen matutino (agenda, correos sin leer, escalamientos). Tarea programada integrada.', defaultModel: 'gemini-3.5-flash-lite' },
  { name: 'context_consolidation', titulo: 'Consolidación de contexto', descripcion: 'Extrae acuerdos de Chat y Gmail hacia la memoria episódica (nocturno). Muchos hilos: conviene barato o local.', defaultModel: 'gemini-3.5-flash' },
  { name: 'meeting_ingest',     titulo: 'Ingesta de reuniones', descripcion: 'Resume transcripciones de Meet para indexarlas. Textos largos: conviene barato.', defaultModel: 'gemini-3.5-flash-lite' },
];

export const PRESETS: ProviderPreset[] = [
  { id: 'gemini',     name: 'Google Gemini',      kind: 'gemini',            needsKey: true,  keysUrl: 'https://aistudio.google.com/apikey', hint: 'Lista los modelos desde la API de Google.' },
  { id: 'openai',     name: 'OpenAI',             kind: 'openai',            baseUrl: 'https://api.openai.com/v1',       needsKey: true,  keysUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic',  name: 'Anthropic (Claude)', kind: 'anthropic',         baseUrl: 'https://api.anthropic.com',       needsKey: true,  keysUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'xai',        name: 'xAI (Grok)',         kind: 'openai_compatible', baseUrl: 'https://api.x.ai/v1',             needsKey: true,  keysUrl: 'https://console.x.ai' },
  { id: 'moonshot',   name: 'Moonshot (Kimi)',    kind: 'openai_compatible', baseUrl: 'https://api.moonshot.ai/v1',      needsKey: true,  keysUrl: 'https://platform.moonshot.ai', models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-128k'] },
  { id: 'deepseek',   name: 'DeepSeek',           kind: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1',     needsKey: true,  keysUrl: 'https://platform.deepseek.com/api_keys', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'groq',       name: 'Groq',               kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1',  needsKey: true,  keysUrl: 'https://console.groq.com/keys' },
  { id: 'mistral',    name: 'Mistral',            kind: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1',       needsKey: true,  keysUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'openrouter', name: 'OpenRouter',         kind: 'openai_compatible', baseUrl: 'https://openrouter.ai/api/v1',    needsKey: true,  keysUrl: 'https://openrouter.ai/keys', hint: 'Un solo key para cientos de modelos; el id lleva el vendor (p. ej. anthropic/claude-sonnet-4).' },
  { id: 'ollama',     name: 'Ollama (local)',     kind: 'ollama',            baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434', needsKey: false, hint: 'Sin costo. Los modelos son los que tengas descargados (ollama pull …).' },
  { id: 'custom',     name: 'Otro compatible con OpenAI', kind: 'openai_compatible', needsKey: false, hint: 'Cualquier API con /chat/completions (LM Studio, vLLM, Together, Fireworks…).' },
];

const KEY_PROVIDERS = 'llm.providers';
const KEY_ASSIGNMENTS = 'llm.assignments';

function mask(v?: string | null): string | null {
  if (!v) return null;
  return v.length <= 8 ? '••••' : `${v.slice(0, 3)}…${v.slice(-4)}`;
}

class LlmSettingsService {
  private cache: { providers?: LlmProvider[]; assignments?: Record<string, LlmAssignment> } = {};

  // ─── Proveedores ─────────────────────────────────────────────────────────
  private leerProviders(): LlmProvider[] {
    if (this.cache.providers) return this.cache.providers;
    let lista: LlmProvider[] = [];
    try { lista = JSON.parse(sqliteReminderService.getConfig(KEY_PROVIDERS, '[]')); } catch { lista = []; }
    if (!Array.isArray(lista)) lista = [];
    if (lista.length === 0) lista = this.sembrar();
    this.cache.providers = lista;
    return lista;
  }

  /** Primera vez: arma los proveedores a partir del .env para no partir de cero. */
  private sembrar(): LlmProvider[] {
    const ahora = new Date().toISOString();
    const out: LlmProvider[] = [];
    if (process.env.GEMINI_API_KEY) {
      out.push({ id: 'gemini', name: 'Google Gemini', kind: 'gemini', apiKey: process.env.GEMINI_API_KEY, enabled: true, preset: 'gemini', createdAt: ahora, updatedAt: ahora });
    }
    if (process.env.OLLAMA_BASE_URL) {
      out.push({ id: 'ollama', name: 'Ollama (local)', kind: 'ollama', baseUrl: process.env.OLLAMA_BASE_URL, enabled: true, preset: 'ollama', createdAt: ahora, updatedAt: ahora });
    }
    if (out.length) sqliteReminderService.setConfig(KEY_PROVIDERS, JSON.stringify(out));
    return out;
  }

  private guardarProviders(lista: LlmProvider[]) {
    this.cache.providers = lista;
    sqliteReminderService.setConfig(KEY_PROVIDERS, JSON.stringify(lista));
  }

  /** Lista para la GUI: la clave nunca sale entera. */
  listProviders() {
    return this.leerProviders().map((p) => ({ ...p, apiKey: undefined, apiKeyMask: mask(p.apiKey), tieneKey: !!p.apiKey }));
  }

  getProvider(id: string): LlmProvider | undefined {
    return this.leerProviders().find((p) => p.id === id);
  }

  saveProvider(input: Partial<LlmProvider> & { name: string; kind: ProviderKind }): LlmProvider {
    const lista = [...this.leerProviders()];
    const ahora = new Date().toISOString();
    const kind = input.kind;
    if (!['gemini', 'openai', 'anthropic', 'ollama', 'openai_compatible'].includes(kind)) throw new Error(`Tipo de proveedor desconocido: ${kind}`);
    const baseUrl = (input.baseUrl || '').trim().replace(/\/+$/, '') || undefined;
    if ((kind === 'openai' || kind === 'openai_compatible' || kind === 'ollama') && !baseUrl) throw new Error('Este tipo de proveedor necesita una URL base.');

    const idx = input.id ? lista.findIndex((p) => p.id === input.id) : -1;
    if (idx >= 0) {
      const prev = lista[idx];
      lista[idx] = {
        ...prev,
        name: input.name.trim() || prev.name,
        kind,
        baseUrl,
        // clave vacía = conservar la anterior
        apiKey: input.apiKey ? input.apiKey.trim() : prev.apiKey,
        enabled: input.enabled ?? prev.enabled,
        preset: input.preset ?? prev.preset,
        updatedAt: ahora,
      };
      this.guardarProviders(lista);
      return lista[idx];
    }
    const id = (input.id || input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'prov') + (lista.some((p) => p.id === (input.id || '')) ? `-${randomBytes(2).toString('hex')}` : '');
    const nuevo: LlmProvider = {
      id: lista.some((p) => p.id === id) ? `${id}-${randomBytes(2).toString('hex')}` : id,
      name: input.name.trim(),
      kind,
      baseUrl,
      apiKey: input.apiKey?.trim() || undefined,
      enabled: input.enabled ?? true,
      preset: input.preset,
      createdAt: ahora,
      updatedAt: ahora,
    };
    lista.push(nuevo);
    this.guardarProviders(lista);
    return nuevo;
  }

  deleteProvider(id: string) {
    const lista = this.leerProviders().filter((p) => p.id !== id);
    this.guardarProviders(lista);
    // Los agentes que lo usaban vuelven al modelo por defecto.
    const asig = this.getAssignments();
    let cambio = false;
    for (const [agente, a] of Object.entries(asig)) {
      if (a.provider === id) { delete asig[agente]; cambio = true; }
    }
    if (cambio) this.guardarAssignments(asig);
  }

  // ─── Asignaciones ────────────────────────────────────────────────────────
  getAssignments(): Record<string, LlmAssignment> {
    if (this.cache.assignments) return this.cache.assignments;
    let obj: Record<string, LlmAssignment> = {};
    try { obj = JSON.parse(sqliteReminderService.getConfig(KEY_ASSIGNMENTS, '{}')); } catch { obj = {}; }
    if (!obj || typeof obj !== 'object') obj = {};
    this.cache.assignments = obj;
    return obj;
  }

  private guardarAssignments(obj: Record<string, LlmAssignment>) {
    this.cache.assignments = obj;
    sqliteReminderService.setConfig(KEY_ASSIGNMENTS, JSON.stringify(obj));
  }

  setAssignment(agent: string, a: LlmAssignment | null) {
    if (!AGENTES_LLM.some((x) => x.name === agent)) throw new Error(`Agente desconocido: ${agent}`);
    const obj = { ...this.getAssignments() };
    if (!a || !a.provider || !a.model) {
      delete obj[agent];
    } else {
      if (!this.getProvider(a.provider)) throw new Error(`Proveedor desconocido: ${a.provider}`);
      obj[agent] = { provider: a.provider, model: a.model.trim() };
    }
    this.guardarAssignments(obj);
  }

  /** Lo que usa el DynamicLlm en cada turno. null = Gemini por defecto del agente. */
  resolve(agent: string): { provider: LlmProvider; model: string } | null {
    const a = this.getAssignments()[agent];
    if (!a) return null;
    const provider = this.getProvider(a.provider);
    if (!provider || !provider.enabled) return null;
    return { provider, model: a.model };
  }

  /**
   * "<proveedor>/<modelo>" → proveedor + modelo. Entiende también los valores
   * antiguos de los webhooks ("gemma3:12b (ollama)", "gemini-2.5-flash").
   */
  resolverRef(ref: string): { provider: LlmProvider; model: string } | null {
    const v = (ref || '').trim();
    const barra = v.indexOf('/');
    if (barra > 0) {
      const prov = this.getProvider(v.slice(0, barra));
      if (prov) return { provider: prov, model: v.slice(barra + 1) };
    }
    if (/\(ollama\)/i.test(v) || /^(gemma|llama|qwen|mistral|phi|deepseek|gpt-oss)/i.test(v)) {
      const prov = this.leerProviders().find((p) => p.kind === 'ollama' && p.enabled);
      if (prov) return { provider: prov, model: v.replace(/\s*\(ollama\)\s*/i, '').trim() };
    }
    const gem = this.getProvider('gemini') || this.leerProviders().find((p) => p.kind === 'gemini' && p.enabled);
    if (gem) return { provider: gem, model: v.startsWith('gemini') ? v : 'gemini-3.5-flash-lite' };
    return null;
  }

  /** Proveedores activos con sus modelos (para selectores de la GUI). */
  async catalogo(): Promise<Array<{ id: string; name: string; kind: ProviderKind; models: string[]; error?: string }>> {
    const providers = this.leerProviders().filter((p) => p.enabled);
    return Promise.all(providers.map(async (p) => {
      try { return { id: p.id, name: p.name, kind: p.kind, models: await this.listModels(p.id) }; }
      catch (err: any) { return { id: p.id, name: p.name, kind: p.kind, models: [], error: err?.message }; }
    }));
  }

  /** Resumen para la GUI: agente → asignación efectiva. */
  describeAssignments() {
    const asig = this.getAssignments();
    return AGENTES_LLM.map((ag) => {
      const a = asig[ag.name];
      const prov = a ? this.getProvider(a.provider) : undefined;
      return {
        ...ag,
        assignment: a || null,
        efectivo: a && prov && prov.enabled ? { provider: prov.name, model: a.model } : { provider: 'Google Gemini (.env)', model: ag.defaultModel },
        advertencia: a && (!prov ? 'el proveedor ya no existe' : !prov.enabled ? 'el proveedor está desactivado' : !prov.apiKey && prov.kind !== 'ollama' && prov.kind !== 'openai_compatible' ? 'el proveedor no tiene API key' : null),
      };
    });
  }

  // ─── Modelos y prueba ────────────────────────────────────────────────────
  async listModels(providerId: string): Promise<string[]> {
    const p = this.getProvider(providerId);
    if (!p) throw new Error('Proveedor no encontrado');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      if (p.kind === 'gemini') {
        const key = p.apiKey || process.env.GEMINI_API_KEY;
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key || '')}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`Google respondió ${res.status}`);
        const data: any = await res.json();
        return (data.models || [])
          .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((m: any) => String(m.name).replace(/^models\//, ''))
          .sort();
      }
      if (p.kind === 'anthropic') {
        const res = await fetch(`${(p.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models?limit=100`, {
          headers: { 'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01' }, signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`Anthropic respondió ${res.status}`);
        const data: any = await res.json();
        return (data.data || []).map((m: any) => m.id).sort();
      }
      if (p.kind === 'ollama') {
        const base = (p.baseUrl || 'http://localhost:11434').replace(/\/v1$/, '').replace(/\/$/, '');
        const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`Ollama respondió ${res.status}`);
        const data: any = await res.json();
        return (data.models || []).map((m: any) => m.name).sort();
      }
      // openai / compatible
      const headers: Record<string, string> = {};
      if (p.apiKey) headers['Authorization'] = `Bearer ${p.apiKey}`;
      const res = await fetch(`${p.baseUrl!.replace(/\/$/, '')}/models`, { headers, signal: ctrl.signal });
      if (!res.ok) {
        const preset = PRESETS.find((x) => x.id === p.preset);
        if (preset?.models?.length) return preset.models;
        throw new Error(`${p.baseUrl} respondió ${res.status} en /models`);
      }
      const data: any = await res.json();
      const ids = (data.data || data.models || []).map((m: any) => m.id || m.name).filter(Boolean);
      return ids.sort();
    } finally {
      clearTimeout(timer);
    }
  }

  /** URL base efectiva con la que se construye el cliente. */
  baseUrlEfectiva(p: LlmProvider): string | undefined {
    if (p.kind === 'ollama') {
      const b = (p.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
      return b.endsWith('/v1') ? b : `${b}/v1`;
    }
    return p.baseUrl;
  }
}

export const llmSettingsService = new LlmSettingsService();
