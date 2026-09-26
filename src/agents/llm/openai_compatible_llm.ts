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
    const ajuste = ajustesPorModelo.get(this.claveAjuste()) || {};
    const body: any = {
      model: this.model,
      messages: aMensajesOpenAI(llmRequest),
      ...(cfg.temperature !== undefined && !ajuste.sinTemperatura ? { temperature: cfg.temperature } : {}),
    };
    // OpenAI (gpt-5, o-series, gpt-4.1…) rechaza max_tokens: exige max_completion_tokens.
    if (cfg.maxOutputTokens) body[this.usaMaxCompletion(ajuste) ? 'max_completion_tokens' : 'max_tokens'] = cfg.maxOutputTokens;
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
      let res = await fetchConReintentos(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      let texto = await res.text();
      // Parámetros que ciertos modelos no aceptan: se corrige, se recuerda y se reintenta
      // (hasta dos veces: el proveedor informa un parámetro por respuesta).
      for (let i = 0; i < 2 && res.status === 400 && this.corregirParametros(body, texto); i++) {
        res = await fetchConReintentos(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
        texto = await res.text();
      }
      if (!res.ok) {
        yield respuestaError(this.p.agentName, this.model, String(res.status), `${this.p.baseUrl} respondió ${res.status}: ${mensajeDeError(texto)}`);
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

  private claveAjuste() { return `${this.p.baseUrl}|${this.model}`; }

  private usaMaxCompletion(ajuste: AjusteModelo): boolean {
    if (ajuste.maxCompletion !== undefined) return ajuste.maxCompletion;
    return /(^|\.)openai\.com/i.test(hostDe(this.p.baseUrl));
  }

  /** Ajusta el body según el error 400 del proveedor. Devuelve true si cambió algo. */
  private corregirParametros(body: any, texto: string): boolean {
    const t = texto.toLowerCase();
    const ajuste: AjusteModelo = { ...(ajustesPorModelo.get(this.claveAjuste()) || {}) };
    let cambio = false;
    if (body.max_tokens !== undefined && t.includes('max_completion_tokens')) {
      body.max_completion_tokens = body.max_tokens; delete body.max_tokens; ajuste.maxCompletion = true; cambio = true;
    } else if (body.max_completion_tokens !== undefined && t.includes('max_completion_tokens') && t.includes('unrecognized')) {
      body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens; ajuste.maxCompletion = false; cambio = true;
    }
    if (body.temperature !== undefined && t.includes('temperature') && /(unsupported|not support|only the default)/.test(t)) {
      delete body.temperature; ajuste.sinTemperatura = true; cambio = true;
    }
    if (cambio) ajustesPorModelo.set(this.claveAjuste(), ajuste);
    return cambio;
  }

  async connect(_llmRequest: any): Promise<any> {
    throw new Error(`El modelo ${this.model} (${this.p.baseUrl}) no soporta conexión en vivo.`);
  }
}

interface AjusteModelo { maxCompletion?: boolean; sinTemperatura?: boolean }
/** Lo aprendido de errores 400 por modelo, para no repetir el intento fallido en cada turno. */
const ajustesPorModelo = new Map<string, AjusteModelo>();

function hostDe(u: string): string { try { return new URL(u).host; } catch { return u; } }

/** Del cuerpo de error JSON típico ({error:{message}}) saca solo el mensaje legible. */
export function mensajeDeError(texto: string): string {
  const sacar = (j: any): string | null => {
    const m = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : null) || j?.detail;
    return typeof m === 'string' && m.trim() ? m.trim() : null;
  };
  const limpio = String(texto || '').trim();
  try { const m = sacar(JSON.parse(limpio)); if (m) return m.slice(0, 300); } catch { /* no era JSON puro */ }
  // "…respondió 400: {json}" o "got status 400. {json}": se conserva el prefijo y se limpia el JSON.
  const i = limpio.indexOf('{');
  if (i > 0) {
    try {
      const m = sacar(JSON.parse(limpio.slice(i)));
      if (m) return `${limpio.slice(0, i).replace(/[\s:.-]+$/, '')}: ${m}`.slice(0, 300);
    } catch { /* JSON truncado */ }
  }
  return limpio.replace(/\s+/g, ' ').slice(0, 300);
}
