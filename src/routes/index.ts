import { Router } from 'express';
import { Runner } from '@google/adk';
import createIndexRoutes from './index.routes.js';
import { RedisSessionService } from '../services/redis_session.service.js';

export default function createApiRoutes(runner: Runner, sessionService: RedisSessionService) {
    const router = Router();
    router.use('/', createIndexRoutes(runner, sessionService));
    return router;
}
