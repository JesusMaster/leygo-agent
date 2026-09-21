import * as dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { createMongoDBConnector } from './database/mongo.js';
import { setMongoDBConnector } from './database/mongo/client.js';
import { createRedisConnector } from './database/redis.js';
import { Runner, InMemoryArtifactService, InMemoryMemoryService } from '@google/adk';
import { rootAgent } from './agents/agent.js';
import { RedisSessionService } from './services/redis_session.service.js';
import { telegramBotService } from './services/telegram_bot.service.js';
import { schedulerService } from './services/scheduler.service.js';

// Inicializar MongoDB si está configurado
if (process.env.MONGO_URI && mongoose.connection.readyState === 0) {
    const mongoConnector = createMongoDBConnector(process.env.MONGO_URI);
    mongoConnector.connect().then(() => {
        setMongoDBConnector(mongoConnector as any);
        console.log('✅ MongoDB inicializado para ADK');
    }).catch(console.error);
}

// Inicializar Redis Connector para ADK
createRedisConnector({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0')
});

const redisSessionService = new RedisSessionService();

// Iniciar Runner dedicado para Telegram y Scheduler conectado a Redis
const telegramRunner = new Runner({
    agent: rootAgent,
    appName: process.env.ADK_APP_NAME || 'yisus',
    sessionService: redisSessionService,
    artifactService: new InMemoryArtifactService(),
    memoryService: new InMemoryMemoryService(),
});

// El bot de Telegram y el scheduler los levanta src/index.ts. Si además se corre
// ADK Web (que carga este archivo), se duplican: dos long-pollings contra la misma
// cuenta de Telegram devuelven 409 Conflict y los cron corren dos veces.
// Se activan acá solo si se pide explícitamente.
if (process.env.ADK_START_SERVICES === 'true') {
    telegramBotService.start(telegramRunner, redisSessionService).catch(console.error);
    schedulerService.start();
} else {
    console.log('ℹ️ [ADK] Telegram y Scheduler no se inician desde adk.ts (los levanta src/index.ts). Usa ADK_START_SERVICES=true para forzarlo.');
}

export { rootAgent } from './agents/agent.js';
