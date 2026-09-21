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
  totals: Map<string, { agent: string; model: string; inputTokens: number; outputTokens: number }>;
}

const storage = new AsyncLocalStorage<UsageScope>();

/** Abre el scope para el turno actual. Todo lo que se ejecute después lo hereda. */
export function beginUsageScope(channel: UsageChannel, threadId: string, label: string): UsageScope {
  const scope: UsageScope = {
    channel,
    threadId: threadId || 'system',
    label: (label || '').slice(0, 150),
    totals: new Map(),
  };
  storage.enterWith(scope);
  return scope;
}

export function currentUsageScope(): UsageScope | undefined {
  return storage.getStore();
}

/**
 * Registra el consumo de UNA llamada al modelo. Si hay un scope abierto acumula
 * (se persiste al cerrar el turno); si no, persiste de inmediato como 'system'.
 */
export function recordModelUsage(model: string, inputTokens: number, outputTokens: number, agent: string = 'unknown'): void {
  if (inputTokens <= 0 && outputTokens <= 0) return;

  const scope = storage.getStore();
  if (!scope) {
    tokenTrackerService
      .logUsage('(llamada fuera de un turno)', model, inputTokens, outputTokens, 'system', 'system', agent)
      .catch(() => {});
    return;
  }

  const key = `${agent}::${model}`;
  const acc = scope.totals.get(key) || { agent, model, inputTokens: 0, outputTokens: 0 };
  acc.inputTokens += inputTokens;
  acc.outputTokens += outputTokens;
  scope.totals.set(key, acc);
}

/** Persiste un registro por combinación agente+modelo del turno y cierra el scope. */
export async function flushUsageScope(): Promise<void> {
  const scope = storage.getStore();
  if (!scope || scope.totals.size === 0) return;

  for (const t of scope.totals.values()) {
    await tokenTrackerService
      .logUsage(scope.label, t.model, t.inputTokens, t.outputTokens, scope.threadId, scope.channel, t.agent)
      .catch(() => {});
  }
  scope.totals.clear();
}
