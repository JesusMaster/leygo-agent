/**
 * YisusAgentExecutor — puente entre el protocolo A2A y el Runner ADK.
 *
 * Mapeo de identidades:
 *   A2A contextId  ↔  ADK sessionId  (la sesión Redis persiste la conversación)
 *   A2A message.metadata.userId → ADK userId (fallback: "a2a:<contextId>")
 *
 * Ciclo de vida del task:
 *   submitted → working → input-required   (Yisus es conversacional: tras cada
 *   respuesta espera el siguiente mensaje del usuario en el mismo task)
 *   failed en caso de error; canceled si el cliente cancela.
 */
import type { Runner } from '@google/adk';
import { TaskState } from '@a2a-js/sdk';
import {
    AgentEvent,
    type AgentExecutor,
    type ExecutionEventBus,
    type RequestContext,
} from '@a2a-js/sdk/server';
import type { RedisSessionService } from '../services/redis_session.service.js';
import { currentA2AScope } from '../config/channels.js';
import { agentMessage, extractText, status } from './helpers.js';
import { attachmentsService } from '../services/attachments.service.js';

const APP_NAME = process.env.ADK_APP_NAME || 'yisus';

export class YisusAgentExecutor implements AgentExecutor {
    /** taskId → contextId, para poder emitir el evento de cancelación. */
    private readonly contexts = new Map<string, string>();
    private readonly cancelled = new Set<string>();

    constructor(
        /** Devuelve el Runner correspondiente al alcance del token presentado */
        private readonly resolveRunner: (scope: { name: string; tools: string[] }) => Runner,
        private readonly sessionService: RedisSessionService,
    ) {}

    execute = async (ctx: RequestContext, bus: ExecutionEventBus): Promise<void> => {
        const { taskId, contextId } = ctx;
        this.contexts.set(taskId, contextId);

        const userText = extractText(ctx.userMessage);

        // El alcance lo dejó el middleware al validar el token; sin él no se ejecuta.
        const scope = currentA2AScope() || { name: 'sin-alcance', tools: [] };
        const runner = this.resolveRunner(scope);

        const userId =
            (ctx.userMessage?.metadata?.userId as string | undefined) ||
            `a2a:${contextId}`;

        // 1) Primer evento obligatorio: task
        bus.publish(AgentEvent.task({
            id:        taskId,
            contextId,
            status:    status(ctx.task ? TaskState.TASK_STATE_WORKING : TaskState.TASK_STATE_SUBMITTED),
            artifacts: ctx.task?.artifacts ?? [],
            history:   ctx.task?.history ?? [],
            metadata:  undefined,
        }));
        bus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status:   status(TaskState.TASK_STATE_WORKING),
            metadata: undefined,
        }));

        try {
            // 2) Sesión ADK persistida en Redis, keyed por contextId
            let session = await this.sessionService.getSession({
                appName: APP_NAME, userId, sessionId: contextId,
            });
            if (!session) {
                session = await this.sessionService.createSession({
                    appName: APP_NAME, userId, sessionId: contextId,
                });
            }

            // 3) Ejecutar el multi-agente ADK (Coordinator → faq/account/support)
            //    Si Jesús resolvió algo escalado desde esta conversación, se le dice primero.
            const { escalationDeliveryService } = await import('../services/escalation_delivery.service.js');
            const pendiente = escalationDeliveryService.consumePendingFor(contextId);
            const newMessage = { role: 'user', parts: [{ text: pendiente + userText }] } as any;
            const replies: string[] = [];
            let errorModelo = '';

            const { beginUsageScope, flushUsageScope } = await import('../utils/usage_collector.js');
            beginUsageScope('a2a', contextId, `[A2A:${scope.name}] ${userText}`);

            for await (const event of runner.runAsync({
                userId, sessionId: session.id, newMessage,
            })) {
                if (this.cancelled.has(taskId)) break;
                if ((event as any)?.errorMessage) errorModelo = (event as any).errorMessage;
                const parts = (event as any)?.content?.parts;
                const isPartial = (event as any)?.partial === true;
                if (Array.isArray(parts) && !isPartial && (event as any)?.author !== 'user') {
                    const text = parts
                        .map((p: any) => p?.text ?? '')
                        .filter(Boolean)
                        .join('');
                    if (text.trim()) replies.push(text);
                }
            }

            flushUsageScope().catch(() => {});

            if (this.cancelled.has(taskId)) {
                this.cancelled.delete(taskId);
                bus.publish(AgentEvent.statusUpdate({
                    taskId, contextId,
                    status:   status(TaskState.TASK_STATE_CANCELED),
                    metadata: undefined,
                }));
                return;
            }

            // 4) Respuesta final → input-required (conversación multi-turno)
            const finalText = replies.length
                ? attachmentsService.comoEnlaces(replies[replies.length - 1])
                : errorModelo
                    ? `⚠️ El modelo no pudo responder: ${errorModelo}`
                    : 'Lo siento, no pude generar una respuesta. ¿Puedes reformular tu consulta?';

            bus.publish(AgentEvent.statusUpdate({
                taskId, contextId,
                status:   status(
                    TaskState.TASK_STATE_INPUT_REQUIRED,
                    agentMessage(finalText, taskId, contextId),
                ),
                metadata: undefined,
            }));
        } catch (e: any) {
            bus.publish(AgentEvent.statusUpdate({
                taskId, contextId,
                status:   status(
                    TaskState.TASK_STATE_FAILED,
                    agentMessage(`Error interno de Yisus Agent: ${e?.message ?? 'desconocido'}`, taskId, contextId),
                ),
                metadata: undefined,
            }));
        } finally {
            bus.finished();
        }
    };

    cancelTask = async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
        this.cancelled.add(taskId);
        const contextId = this.contexts.get(taskId);
        if (contextId) {
            bus.publish(AgentEvent.statusUpdate({
                taskId, contextId,
                status:   status(TaskState.TASK_STATE_CANCELED),
                metadata: undefined,
            }));
        }
    };
}
