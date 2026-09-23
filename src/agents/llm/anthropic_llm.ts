import { BaseLlm } from '@google/adk';
import { recordModelUsage } from '../../utils/usage_collector.js';
import { aMensajesAnthropic, toolsAnthropic, desdeRespuestaAnthropic , respuestaError, fetchConReintentos } from './conversion.js';

export interface AnthropicParams {
  model: string;
  apiKey: string;
  baseUrl?: string;
  agentName?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Claude por la Messages API, con herramientas. Sin streaming hacia el ADK. */
export class AnthropicLlm extends BaseLlm {
  static readonly supportedModels: Array<string | RegExp> = [];
  private readonly p: AnthropicParams;

  constructor(params: AnthropicParams) {
    super({ model: params.model });
    this.p = params;
  }

  async *generateContentAsync(llmRequest: any, _stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<any, void> {
    const cfg = llmRequest?.config || {};
    const { system, messages } = aMensajesAnthropic(llmRequest);
    const body: any = {
      model: this.model,
      max_tokens: cfg.maxOutputTokens || this.p.maxTokens || 4096,
      messages,
      ...(system ? { system } : {}),
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    };
    const tools = toolsAnthropic(llmRequest);
    if (tools) body.tools = tools;

    const url = `${(this.p.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.p.timeoutMs || 120_000);
    abortSignal?.addEventListener('abort', () => ctrl.abort());

    let data: any;
    try {
      const res = await fetchConReintentos(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.p.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const texto = await res.text();
      if (!res.ok) {
        yield respuestaError(this.p.agentName, this.model, String(res.status), `Anthropic respondió ${res.status}: ${texto.slice(0, 300)}`);
        return;
      }
      data = JSON.parse(texto);
    } catch (err: any) {
      yield respuestaError(this.p.agentName, this.model, 'NETWORK', `No se pudo hablar con Anthropic: ${err?.message || err}`);
      return;
    } finally {
      clearTimeout(timer);
    }

    const usageMetadata = {
      promptTokenCount: (data?.usage?.input_tokens || 0) + (data?.usage?.cache_read_input_tokens || 0),
      candidatesTokenCount: data?.usage?.output_tokens || 0,
      totalTokenCount: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0),
      cachedContentTokenCount: data?.usage?.cache_read_input_tokens || 0,
    };
    recordModelUsage(this.model, usageMetadata.promptTokenCount, usageMetadata.candidatesTokenCount, this.p.agentName || 'unknown');

    yield {
      content: desdeRespuestaAnthropic(data),
      usageMetadata,
      finishReason: data?.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : 'STOP',
      turnComplete: true,
      modelVersion: data?.model || this.model,
    };
  }

  async connect(_llmRequest: any): Promise<any> {
    throw new Error(`Claude no soporta conexión en vivo por esta integración.`);
  }
}
