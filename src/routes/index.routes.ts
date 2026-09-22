import { Router } from 'express';
import express from 'express';
import { Runner } from '@google/adk';
import { beginUsageScope, flushUsageScope } from '../utils/usage_collector.js';
import { USAGE_CHANNELS } from '../services/token_tracker.service.js';
import { RedisSessionService } from '../services/redis_session.service.js';
import { telegramBotService } from '../services/telegram_bot.service.js';
import { webhookService } from '../services/webhook.service.js';
import { customWebhookService } from '../services/custom_webhook.service.js';
import { tokenTrackerService } from '../services/token_tracker.service.js';
import { guardRutasInternas } from './admin_guard.js';

export default function createIndexRoutes(runner: Runner, sessionService: RedisSessionService) {
    const app = Router();

    // Antes de cualquier ruta: /run, /run_sse, /api/usage* y la administración de
    // webhooks estaban abiertas a internet. /run_sse corre el coordinator interno
    // completo (Gmail, Calendar, Drive), así que cualquiera con la URL podía
    // manejar la cuenta. La recepción de webhooks externos sigue siendo pública.
    app.use(guardRutasInternas);

    // Webhook de Telegram (Modo Webhook estilo Leygo)
    app.post('/webhook', express.json(), async (req, res) => {
        try {
            await telegramBotService.handleWebhookUpdate(req.body);
            res.status(200).send('OK');
        } catch (err: any) {
            console.error('❌ Error en webhook de Telegram:', err.message);
            res.status(500).send(err.message);
        }
    });

    // ─── Webhooks Manager (GitHub, GitLab, Sentry, Alertas) ───────────────────
    app.post('/webhooks/:provider', express.json(), async (req, res) => {
        const { provider } = req.params;
        const secret = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string);

        if (!webhookService.validateSecret(secret)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid webhook secret' });
        }

        const result = await webhookService.handleWebhook(provider, req.headers, req.body);
        if (result.status === 'error') {
            return res.status(500).json(result);
        }
        res.json(result);
    });

    app.get('/webhooks/recent', async (req, res) => {
        const limit = parseInt((req.query.limit as string) || '10', 10);
        const events = webhookService.getRecentEvents(limit);
        res.json({ events });
    });

    // ─── Webhooks Personalizados con IA (Estilo Leygo) ────────────────────────
    // Crear Webhook personalizado
    app.post('/api/webhooks', express.json(), async (req, res) => {
        try {
            const { titulo, instrucciones, modelo } = req.body;
            if (!titulo || !instrucciones) {
                return res.status(400).json({ error: 'titulo e instrucciones son obligatorios' });
            }
            const created = customWebhookService.createWebhook(titulo, instrucciones, modelo, req.get('host'));
            res.status(201).json({
                status: 'success',
                message: 'Webhook creado exitosamente',
                data: created,
                url: created.url,
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Listar Webhooks
    app.get('/api/webhooks', async (req, res) => {
        try {
            const webhooks = customWebhookService.listWebhooks(req.get('host'));
            res.json({ webhooks });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Obtener Webhook por ID
    app.get('/api/webhooks/:id', async (req, res) => {
        try {
            const wh = customWebhookService.getWebhook(req.params.id, req.get('host'));
            if (!wh) return res.status(404).json({ error: 'Webhook no encontrado' });
            res.json(wh);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Actualizar Webhook (título, instrucciones, modelo o pausado/reanudado)
    app.put('/api/webhooks/:id', express.json(), async (req, res) => {
        try {
            const updated = customWebhookService.updateWebhook(req.params.id, req.body, req.get('host'));
            if (!updated) return res.status(404).json({ error: 'Webhook no encontrado' });
            res.json(updated);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Eliminar Webhook
    app.delete('/api/webhooks/:id', async (req, res) => {
        try {
            const deleted = customWebhookService.deleteWebhook(req.params.id);
            if (!deleted) return res.status(404).json({ error: 'Webhook no encontrado' });
            res.json({ status: 'success', message: 'Webhook eliminado correctamente' });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Ver Logs del Webhook
    app.get('/api/webhooks/:id/logs', async (req, res) => {
        try {
            const limit = parseInt((req.query.limit as string) || '20', 10);
            const logs = customWebhookService.getLogs(req.params.id, limit);
            res.json({ logs });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Ejecutar Webhook vía HTTP POST (soporta tanto /api/webhook/:id como /webhook/:id)
    const handleCustomWebhookPost = async (req: express.Request, res: express.Response) => {
        const { id } = req.params;
        try {
            const result = await customWebhookService.executeWebhook(id, req.body, req.headers);
            if (result.status === 'not_found') {
                return res.status(404).json(result);
            }
            if (result.status === 'paused') {
                return res.status(403).json(result);
            }
            if (result.status === 'error') {
                return res.status(500).json(result);
            }
            res.json(result);
        } catch (err: any) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    };

    app.post('/api/webhook/:id', express.json(), handleCustomWebhookPost);
    app.post('/webhook/:id', express.json(), handleCustomWebhookPost);

    // ─── Token Tracker & Usage API (Leygo GUI Compatible) ────────────────────
    app.get('/api/usage', async (req, res) => {
        try {
            const limit = parseInt((req.query.limit as string) || '1000', 10);
            const summary = tokenTrackerService.getUsageSummary(limit);
            res.json(summary);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Historial paginado. La GUI antes traía 200 filas dentro del resumen y
    // mostraba 50: ni paginaba ni filtraba. Protegido por el guard (/api/usage/*).
    app.get('/api/usage/history', async (req, res) => {
        try {
            const { sqliteReminderService } = await import('../database/sqlite.service.js');
            const pagina = sqliteReminderService.getUsageHistoryPage({
                page:     parseInt((req.query.page as string) || '1', 10),
                pageSize: parseInt((req.query.pageSize as string) || '25', 10),
                channel:  (req.query.channel as string) || undefined,
                agent:    (req.query.agent as string) || undefined,
            });
            res.json({ ...pagina, facets: sqliteReminderService.getUsageFacets() });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/usage/budget', async (req, res) => {
        try {
            const channel = req.query.channel as any;
            if (channel) {
                return res.json(tokenTrackerService.getBudgetStatus(channel));
            }
            // Compatible con la GUI: el global en la raíz + el detalle por canal
            const status = tokenTrackerService.getBudgetStatus();
            res.json({
                ...status,
                channels: USAGE_CHANNELS.map((ch) => tokenTrackerService.getBudgetStatus(ch)),
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/usage/budget', express.json(), async (req, res) => {
        try {
            const { budgetUsd, channel } = req.body;
            if (typeof budgetUsd !== 'number' || budgetUsd < 0) {
                return res.status(400).json({ error: 'budgetUsd debe ser un número >= 0' });
            }
            if (budgetUsd === 0 && !channel) {
                return res.status(400).json({ error: 'El presupuesto global no puede ser 0' });
            }
            if (channel && !USAGE_CHANNELS.includes(channel)) {
                return res.status(400).json({ error: `channel debe ser uno de: ${USAGE_CHANNELS.join(', ')}` });
            }
            tokenTrackerService.setMonthlyBudget(budgetUsd, channel);
            const status = tokenTrackerService.getBudgetStatus(channel);
            res.json({ status: 'success', data: status });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/usage/refresh-pricing', async (_req, res) => {
        try {
            const updated = await tokenTrackerService.checkAndUpdatePricingInBackground(true);
            res.json({ status: 'success', updated });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Crear sesión
    app.post(
        '/apps/:appName/users/:userId/sessions',
        express.json(),
        async (req, res) => {
            const { appName, userId } = req.params;
            const { sessionId, state } = req.body ?? {};
            try {
                const session = await sessionService.createSession({
                    appName, userId, sessionId, state,
                });
                res.json(session);
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        }
    );

    // Listar sesiones
    app.get(
        '/apps/:appName/users/:userId/sessions',
        async (req, res) => {
            const { appName, userId } = req.params;
            const result = await sessionService.listSessions({ appName, userId });
            res.json(result);
        }
    );

    // Obtener sesión
    app.get(
        '/apps/:appName/users/:userId/sessions/:sessionId',
        async (req, res) => {
            const { appName, userId, sessionId } = req.params;
            const session = await sessionService.getSession({ appName, userId, sessionId });
            if (!session) return res.status(404).json({ error: 'Session not found' });
            res.json(session);
        }
    );

    // Eliminar sesión
    app.delete(
        '/apps/:appName/users/:userId/sessions/:sessionId',
        async (req, res) => {
            const { appName, userId, sessionId } = req.params;
            await sessionService.deleteSession({ appName, userId, sessionId });
            res.status(204).send();
        }
    );

    // Ejecutar agente (equivalente a POST /run del api_server nativo)
    app.post('/run', express.json(), async (req, res) => {
        const { appName, userId, sessionId, newMessage } = req.body;

        // Crear sesión si no existe
        let session = await sessionService.getSession({ appName, userId, sessionId });
        if (!session) {
            session = await sessionService.createSession({ appName, userId, sessionId });
        }

        const events: any[] = [];
        // el scope de uso se abre justo antes de correr el Runner
        const promptText = newMessage?.parts?.[0]?.text || 'API /run';

        try {
            beginUsageScope('api', sessionId, promptText);
            for await (const event of runner.runAsync({ userId, sessionId: session.id, newMessage })) {
                events.push(event);
            }

            flushUsageScope().catch(() => {});

            res.json({ events });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // Streaming SSE (equivalente a POST /run_sse)
    app.post('/run_sse', express.json(), async (req, res) => {
        const { appName, userId, sessionId, newMessage } = req.body;

        res.setHeader('Content-Type',  'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection',    'keep-alive');

        let session = await sessionService.getSession({ appName, userId, sessionId });
        if (!session) {
            session = await sessionService.createSession({ appName, userId, sessionId });
        }

        // el scope de uso se abre justo antes de correr el Runner
        const promptText = newMessage?.parts?.[0]?.text || 'API /run_sse';

        try {
            beginUsageScope('api', sessionId, promptText);
            for await (const event of runner.runAsync({ userId, sessionId: session.id, newMessage })) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            flushUsageScope().catch(() => {});
            res.write('data: [DONE]\n\n');
        } catch (e: any) {
            res.write(`data: ${JSON.stringify({ error: (e as any).message })}\n\n`);
        } finally {
            res.end();
        }
    });

    return app;
}