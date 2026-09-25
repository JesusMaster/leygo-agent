import { AsyncLocalStorage } from 'node:async_hooks';
import { BaseLlm } from '@google/adk';
import { TrackedGemini } from '../tracked_gemini.js';
import { OpenAiCompatibleLlm } from './openai_compatible_llm.js';
import { AnthropicLlm } from './anthropic_llm.js';
import { llmSettingsService, type LlmProvider } from '../../services/llm_settings.service.js';
import { aplicarPresupuesto } from './context_budget.js';
import { currentUsageScope } from '../../utils/usage_collector.js';

/**
 * Construye el cliente concreto para un proveedor + modelo. Se cachea por
 * configuración, así que cambiar la key o la URL desde la GUI crea uno nuevo.
 */
const cache = new Map<string, BaseLlm>();

/**
 * Override de modelo por ejecución: una tarea programada o un webhook pueden
 * pedir que un agente (normalmente el Coordinator) use otro proveedor/modelo
 * solo durante ese turno, sin tocar la asignación global de Ajustes.
 */
const overrides = new AsyncLocalStorage<Map<string, { provider: LlmProvider; model: string }>>();

export function conModelo<T>(agentName: string, ref: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  const r = ref ? llmSettingsService.resolverRef(ref) : null;
  if (!r) return fn();
  const mapa = new Map(overrides.getStore() || []);
  mapa.set(agentName, r);
  return overrides.run(mapa, fn);
}

export function construirLlm(provider: LlmProvider, model: string, agentName: string): BaseLlm {
  const baseUrl = llmSettingsService.baseUrlEfectiva(provider);
  const clave = [provider.kind, baseUrl || '', provider.apiKey || '', model, agentName].join('|');
  const hit = cache.get(clave);
  if (hit) return hit;

  let llm: BaseLlm;
  switch (provider.kind) {
    case 'gemini':
      llm = new TrackedGemini({ model, apiKey: provider.apiKey || process.env.GEMINI_API_KEY, agentName });
      break;
    case 'anthropic':
      llm = new AnthropicLlm({ model, apiKey: provider.apiKey || '', baseUrl: provider.baseUrl, agentName });
      break;
    case 'ollama':
      llm = new OpenAiCompatibleLlm({ model, baseUrl: baseUrl!, apiKey: provider.apiKey, agentName, pricingModel: `ollama/${model}` });
      break;
    case 'openai':
    case 'openai_compatible':
    default:
      llm = new OpenAiCompatibleLlm({ model, baseUrl: baseUrl!, apiKey: provider.apiKey, agentName, pricingModel: provider.preset && provider.preset !== 'openai' && provider.preset !== 'custom' ? `${provider.preset}/${model}` : model });
      break;
  }
  cache.set(clave, llm);
  return llm;
}

/**
 * Modelo "vivo" de un agente: en cada turno mira la asignación guardada y
 * delega en el cliente que corresponda. Si no hay asignación (o el proveedor
 * está apagado) usa el Gemini por defecto del agente, como antes.
 */
export class DynamicLlm extends BaseLlm {
  static readonly supportedModels: Array<string | RegExp> = [];
  private readonly agentName: string;
  private readonly fallback: TrackedGemini;

  constructor(params: { agentName: string; fallbackModel: string }) {
    super({ model: params.fallbackModel });
    this.agentName = params.agentName;
    this.fallback = new TrackedGemini({ model: params.fallbackModel, agentName: params.agentName });
    // `model` es readonly en BaseLlm; se expone el modelo efectivo para que
    // el ADK (y los logs) vean el que realmente responde.
    Object.defineProperty(this, 'model', { get: () => this.actual().model, enumerable: true, configurable: true });
  }

  /** Cliente efectivo en este momento. */
  actual(): BaseLlm {
    const r = overrides.getStore()?.get(this.agentName) || llmSettingsService.resolve(this.agentName);
    if (!r) return this.fallback;
    try {
      return construirLlm(r.provider, r.model, this.agentName);
    } catch (err: any) {
      console.warn(`⚠️ [LLM] ${this.agentName}: no se pudo armar ${r.provider.name}/${r.model} (${err?.message}); uso Gemini por defecto`);
      return this.fallback;
    }
  }

  /** Cliente de respaldo configurado (Ajustes → Modelos por agente), o null. */
  respaldo(): BaseLlm | null {
    const r = llmSettingsService.resolveFallback(this.agentName);
    if (!r) return null;
    try { return construirLlm(r.provider, r.model, this.agentName); } catch { return null; }
  }

