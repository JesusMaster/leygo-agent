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
import { sqliteReminderService } from '../database/sqlite.service.js';
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
        try {
            const activos = sqliteReminderService.listA2ATokens().filter((t) => t.enabled);
            console.warn(
                `🔒 [A2A] Token rechazado (${presented ? presented.slice(0, 12) + '…' : 'ausente'}). ` +
                `Esta instancia tiene ${activos.length} token(s) activo(s): ${activos.map((t) => t.name).join(', ') || 'ninguno'}. ` +
                `Si el token existe en tu base pero acá aparece 0, el proceso que responde NO es el que crees.`
            );
        } catch (err: any) {
            console.warn(`🔒 [A2A] Token rechazado y además no se pudo leer la tabla de tokens: ${err.message}`);
        }
        res.status(401).json({
            error: presented
                ? 'Unauthorized: el token presentado no existe o fue revocado'
                : 'Unauthorized: falta Authorization: Bearer <token> o X-API-Key',
        });
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

    // El Agent Card y el RPC se montan SIEMPRE. Los tokens se crean y revocan en
    // caliente desde la GUI, así que decidir en el arranque si el endpoint existe
    // dejaba a A2A en 404 hasta el próximo reinicio. Quien decide es a2aAuth.
    if (tokensConfigurados.length === 0 && !process.env.A2A_API_KEY) {
        console.warn('🔒 [A2A] Sin tokens en config/channels.json ni A2A_API_KEY. El endpoint responde 401 hasta que crees uno en la GUI (Tokens A2A).');
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

    const rpcUrl = yisusAgentCard.supportedInterfaces?.[0]?.url;
    console.log(`✅ A2A montado — card pública en /.well-known/agent-card.json | rpc: /a2a/v1`);
    console.log(`   La card anuncia el RPC en: ${rpcUrl}`);
}
