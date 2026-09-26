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
import { resolveA2AScope, runWithA2AScope, describeChannels } from '../config/channels.js';
import { sqliteReminderService } from '../database/sqlite.service.js';
import { yisusAgentCard } from './card.js';
import { YisusAgentExecutor } from './executor.js';

/**
 * Autenticación por token con ALCANCE: cada token declara en config/channels.json
 * qué herramientas puede usar. Un token desconocido no entra; uno conocido entra
 * únicamente con su set, que puede ser vacío (conversa, pero no ejecuta nada).
 */
function a2aAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    // El esquema es case-insensitive (RFC 7235): "bearer x" y "Bearer x" valen igual.
    const header = String(req.headers.authorization || '');
    const m = header.match(/^\s*bearer\s+(.+?)\s*$/i);
    const bearer = m ? m[1] : undefined;
    const xApiKey = (req.headers['x-api-key'] as string | undefined)?.trim();
    const presented = bearer || xApiKey;

    // Forma del token recibido, sin revelarlo: sirve para distinguir "copiado
    // truncado", "con comillas" o "con basura" de "token de otra instancia".
    const forma = presented
        ? {
            largo: presented.length,
            prefijo: presented.slice(0, 12),
            sufijo: presented.slice(-4),
            conFormaValida: /^yisus_[0-9a-f]{48}$/.test(presented),
          }
        : undefined;

    const scope = resolveA2AScope(presented);
    if (!scope) {
        try {
            const activos = sqliteReminderService.listA2ATokens().filter((t) => t.enabled);
            console.warn(
                `🔒 [A2A] Token rechazado (${forma ? `${forma.prefijo}…${forma.sufijo}, ${forma.largo} caracteres${forma.conFormaValida ? '' : ', FORMA INVÁLIDA: se esperaba yisus_ + 48 hex = 54 caracteres'}` : 'ausente'}).\n` +
                `         base de datos : ${sqliteReminderService.dbPath}\n` +
                `         pid / cwd     : ${process.pid} — ${process.cwd()}\n` +
                `         tokens activos: ${activos.length ? activos.map((t) => `${t.name} [${t.token.slice(0, 10)}…${t.token.slice(-4)}]`).join(', ') : 'ninguno'}\n` +
                `         Si el token existe en la consola pero acá no aparece, el proceso que responde lee OTRA base de datos.`
            );
        } catch (err: any) {
            console.warn(`🔒 [A2A] Token rechazado y además no se pudo leer la tabla de tokens: ${err.message}`);
        }
        // Pista opcional para el cliente. Apagada por defecto: revela cuántos
        // tokens conoce la instancia, que es justo el dato que distingue
        // "token inválido" de "instancia con otra base de datos".
        const pista = process.env.A2A_DEBUG_401 === 'true'
            ? (() => {
                try {
                    const activos = sqliteReminderService.listA2ATokens().filter((t) => t.enabled).length;
                    return activos === 0
                        ? 'Esta instancia no tiene NINGÚN token activo: probablemente lee otra base de datos que la consola donde se creó.'
                        : `Esta instancia conoce ${activos} token(s) activo(s), pero ninguno coincide con el presentado.`;
                } catch {
                    return 'No se pudo leer la tabla de tokens en esta instancia.';
                }
            })()
            : undefined;

        // Si el token llegó con forma inválida se dice siempre: no revela nada
        // (el cliente ya tiene el valor) y ahorra perseguir un fantasma.
        const detalle = forma && !forma.conFormaValida
            ? `El token recibido tiene ${forma.largo} caracteres (${forma.prefijo}…${forma.sufijo}); un token válido es "yisus_" + 48 hex = 54 caracteres, sin comillas ni puntos suspensivos.`
            : undefined;

        res.status(401).json({
            error: presented
                ? 'Unauthorized: el token presentado no existe o fue revocado'
                : 'Unauthorized: falta Authorization: Bearer <token> o X-API-Key',
            ...(detalle ? { detalle } : {}),
            ...(pista ? { pista } : {}),
        });
        return;
    }

    // El executor lee este alcance para construir el agente con esas herramientas.
    // `.run()` acota el alcance a esta petición (no queda pegado al socket keep-alive).
    runWithA2AScope(scope, () => next());
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
        // maxAge 0: la card cambia cuando se edita el techo del canal; con el default
        // (1 h) el navegador y los clientes seguían viendo las skills anteriores.
        // Queda "no-cache" + ETag: se revalida siempre y responde 304 si no cambió.
        agentCardHandler({ agentCardProvider: async () => yisusAgentCard, cache: { maxAge: 0 } }),
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
