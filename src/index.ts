import { setMongoDBConnector } from './database/mongo/client.js';
import { MicroserviceServer } from 'micro-generate';
import { typeDefs, resolvers } from './features/index.js';
import * as dotenv from 'dotenv';
import { createRedisConnector } from './database/redis.js';
import express from 'express';
import createApiRoutes from './routes/index.js';
import { Runner, InMemoryArtifactService, InMemoryMemoryService } from '@google/adk';
import { instalarLoggerAdk } from './utils/adk_logger.js';
instalarLoggerAdk();
import { buildChannelCoordinator } from './agents/agent.js';
import { buildPublicCoordinator } from './agents/public.agent.js';
import { conModelo } from './agents/llm/model_factory.js';
import { RedisSessionService } from './services/redis_session.service.js';
import { telegramBotService } from './services/telegram_bot.service.js';
import { schedulerService } from './services/scheduler.service.js';
import { scheduledTasksService } from './services/scheduled_tasks.service.js';
import { beginUsageScope, flushUsageScope } from './utils/usage_collector.js';
import { mountA2A } from './a2a/index.js';
import { nostrGatewayService } from './services/nostr_gateway.service.js';


dotenv.config();

const redisConnector = createRedisConnector({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0')
});

const sessionService = new RedisSessionService();

const APP_NAME = process.env.ADK_APP_NAME || 'yisus';

/** Cada canal corre con su propio set de herramientas (config/channels.json) */
const makeRunner = (agent: any) => new Runner({
    agent,
    appName:         APP_NAME,
    sessionService,
    artifactService: new InMemoryArtifactService(),
    memoryService:   new InMemoryMemoryService(),
});

const runner         = makeRunner(buildChannelCoordinator('api'));
const telegramRunner = makeRunner(buildChannelCoordinator('telegram'));
const buzzRunner     = makeRunner(buildChannelCoordinator('buzz'));


const server = new MicroserviceServer({
  mongoUri: process.env.MONGO_URI || '',
  port: parseInt(process.env.PORT || '4000'),
  redisConnector: redisConnector,
  playground: process.env.GRAPHQL_PLAYGROUND === 'true',
  introspection: process.env.GRAPHQL_INTROSPECTION === 'true',
  federation: process.env.GRAPHQL_FEDERATION === 'true',
  graphqlPath: process.env.GRAPHQL_PATH || '/graphql',
  typeDefs,
  resolvers,
});

const app = (server as any).app as express.Application;
if (app) {
  // CORS para yisus-gui. Por defecto solo orígenes locales: la GUI administra
  // tokens de A2A, así que abrirla a cualquier origen sería regalar esa superficie.
  const origenesPermitidos = (process.env.GUI_ORIGIN || 'http://localhost:4200,http://127.0.0.1:4200')
    .split(',').map((o) => o.trim()).filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (origenesPermitidos.includes('*') || origenesPermitidos.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, Authorization, X-API-Key, A2A-Version, A2A-Extensions');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: '25mb' })); // adjuntos del chat viajan inline (base64)
  app.use(express.urlencoded({ extended: true }));
  app.use('/', createApiRoutes(runner, sessionService));
}

// A2A corre sobre el agente PÚBLICO, nunca sobre el coordinator interno.
// Un solo runner para todos los tokens: monta las herramientas disponibles del
// canal y el permiso se verifica en cada invocación contra el alcance del token.
const publicRunner = makeRunner(buildPublicCoordinator());

mountA2A(app, { resolveRunner: () => publicRunner, sessionService });


server.start().then(async () => {
    if (server.getMongoDBConnector()) {
        setMongoDBConnector(server.getMongoDBConnector()! as any);
    }
    console.log('Server initialized');

    // Iniciar servicios en segundo plano: Bot de Telegram interactivo, Scheduler de tareas y Bridge Nostr (Buzz)
    await telegramBotService.start(telegramRunner, sessionService);

    // Las tareas autónomas corren con el mismo coordinator que Telegram (mismas
    // herramientas, mismo 2FA) y se contabilizan en el canal "system".
    scheduledTasksService.setAgentRunner(async (instruccion, taskId, modelo) => {
        const appName = APP_NAME;
        const userId = 'jesus';
        const sessionId = `task-${taskId}`;
        let session = await sessionService.getSession({ appName, userId, sessionId });
        if (!session) session = await sessionService.createSession({ appName, userId, sessionId });

        const hoy = new Date().toLocaleString('es-CL', { timeZone: process.env.SCHEDULER_TZ || 'America/Santiago', dateStyle: 'full', timeStyle: 'short' });
        const prompt = `[Tarea programada — ${hoy}] ${instruccion}\n\nEjecuta la tarea ahora y responde con el resultado, sin pedir confirmación ni hacer preguntas.`;

        beginUsageScope('system', sessionId, `[Tarea] ${instruccion.slice(0, 80)}`);
        let texto = '';
        let errorModelo = '';
        // La tarea puede fijar su propio proveedor/modelo para el Coordinator (como los webhooks).
        await conModelo('Coordinator', modelo, async () => {
            for await (const event of telegramRunner.runAsync({ userId, sessionId: session.id, newMessage: { role: 'user', parts: [{ text: prompt }] } })) {
                if ((event as any).errorMessage) errorModelo = (event as any).errorMessage;
                for (const part of event.content?.parts || []) {
                    if (part.text && event.author !== 'user') texto += part.text;
                }
            }
        });
        flushUsageScope().catch(() => {});
        if (!texto.trim() && errorModelo) throw new Error(`El modelo no pudo responder: ${errorModelo}`);
        return texto.trim() || 'Listo. La tarea se ejecutó sin respuesta adicional.';
    });

    schedulerService.start();

    if (process.env.NOSTR_ENABLED !== 'false') {
        await nostrGatewayService.start(buzzRunner, sessionService);
    }
});

const gracefulShutdown = async () => {
    console.log('Starting graceful shutdown...');
    telegramBotService.stop();
    schedulerService.stop();
    nostrGatewayService.stop();
    await server.stop();
    console.log('Graceful shutdown complete.');
    process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
