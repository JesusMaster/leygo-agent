import { BaseLlm } from '@google/adk';
import { TrackedGemini } from '../tracked_gemini.js';
import { OpenAiCompatibleLlm } from './openai_compatible_llm.js';
import { AnthropicLlm } from './anthropic_llm.js';
import { llmSettingsService, type LlmProvider } from '../../services/llm_settings.service.js';
import { aplicarPresupuesto } from './context_budget.js';

/**
 * Construye el cliente concreto para un proveedor + modelo. Se cachea por
 * configuración, así que cambiar la key o la URL desde la GUI crea uno nuevo.
 */
const cache = new Map<string, BaseLlm>();

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
    const r = llmSettingsService.resolve(this.agentName);
    if (!r) return this.fallback;
    try {
      return construirLlm(r.provider, r.model, this.agentName);
    } catch (err: any) {
      console.warn(`⚠️ [LLM] ${this.agentName}: no se pudo armar ${r.provider.name}/${r.model} (${err?.message}); uso Gemini por defecto`);
      return this.fallback;
    }
  }

  async *generateContentAsync(llmRequest: any, stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<any, void> {
    const llm = this.actual();
    if (llmRequest && typeof llmRequest === 'object') {
      llmRequest.model = llm.model;
      const r = aplicarPresupuesto(llmRequest, this.agentName);
      if (r.antes !== r.despues) {
        console.log(`✂️  [LLM] ${this.agentName}: contexto ${(r.antes / 1000).toFixed(0)}k → ${(r.despues / 1000).toFixed(0)}k chars${r.recortados ? ` (${r.recortados} mensajes antiguos fuera)` : ''}`);
      }
    }
    yield* llm.generateContentAsync(llmRequest, stream, abortSignal);
  }

  async connect(llmRequest: any): Promise<any> {
    return (this.actual() as any).connect(llmRequest);
  }
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
