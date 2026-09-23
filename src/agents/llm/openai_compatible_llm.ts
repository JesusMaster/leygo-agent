import { BaseLlm } from '@google/adk';
import { recordModelUsage } from '../../utils/usage_collector.js';
import { aMensajesOpenAI, toolsOpenAI, desdeMensajeOpenAI , respuestaError, fetchConReintentos } from './conversion.js';

export interface OpenAiCompatibleParams {
  model: string;
  baseUrl: string;          // p. ej. https://api.openai.com/v1, https://api.x.ai/v1, http://ollama:11434/v1
  apiKey?: string | null;
  agentName?: string;
  headers?: Record<string, string>;
  /** nombre con el que se contabiliza el precio (p. ej. "xai/grok-2") */
  pricingModel?: string;
  timeoutMs?: number;
}

/**
 * Cualquier API "OpenAI Chat Completions": OpenAI, xAI (Grok), Moonshot (Kimi),
 * DeepSeek, Groq, OpenRouter, Ollama (/v1). Con llamadas a herramientas.
 * No hace streaming hacia el ADK: entrega una respuesta completa por turno.
 */
export class OpenAiCompatibleLlm extends BaseLlm {
  static readonly supportedModels: Array<string | RegExp> = [];
  private readonly p: OpenAiCompatibleParams;

  constructor(params: OpenAiCompatibleParams) {
    super({ model: params.model });
    this.p = params;
  }

  async *generateContentAsync(llmRequest: any, _stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<any, void> {
    const cfg = llmRequest?.config || {};
    const body: any = {
      model: this.model,
      messages: aMensajesOpenAI(llmRequest),
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.maxOutputTokens ? { max_tokens: cfg.maxOutputTokens } : {}),
    };
    const tools = toolsOpenAI(llmRequest);
    if (tools) { body.tools = tools; body.tool_choice = 'auto'; }

    const url = `${this.p.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(this.p.headers || {}) };
    if (this.p.apiKey) headers['Authorization'] = `Bearer ${this.p.apiKey}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.p.timeoutMs || 120_000);
    abortSignal?.addEventListener('abort', () => ctrl.abort());

    let data: any;
    try {
      const res = await fetchConReintentos(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      const texto = await res.text();
      if (!res.ok) {
        yield respuestaError(this.p.agentName, this.model, String(res.status), `${this.p.baseUrl} respondió ${res.status}: ${texto.slice(0, 300)}`);
        return;
      }
      data = JSON.parse(texto);
    } catch (err: any) {
      yield respuestaError(this.p.agentName, this.model, 'NETWORK', `No se pudo hablar con ${this.p.baseUrl}: ${err?.message || err}`);
      return;
    } finally {
      clearTimeout(timer);
    }

    const choice = data?.choices?.[0];
    const usage = data?.usage || {};
    const usageMetadata = {
      promptTokenCount: usage.prompt_tokens || 0,
      candidatesTokenCount: usage.completion_tokens || 0,
      totalTokenCount: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      thoughtsTokenCount: usage.completion_tokens_details?.reasoning_tokens || 0,
      // OpenAI/xAI/Moonshot/DeepSeek informan el caché de prompt aquí (DeepSeek además como prompt_cache_hit_tokens)
      cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens || usage.prompt_cache_hit_tokens || 0,
    };
    recordModelUsage(this.p.pricingModel || this.model, usageMetadata.promptTokenCount, usageMetadata.candidatesTokenCount, this.p.agentName || 'unknown', { cachedTokens: usageMetadata.cachedContentTokenCount, thoughtsTokens: usageMetadata.thoughtsTokenCount });

    yield {
      content: desdeMensajeOpenAI(choice?.message),
      usageMetadata,
      finishReason: choice?.finish_reason === 'length' ? 'MAX_TOKENS' : 'STOP',
      turnComplete: true,
      modelVersion: data?.model || this.model,
    };
  }

  async connect(_llmRequest: any): Promise<any> {
    throw new Error(`El modelo ${this.model} (${this.p.baseUrl}) no soporta conexión en vivo.`);
  }
}
