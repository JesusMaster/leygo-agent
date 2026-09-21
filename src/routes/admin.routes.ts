import { Router } from 'express';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { sqliteReminderService } from '../database/sqlite.service.js';
import { describeChannels, reloadChannelConfig, saveChannelTools } from '../config/channels.js';
import { allToolNames, TOOL_GROUPS, expandToolSpec } from '../agents/tool_catalog.js';
import { tokenTrackerService, USAGE_CHANNELS } from '../services/token_tracker.service.js';

/**
 * Endpoints que consume la GUI (yisus-gui).
 *
 * Protegidos por ADMIN_API_KEY: la GUI la envía en X-Admin-Key. Si la variable no
 * está definida se permite el paso (desarrollo local) pero se avisa fuerte, porque
 * acá se crean y revocan los tokens de A2A.
 */
function adminGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return next();

  const presented = (req.headers['x-admin-key'] as string) ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (presented && presented === expected) return next();
  res.status(401).json({ error: 'No autorizado: falta X-Admin-Key' });
}

export default function createAdminRoutes() {
  const app = Router();

  if (!process.env.ADMIN_API_KEY) {
    console.warn('⚠️ [Admin] ADMIN_API_KEY no definida: los endpoints de administración quedan SIN autenticación. Defínela antes de exponer el puerto.');
  }

  app.use(express.json());

  // OJO: el guard va montado por PREFIJO, no global. Antes se aplicaba a todo
  // Express y bloqueaba /.well-known/agent-card.json y /a2a/v1, que tienen su
  // propio esquema de autenticación (Bearer por token A2A) o son públicos por spec.
  for (const prefijo of ['/api/admin', '/api/channels', '/api/a2a', '/api/escalations', '/api/reminders', '/api/budgets']) {
    app.use(prefijo, adminGuard);
  }

  // ─── Sesión de la GUI ────────────────────────────────────────────────────

  /**
   * Público a propósito: solo dice que el backend está vivo y si exige clave.
   * Si esto estuviera detrás del guard, la GUI no podría distinguir "backend
   * caído" de "me falta la clave", que es justo lo que necesita explicar.
   */
  app.get('/api/status', (_req, res) => {
    res.json({
      status: 'ok',
      protegido: !!process.env.ADMIN_API_KEY,
      agente: process.env.ADK_APP_NAME || 'yisus',
    });
  });

  /** Este SÍ va protegido: sirve para validar que la clave cargada es correcta. */
  app.get('/api/admin/me', (_req, res) => {
    res.json({
      status: 'ok',
      autenticado: true,
      protegido: !!process.env.ADMIN_API_KEY,
      agente: process.env.ADK_APP_NAME || 'yisus',
    });
  });

  // ─── Catálogo y configuración por canal ──────────────────────────────────
  app.get('/api/channels', (_req, res) => {
    res.json({ catalogo: allToolNames(), grupos: TOOL_GROUPS, canales: describeChannels() });
  });

  app.put('/api/channels/:channel', (req, res) => {
    const channel = req.params.channel as 'telegram' | 'buzz' | 'api';
    if (!['telegram', 'buzz', 'api'].includes(channel)) {
      return res.status(400).json({ error: 'Canal inválido. Usa telegram, buzz o api.' });
    }
    const tools: string[] = req.body?.tools;
    if (!Array.isArray(tools)) {
      return res.status(400).json({ error: 'Se espera { tools: string[] }' });
    }
    saveChannelTools(channel, tools);
    res.json({
      status: 'success',
      canal: channel,
      tools: expandToolSpec(tools),
      aviso: 'Los agentes de Telegram, Buzz y API se construyen al arrancar: el cambio aplica al reiniciar el servicio.',
    });
  });

  app.post('/api/channels/reload', (_req, res) => {
    reloadChannelConfig();
    res.json({ status: 'success', canales: describeChannels() });
  });

  // ─── Tokens A2A ──────────────────────────────────────────────────────────
  // El valor del token se muestra UNA sola vez, al crearlo.
  app.get('/api/a2a/tokens', (_req, res) => {
    const tokens = sqliteReminderService.listA2ATokens().map((t) => ({
      name: t.name,
      tools: expandToolSpec(t.tools),
      enabled: t.enabled,
      created_at: t.created_at,
      last_used_at: t.last_used_at,
      preview: `${t.token.slice(0, 6)}…${t.token.slice(-4)}`,
    }));
    res.json({ tokens });
  });

  app.post('/api/a2a/tokens', (req, res) => {
    const { name, tools } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Falta el nombre del token' });
    }
    if (sqliteReminderService.listA2ATokens().some((t) => t.name === name)) {
      return res.status(409).json({ error: `Ya existe un token llamado "${name}"` });
    }

    const token = `yisus_${randomBytes(24).toString('hex')}`;
    sqliteReminderService.createA2AToken(name, token, Array.isArray(tools) ? tools : []);

    res.json({
      status: 'success',
      name,
      token, // única vez que se devuelve completo
      tools: expandToolSpec(tools || []),
      aviso: 'Guarda este token ahora: no se vuelve a mostrar.',
    });
  });

  app.patch('/api/a2a/tokens/:name', (req, res) => {
    const { tools, enabled } = req.body || {};
    const ok = sqliteReminderService.updateA2AToken(req.params.name, { tools, enabled });
    if (!ok) return res.status(404).json({ error: 'Token no encontrado' });
    res.json({ status: 'success' });
  });

  app.delete('/api/a2a/tokens/:name', (req, res) => {
    const ok = sqliteReminderService.deleteA2AToken(req.params.name);
    if (!ok) return res.status(404).json({ error: 'Token no encontrado' });
    res.json({ status: 'success' });
  });

  /**
   * Diagnóstico de A2A: responde QUÉ ve esta instancia concreta.
   *
   * Existe porque un 401 de token puede significar dos cosas muy distintas — token
   * inválido, o instancia mirando otra base de datos — y desde afuera son
   * indistinguibles. Se consulta contra el dominio público para interrogar al
   * proceso que realmente atiende, no al que uno cree que atiende.
   */
  app.get('/api/a2a/diagnostico', (req, res) => {
    const tokens = sqliteReminderService.listA2ATokens();
    const aProbar = (req.query.token as string) || '';

    res.json({
      baseDeDatos: sqliteReminderService.dbPath,
      directorioDeTrabajo: process.cwd(),
      pid: process.pid,
      tokensEnEstaInstancia: tokens.map((t) => ({
        name: t.name,
        preview: `${t.token.slice(0, 12)}…${t.token.slice(-4)}`,
        enabled: t.enabled,
        tools: t.tools.length,
      })),
      pruebaDeToken: aProbar
        ? (() => {
            const encontrado = tokens.find((t) => t.token === aProbar);
            if (!encontrado) return 'NO existe en esta instancia';
            return encontrado.enabled ? `OK: "${encontrado.name}"` : `existe pero está REVOCADO: "${encontrado.name}"`;
          })()
        : 'no se pasó ?token=… para probar',
    });
  });

  // ─── Escalamientos del triage ────────────────────────────────────────────
  app.get('/api/escalations', (req, res) => {
    const status = (req.query.status as string) || undefined;
    const limit = parseInt((req.query.limit as string) || '50', 10);
    res.json({ escalations: sqliteReminderService.listEscalations(status, limit) });
  });

  app.post('/api/escalations/:id/resolve', (req, res) => {
    const { resolution, status } = req.body || {};
    const ok = sqliteReminderService.resolveEscalation(req.params.id, resolution || '', status || 'resuelto');
    if (!ok) return res.status(404).json({ error: 'Escalamiento no encontrado' });
    res.json({ status: 'success' });
  });

  // ─── Recordatorios programados ───────────────────────────────────────────
  app.get('/api/reminders', (_req, res) => {
    res.json({ reminders: sqliteReminderService.getPendingReminders() });
  });

  // ─── Presupuestos por canal ──────────────────────────────────────────────
  app.get('/api/budgets', (_req, res) => {
    res.json({
      global: tokenTrackerService.getBudgetStatus(),
      canales: USAGE_CHANNELS.map((ch) => tokenTrackerService.getBudgetStatus(ch)),
    });
  });

  return app;
}
