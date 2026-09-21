import { setMongoDBConnector } from './database/mongo/client.js';
import { MicroserviceServer } from 'micro-generate';
import { typeDefs, resolvers } from './features/index.js';
import * as dotenv from 'dotenv';
import { createRedisConnector } from './database/redis.js';
import express from 'express';
import createApiRoutes from './routes/index.js';
import { Runner, InMemoryArtifactService, InMemoryMemoryService } from '@google/adk';
import { rootAgent } from './agents/agent.js';
import { publicCoordinator } from './agents/public.agent.js';
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

const runner = new Runner({
    agent:           rootAgent,
    appName:         process.env.ADK_APP_NAME || 'yisus',
    sessionService,
    artifactService: new InMemoryArtifactService(),
    memoryService:   new InMemoryMemoryService(),
});


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
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/', createApiRoutes(runner, sessionService));
}

// A2A corre sobre un agente PÚBLICO restringido (solo conocimiento y FAQs),
// nunca sobre el coordinator interno que tiene acceso a Gmail, Drive y Chat.
const publicRunner = new Runner({
    agent:           publicCoordinator,
    appName:         `${process.env.ADK_APP_NAME || 'yisus'}-public`,
    sessionService,
    artifactService: new InMemoryArtifactService(),
    memoryService:   new InMemoryMemoryService(),
});

mountA2A(app, { runner: publicRunner, sessionService });


server.start().then(async () => {
    if (server.getMongoDBConnector()) {
        setMongoDBConnector(server.getMongoDBConnector()! as any);
    }
    console.log('Server initialized');

    // Iniciar servicios en segundo plano: Bot de Telegram interactivo, Scheduler de tareas y Bridge Nostr (Buzz)
    await telegramBotService.start(runner, sessionService);
    schedulerService.start();

    if (process.env.NOSTR_ENABLED !== 'false') {
        await nostrGatewayService.start(runner, sessionService);
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
