import { AsyncLocalStorage } from 'node:async_hooks';
import { tokenTrackerService, UsageChannel } from '../services/token_tracker.service.js';

/**
 * Contexto de consumo por turno.
 *
 * POR QUÉ NO SE MIDE EN EL RUNNER: los subagentes montados como `AgentTool`
 * crean su PROPIO Runner interno (ver agent_tool.js del ADK) y consumen sus
 * eventos en un bucle privado, devolviendo solo el texto final. Sus llamadas al
 * modelo nunca aparecen en el stream del Runner padre, así que medir ahí deja
 * fuera todo lo que gastan faq_agent, account_agent y knowledge_agent.
 *
 * La medición vive entonces en la clase del modelo (TrackedGemini), que ve el
 * 100% de las llamadas. Este AsyncLocalStorage es lo que le permite saber a qué
 * canal y a qué hilo imputarlas, sin tener que pasar el dato por toda la cadena.
 */
export interface UsageScope {
  channel: UsageChannel;
  threadId: string;
  label: string;
  /** clave: "<agente>::<modelo>" */
  totals: Map<string, { agent: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; thoughtsTokens: number; images: number; llamadas: number }>;
  /** Herramientas invocadas en el turno, en orden ("agente→tool"); para entender por qué un turno costó lo que costó */
  pasos: string[];
}

const storage = new AsyncLocalStorage<UsageScope>();

/** Abre el scope para el turno actual. Todo lo que se ejecute después lo hereda. */
export function beginUsageScope(channel: UsageChannel, threadId: string, label: string): UsageScope {
  const scope: UsageScope = {
    channel,
    threadId: threadId || 'system',
    label: (label || '').slice(0, 150),
    totals: new Map(),
    pasos: [],
  };
  storage.enterWith(scope);
  return scope;
}

export function currentUsageScope(): UsageScope | undefined {
  return storage.getStore();
}

/** Anota las llamadas a herramientas que trae un evento del Runner (functionCall) en el scope del turno. */
export function anotarPasosDeEvento(event: any): void {
  const scope = storage.getStore();
  if (!scope || !Array.isArray(event?.content?.parts)) return;
  for (const p of event.content.parts) {
    if (p?.functionCall?.name && scope.pasos.length < 60) scope.pasos.push(`${event.author || '?'}→${p.functionCall.name}`);
  }
}

// telegram_auth necesita saber el canal para acotar su ventana de gracia, pero
// importarlo en estático cerraría un ciclo (usage_collector → token_tracker →
// telegram_bot → telegram_auth). Se publica el accesor en un global.
(globalThis as any).__yisusUsageScope = currentUsageScope;

/**
 * Registra el consumo de UNA llamada al modelo. Si hay un scope abierto acumula
 * (se persiste al cerrar el turno); si no, persiste de inmediato como 'system'.
 */
export function recordModelUsage(model: string, inputTokens: number, outputTokens: number, agent: string = 'unknown', extra: { cachedTokens?: number; thoughtsTokens?: number; images?: number } = {}): void {
  const images = Math.max(0, extra.images || 0);
  if (inputTokens <= 0 && outputTokens <= 0 && images <= 0) return;
  const cachedTokens = Math.max(0, extra.cachedTokens || 0);
  const thoughtsTokens = Math.max(0, extra.thoughtsTokens || 0);

  const scope = storage.getStore();
  if (!scope) {
    tokenTrackerService
      .logUsage('(llamada fuera de un turno)', model, inputTokens, outputTokens, 'system', 'system', agent, { cachedTokens, thoughtsTokens, images })
      .catch(() => {});
    return;
  }

  const key = `${agent}::${model}`;
  const acc = scope.totals.get(key) || { agent, model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, thoughtsTokens: 0, images: 0, llamadas: 0 };
  acc.llamadas += 1;
  acc.inputTokens += inputTokens;
  acc.outputTokens += outputTokens;
  acc.cachedTokens += cachedTokens;
  acc.thoughtsTokens += thoughtsTokens;
  acc.images += images;
  scope.totals.set(key, acc);
}

/** Totales del turno en curso (tokens y costo estimado), para mostrarlos en la GUI antes de cerrar. */
export interface UsageSummaryTurno {
  inputTokens: number; outputTokens: number; cachedTokens: number; thoughtsTokens: number; totalTokens: number; costUsd: number;
  /** true si algún modelo del turno se tarifó por familia/default (costo aproximado) */
  aproximado: boolean;
  porAgente: Array<{ agent: string; model: string; tokens: number; cachedTokens: number; costUsd: number; llamadas: number; source: string }>;
}

export function summarizeUsageScope(): UsageSummaryTurno {
  const scope = storage.getStore();
  const out: UsageSummaryTurno = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, thoughtsTokens: 0, totalTokens: 0, costUsd: 0, aproximado: false, porAgente: [] };
  if (!scope) return out;
  for (const t of scope.totals.values()) {
    const { costUsd: cost, prices } = tokenTrackerService.costFor(t.model, t.inputTokens, t.outputTokens, t.cachedTokens, t.images);
    out.inputTokens += t.inputTokens;
    out.outputTokens += t.outputTokens;
    out.cachedTokens += t.cachedTokens;
    out.thoughtsTokens += t.thoughtsTokens;
    out.costUsd += cost;
    if (prices.source === 'familia' || prices.source === 'default') out.aproximado = true;
    out.porAgente.push({ agent: t.agent, model: t.model, tokens: t.inputTokens + t.outputTokens, cachedTokens: t.cachedTokens, costUsd: cost, llamadas: t.llamadas, source: prices.source });
  }
  out.totalTokens = out.inputTokens + out.outputTokens;
  return out;
}

/** Persiste un registro por combinación agente+modelo del turno y cierra el scope. */
export async function flushUsageScope(): Promise<void> {
  const scope = storage.getStore();
  if (!scope || scope.totals.size === 0) return;

  for (const t of scope.totals.values()) {
    await tokenTrackerService
      .logUsage(scope.label, t.model, t.inputTokens, t.outputTokens, scope.threadId, scope.channel, t.agent, { cachedTokens: t.cachedTokens, thoughtsTokens: t.thoughtsTokens, llamadas: t.llamadas, pasos: scope.pasos, images: t.images })
      .catch(() => {});
  }
  scope.totals.clear();
}
