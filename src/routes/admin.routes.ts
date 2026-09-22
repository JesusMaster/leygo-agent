import { Router } from 'express';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { sqliteReminderService } from '../database/sqlite.service.js';
import { describeChannels, reloadChannelConfig, saveChannelTools, getToolsDisponiblesA2A, saveToolsDisponiblesA2A } from '../config/channels.js';
import { allToolNames, TOOL_GROUPS, expandToolSpec, grupoDeTool } from '../agents/tool_catalog.js';
import { describirTool } from '../a2a/card.js';
import { scheduledTasksService } from '../services/scheduled_tasks.service.js';
import { tokenTrackerService, USAGE_CHANNELS } from '../services/token_tracker.service.js';
import { adminGuard } from './admin_guard.js';

/**
 * Endpoints que consume la GUI (yisus-gui).
 *
 * Protegidos por ADMIN_API_KEY: la GUI la envía en X-Admin-Key. Si la variable no
 * está definida se permite el paso (desarrollo local) pero se avisa fuerte, porque
 * acá se crean y revocan los tokens de A2A. El guard es el mismo que usa
 * index.routes.ts, para que no se separen con el tiempo.
 */

export default function createAdminRoutes() {
  const app = Router();

  if (!process.env.ADMIN_API_KEY) {
    console.warn('⚠️ [Admin] ADMIN_API_KEY no definida: /run, /run_sse, /api/usage* y la administración quedan SIN autenticación. Defínela antes de exponer el puerto.');
  }

  app.use(express.json());

  // OJO: el guard va montado por PREFIJO, no global. Antes se aplicaba a todo
  // Express y bloqueaba /.well-known/agent-card.json y /a2a/v1, que tienen su
  // propio esquema de autenticación (Bearer por token A2A) o son públicos por spec.
  for (const prefijo of ['/api/admin', '/api/channels', '/api/a2a', '/api/escalations', '/api/reminders', '/api/tasks', '/api/budgets']) {
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
  /**
   * Techo del canal A2A: qué herramientas se montan en el agente público.
   * Un token solo puede conceder algo que esté acá.
   */
  app.get('/api/a2a/disponibles', (_req, res) => {
    const catalogo = allToolNames();
    res.json({
      disponibles: getToolsDisponiblesA2A(),
      catalogo,
      // Para que la GUI muestre una tabla con nombre y descripción en vez de chips.
      detalle: catalogo.map((name) => ({ name, ...describirTool(name), ...grupoDeTool(name) })),
    });
  });

  app.put('/api/a2a/disponibles', (req, res) => {
    const tools: string[] = req.body?.tools;
    if (!Array.isArray(tools)) return res.status(400).json({ error: 'Se espera { tools: string[] }' });
    saveToolsDisponiblesA2A(tools);
    res.json({
      status: 'success',
      disponibles: getToolsDisponiblesA2A(),
      aviso: 'El agente público se arma al arrancar: aplica al reiniciar el servicio.',
    });
  });

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

    const pedidas = expandToolSpec(Array.isArray(tools) ? tools : []);
    const techo = getToolsDisponiblesA2A();
    const permitidas = pedidas.filter((t) => techo.includes(t));
    const descartadas = pedidas.filter((t) => !techo.includes(t));

    const token = `yisus_${randomBytes(24).toString('hex')}`;
    sqliteReminderService.createA2AToken(name, token, permitidas);

    res.json({
      status: 'success',
      name,
      token, // única vez que se devuelve completo
      tools: permitidas,
      descartadas,
      aviso: descartadas.length
        ? `Guarda este token ahora: no se vuelve a mostrar. Estas no las ofrece el canal A2A y se descartaron: ${descartadas.join(', ')}.`
        : 'Guarda este token ahora: no se vuelve a mostrar.',
    });
  });

  app.patch('/api/a2a/tokens/:name', (req, res) => {
    const { tools, enabled } = req.body || {};
    const techo = getToolsDisponiblesA2A();
    const filtradas = tools !== undefined ? expandToolSpec(tools).filter((t) => techo.includes(t)) : undefined;
    const ok = sqliteReminderService.updateA2AToken(req.params.name, { tools: filtradas, enabled });
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
  /** Compatibilidad: los recordatorios ahora son tareas de una vez. */
  app.get('/api/reminders', (_req, res) => {
    const reminders = scheduledTasksService.list()
      .filter((t) => t.kind === 'once' && t.status === 'active')
      .map((t) => ({ id: t.id, target_time: t.run_at, message: t.message, status: 'pending', created_at: t.created_at }));
    res.json({ reminders });
  });

  // ─── Tareas programadas ──────────────────────────────────────────────────
  app.get('/api/tasks', (_req, res) => {
    res.json({ tasks: scheduledTasksService.list() });
  });

  app.post('/api/tasks', (req, res) => {
    try {
      const { message, autonomous, kind, run_at, interval_minutes, time_of_day, cron_expr, channel, target } = req.body || {};
      if (!message || typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'Falta el mensaje o instrucción' });
      if (!kind) return res.status(400).json({ error: 'Falta el tipo de tarea (kind)' });
      const tarea = scheduledTasksService.create({ message, autonomous: !!autonomous, kind, run_at, interval_minutes, time_of_day, cron_expr, channel, target });
      res.status(201).json({ status: 'success', task: tarea });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/tasks/:id', (req, res) => {
    try {
      const tarea = scheduledTasksService.update(req.params.id, req.body || {});
      if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada' });
      res.json({ status: 'success', task: tarea });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const ok = scheduledTasksService.delete(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json({ status: 'success' });
  });

  app.post('/api/tasks/:id/run', async (req, res) => {
    try {
      const run = await scheduledTasksService.runNow(req.params.id);
      if (!run) return res.status(404).json({ error: 'Tarea no encontrada' });
      res.json({ status: 'success', run });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Destinos posibles para entregar una tarea: espacios de Google Chat y
   * canales de Buzz. Va detrás del guard de admin (no pasa por el 2FA de las
   * herramientas: acá el que consulta es el administrador de la GUI).
   */
  app.get('/api/tasks/destinos', async (_req, res) => {
    const out: { chat: Array<{ name: string; displayName: string }>; buzz: string[]; email: string | null; errores: string[] } =
      { chat: [], buzz: [], email: process.env.GOOGLE_USER_EMAIL || process.env.USER_EMAIL || null, errores: [] };
    try {
      const { googleService } = await import('../services/google.service.js');
      const espacios = await googleService.listChatSpaces(50);
      out.chat = espacios.filter((e) => e.name).map((e) => ({ name: e.name!, displayName: e.displayName }));
      if (googleService.ultimoErrorMiembrosChat) out.errores.push(`Participantes de Chat: ${googleService.ultimoErrorMiembrosChat}`);
      if (!out.email) out.email = await googleService.getUserEmail();
    } catch (err: any) {
      out.errores.push(`Google Chat: ${err.message}`);
    }
    try {
      const { nostrGatewayService } = await import('../services/nostr_gateway.service.js');
      out.buzz = nostrGatewayService.getStatus().channels;
    } catch (err: any) {
      out.errores.push(`Buzz: ${err.message}`);
    }
    res.json(out);
  });

  app.get('/api/tasks/:id/runs', (req, res) => {
    const limit = parseInt((req.query.limit as string) || '20', 10);
    res.json({ runs: scheduledTasksService.runs(req.params.id, limit) });
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
