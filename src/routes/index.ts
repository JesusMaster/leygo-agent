import { Router } from 'express';
import { Runner } from '@google/adk';
import createIndexRoutes from './index.routes.js';
import createAdminRoutes from './admin.routes.js';
import createSettingsRoutes from './settings.routes.js';
import createCommitmentsRoutes from './commitments.routes.js';
import { RedisSessionService } from '../services/redis_session.service.js';

export default function createApiRoutes(runner: Runner, sessionService: RedisSessionService) {
    const router = Router();
    router.use('/', createAdminRoutes());
    router.use('/', createSettingsRoutes());
    router.use('/', createCommitmentsRoutes());
    router.use('/', createIndexRoutes(runner, sessionService));
    return router;
}
