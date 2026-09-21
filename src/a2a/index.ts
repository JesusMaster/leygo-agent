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
import { yisusAgentCard } from './card.js';
import { YisusAgentExecutor } from './executor.js';

function a2aAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const apiKey = process.env.A2A_API_KEY;
    // Sin API key el endpoint NO se monta (ver mountA2A), así que llegar acá sin
    // clave configurada solo puede ser un error de arranque: se rechaza.
    if (!apiKey) {
        res.status(503).json({ error: 'A2A deshabilitado: falta A2A_API_KEY' });
        return;
    }

    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const xApiKey = req.headers['x-api-key'] as string | undefined;

    if (bearer === apiKey || xApiKey === apiKey) return next();
    res.status(401).json({ error: 'Unauthorized: falta Bearer token o X-API-Key válido' });
}

export function mountA2A(
    app: express.Application,
    deps: { runner: Runner; sessionService: RedisSessionService },
): void {
    // Sin clave no se expone el RPC. Antes quedaba abierto y cualquiera conversaba
    // con el coordinator completo, que tiene Gmail, Drive y Chat.
    if (!process.env.A2A_API_KEY) {
        console.warn('🔒 [A2A] A2A_API_KEY no definida: el endpoint /a2a/v1 NO se monta. Define la variable para habilitarlo.');
        return;
    }

    const executor = new YisusAgentExecutor(deps.runner, deps.sessionService);
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
