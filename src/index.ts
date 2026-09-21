import { setMongoDBConnector } from './database/mongo/client.js';
import { MicroserviceServer } from 'micro-generate';
import { typeDefs, resolvers } from './features/index.js';
import * as dotenv from 'dotenv';
import { createRedisConnector } from './database/redis.js';
import express from 'express';
import createApiRoutes from './routes/index.js';
import { Runner, InMemoryArtifactService, InMemoryMemoryService } from '@google/adk';
import { buildChannelCoordinator } from './agents/agent.js';
import { buildPublicCoordinator } from './agents/public.agent.js';
import { RedisSessionService } from './services/redis_session.service.js';
import { telegramBotService } from './services/telegram_bot.service.js';
import { schedulerService } from './services/scheduler.service.js';
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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, Authorization, X-API-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/', createApiRoutes(runner, sessionService));
}

// A2A corre sobre el agente PÚBLICO, nunca sobre el coordinator interno, y con
// las herramientas que declare el token presentado. Un Runner por alcance, cacheado.
const a2aRunners = new Map<string, Runner>();
const resolveA2ARunner = (scope: { name: string; tools: string[] }) => {
    const key = `${scope.name}:${scope.tools.join(',')}`;
    let r = a2aRunners.get(key);
    if (!r) {
        console.log(`🧰 [A2A] Agente para el token "${scope.name}": ${scope.tools.length} herramienta(s) (${scope.tools.join(', ') || 'ninguna'})`);
        r = makeRunner(buildPublicCoordinator(scope.tools));
        a2aRunners.set(key, r);
    }
    return r;
};

mountA2A(app, { resolveRunner: resolveA2ARunner, sessionService });


server.start().then(async () => {
    if (server.getMongoDBConnector()) {
        setMongoDBConnector(server.getMongoDBConnector()! as any);
    }
    console.log('Server initialized');

    // Iniciar servicios en segundo plano: Bot de Telegram interactivo, Scheduler de tareas y Bridge Nostr (Buzz)
    await telegramBotService.start(telegramRunner, sessionService);
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
