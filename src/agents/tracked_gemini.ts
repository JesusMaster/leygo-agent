import { Gemini } from '@google/adk';
import { tokenTrackerService } from '../services/token_tracker.service.js';
import { recordModelUsage } from '../utils/usage_collector.js';

/**
 * Gemini instrumentado: contabiliza TODA llamada al modelo, la haga el
 * Coordinator o el Runner interno de un AgentTool.
 *
 * El usageMetadata de Gemini es acumulativo dentro de una misma llamada, así que
 * se guarda el último valor visto y se registra una sola vez al terminar el
 * generador (en `finally`, para no perderlo si el consumidor corta antes).
 */
export class TrackedGemini extends Gemini {
  /** Nombre del agente dueño de esta instancia, para el desglose por agente */
  public readonly agentName: string;

  constructor(params: any) {
    super(params);
    this.agentName = params?.agentName || 'unknown';
  }

  async *generateContentAsync(llmRequest: any, stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<any, void> {
    let lastUsage: any = null;

    try {
      for await (const response of super.generateContentAsync(llmRequest, stream, abortSignal)) {
        const meta = (response as any)?.usageMetadata;
        if (meta) lastUsage = meta;
        yield response;
      }
    } finally {
      if (lastUsage) {
        const u = tokenTrackerService.extractUsage(lastUsage);
        recordModelUsage(this.model, u.inputTokens, u.outputTokens, this.agentName, { cachedTokens: u.cachedTokens, thoughtsTokens: u.thoughtsTokens });
      }
    }
  }
}