  async *generateContentAsync(llmRequest: any, stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<any, void> {
    const llm = this.actual();
    if (llmRequest && typeof llmRequest === 'object') {
      llmRequest.model = llm.model;
      const r = aplicarPresupuesto(llmRequest, this.agentName, currentUsageScope()?.threadId);
      if (r.antes !== r.despues) {
        console.log(`✂️  [LLM] ${this.agentName}: contexto ${(r.antes / 1000).toFixed(0)}k → ${(r.despues / 1000).toFixed(0)}k chars${r.recortados ? ` (${r.recortados} mensajes antiguos fuera)` : ''}`);
      }
    }

    // Failover: si el principal falla por algo transitorio (cuota, sobrecarga, caída) y hay
    // respaldo configurado, la MISMA petición se repite con el respaldo. Los adaptadores
    // propios no lanzan: devuelven un primer evento con errorCode; el Gemini del ADK lanza.
    const fb = this.respaldo();
    const gen = llm.generateContentAsync(llmRequest, stream, abortSignal);
    let primero: IteratorResult<any>;
    try {
      primero = await gen.next();
    } catch (err: any) {
      if (fb && esTransitorio(err)) { yield* this.conRespaldo(fb, llm, llmRequest, stream, abortSignal, describirError(err)); return; }
      throw err;
    }
    if (!primero.done && primero.value?.errorCode && fb && esTransitorio(primero.value)) {
      yield* this.conRespaldo(fb, llm, llmRequest, stream, abortSignal, primero.value.errorMessage || primero.value.errorCode);
      return;
    }
    if (!primero.done) yield primero.value;
    yield* gen;
  }

  private async *conRespaldo(fb: BaseLlm, principal: BaseLlm, llmRequest: any, stream: boolean | undefined, abortSignal: AbortSignal | undefined, motivo: string): AsyncGenerator<any, void> {
    console.warn(`🔁 [LLM] ${this.agentName}: ${principal.model} falló (${String(motivo).slice(0, 120)}) → respaldo ${fb.model}`);
    if (llmRequest && typeof llmRequest === 'object') llmRequest.model = fb.model;
    yield* fb.generateContentAsync(llmRequest, stream, abortSignal);
  }

  async connect(llmRequest: any): Promise<any> {
    return (this.actual() as any).connect(llmRequest);
  }
}

/**
 * ¿Vale la pena reintentar con otro modelo? Cuota/velocidad (429), sobrecarga o caída
 * del proveedor (5xx, "high demand", "unavailable", "overloaded"), red. NO: errores
 * de la petición (400, contexto, schema), auth (401/403) ni contenido bloqueado.
 */
export function esTransitorio(e: any): boolean {
  const code = String(e?.errorCode ?? e?.status ?? e?.code ?? e?.response?.status ?? '').toUpperCase();
  const msg = String(e?.errorMessage ?? e?.message ?? e ?? '').toLowerCase();
  if (/^(429|500|502|503|504|529|NETWORK|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|INTERNAL)$/.test(code)) return true;
  if (/^(400|401|403|404)$/.test(code)) return false;
  return /high demand|unavailable|overloaded|rate limit|ratelimit|quota|resource_exhausted|too many requests|try again later|timed? ?out|econnreset|fetch failed|socket hang up|\b(429|503|502|529)\b/.test(msg);
}

function describirError(e: any): string {
  return String(e?.message || e?.errorMessage || e || 'error').replace(/\s+/g, ' ');
}

export function modelFor(agentName: string, fallbackModel: string): DynamicLlm {
  return new DynamicLlm({ agentName, fallbackModel });
}

/** Prueba de humo desde la GUI: una pregunta corta y medimos. */
export async function probarModelo(providerId: string, model: string): Promise<{ ok: boolean; ms: number; respuesta?: string; error?: string }> {
  const provider = llmSettingsService.getProvider(providerId);
  if (!provider) return { ok: false, ms: 0, error: 'Proveedor no encontrado' };
  const t0 = Date.now();
  try {
    const llm = construirLlm({ ...provider }, model, 'prueba_gui');
    const req: any = {
      model,
      contents: [{ role: 'user', parts: [{ text: 'Responde únicamente con la palabra: listo' }] }],
      config: { maxOutputTokens: 20 },
    };
    let texto = '';
    let error: string | undefined;
    for await (const r of llm.generateContentAsync(req, false)) {
      if (r?.errorMessage) error = r.errorMessage;
      for (const p of r?.content?.parts || []) if (p.text) texto += p.text;
    }
    if (error) return { ok: false, ms: Date.now() - t0, error };
    return { ok: true, ms: Date.now() - t0, respuesta: texto.trim().slice(0, 200) };
  } catch (err: any) {
    return { ok: false, ms: Date.now() - t0, error: err?.message || String(err) };
  }
}

const dinamicos = new Map<string, DynamicLlm>();

/**
 * Generación de texto de un solo turno para rutinas del sistema (digest,
 * consolidación, webhooks). Respeta la asignación de modelo del "agente" en
 * Ajustes y contabiliza el consumo en el scope de uso abierto por el llamador.
 */
export async function generarTexto(agentName: string, fallbackModel: string, prompt: string, opts: { maxOutputTokens?: number } = {}): Promise<string> {
  let llm = dinamicos.get(agentName);
  if (!llm) { llm = new DynamicLlm({ agentName, fallbackModel }); dinamicos.set(agentName, llm); }
  const req: any = { contents: [{ role: 'user', parts: [{ text: prompt }] }], config: { ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}) } };
  let texto = '';
  let error: string | undefined;
  let fin: string | undefined;
  for await (const r of llm.generateContentAsync(req, false)) {
    if (r?.errorMessage) error = r.errorMessage;
    if ((r as any)?.finishReason) fin = String((r as any).finishReason);
    for (const p of r?.content?.parts || []) if (p.text && !(p as any).thought) texto += p.text;
  }
  if (error) throw new Error(error);
  // Los modelos con razonamiento gastan parte del límite en "pensar": un maxOutputTokens bajo
  // corta la respuesta a medias sin error. Se avisa en vez de devolver un texto mocho en silencio.
  if (fin === 'MAX_TOKENS') {
    if (!texto.trim()) throw new Error('El modelo agotó el límite de tokens sin responder');
    console.warn(`⚠️ [LLM] ${agentName}: respuesta cortada por límite de tokens (${opts.maxOutputTokens ?? 'sin límite explícito'}).`);
  }
  return texto.trim();
}
