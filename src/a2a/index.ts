/**
 * Montaje del protocolo A2A (spec 1.0, JSON-RPC) sobre el Express existente.
 *
 *   GET  /.well-known/agent-card.json  → Agent Card (descubrimiento, sin auth)
 *   POST /a2a/v1                       → JSON-RPC: message/send, message/stream,
 *                                        tasks/get, tasks/cancel, ...
 *
 * Auth: si A2A_API_KEY está definida, se exige `Authorization: Bearer <key>`
 * o `X-API-Key: <key>` en /a2a/v1. Sin la variable, el endpoint queda abierto
 * (útil en desarrollo local).
 */
import express from 'express';
import type { Runner } from '@google/adk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { RedisSessionService } from '../services/redis_session.service.js';
import { resolveA2AScope, setCurrentA2AScope, describeChannels } from '../config/channels.js';
import { yisusAgentCard } from './card.js';
import { YisusAgentExecutor } from './executor.js';

/**
 * Autenticación por token con ALCANCE: cada token declara en config/channels.json
 * qué herramientas puede usar. Un token desconocido no entra; uno conocido entra
 * únicamente con su set, que puede ser vacío (conversa, pero no ejecuta nada).
 */
function a2aAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const xApiKey = req.headers['x-api-key'] as string | undefined;
    const presented = bearer || xApiKey;

    const scope = resolveA2AScope(presented);
    if (!scope) {
        res.status(401).json({ error: 'Unauthorized: token ausente o sin alcance configurado' });
        return;
    }

    // El executor lee este alcance para construir el agente con esas herramientas
    setCurrentA2AScope(scope);
    next();
}

export function mountA2A(
    app: express.Application,
    deps: { resolveRunner: (scope: { name: string; tools: string[] }) => Runner; sessionService: RedisSessionService },
): void {
    const cfg = describeChannels();
    const tokensConfigurados = cfg.a2a.tokens.filter((t) => t.configurado);

    // Sin ningún token válido el RPC no se expone: antes quedaba abierto y
    // cualquiera conversaba con el coordinator completo (Gmail, Drive, Chat).
    if (tokensConfigurados.length === 0 && !process.env.A2A_API_KEY) {
        console.warn('🔒 [A2A] Sin tokens configurados (config/channels.json ni A2A_API_KEY): el endpoint /a2a/v1 NO se monta.');
        return;
    }

    for (const t of tokensConfigurados) {
        console.log(`🔑 [A2A] Token "${t.name}" habilitado con ${t.tools.length} herramienta(s): ${t.tools.join(', ') || 'ninguna'}`);
    }
    if (process.env.A2A_API_KEY) {
        console.log(`🔑 [A2A] A2A_API_KEY activa con el alcance por defecto: ${cfg.a2a.defaultTools.join(', ') || 'ninguna herramienta'}`);
    }

    const executor = new YisusAgentExecutor(deps.resolveRunner, deps.sessionService);
    const requestHandler = new DefaultRequestHandler(
        yisusAgentCard,
        new InMemoryTaskStore(),
        executor,
    );

    // Descubrimiento (público por diseño del protocolo)
    app.use(
        '/.well-known/agent-card.json',
        agentCardHandler({ agentCardProvider: async () => yisusAgentCard }),
    );

    // Endpoint JSON-RPC del protocolo
    app.use(
        '/a2a/v1',
        a2aAuth,
        express.json(),
        jsonRpcHandler({
            requestHandler,
            userBuilder: UserBuilder.noAuthentication,
        }),
    );

    console.log('✅ A2A protocol montado — card: /.well-known/agent-card.json | rpc: /a2a/v1');
}
