import { Router } from 'express';
import express from 'express';
import { adminGuard } from './admin_guard.js';
import { llmSettingsService, PRESETS, AGENTES_LLM } from '../services/llm_settings.service.js';
import { envSettingsService } from '../services/env_settings.service.js';
import { probarModelo } from '../agents/llm/model_factory.js';

/**
 * Ajustes de la GUI: proveedores LLM, modelo por agente y variables del .env.
 * Todo detrás del guard de administración (sesión de la GUI o ADMIN_API_KEY).
 */
export default function createSettingsRoutes() {
  const app = Router();
  app.use(express.json());
  app.use('/api/settings', adminGuard);

  // ─── Proveedores LLM ─────────────────────────────────────────────────────
  app.get('/api/settings/llm', (_req, res) => {
    res.json({
      presets: PRESETS,
      providers: llmSettingsService.listProviders(),
      agentes: llmSettingsService.describeAssignments(),
    });
  });

  app.post('/api/settings/llm/providers', (req, res) => {
    try {
      const p = llmSettingsService.saveProvider(req.body || {});
      res.json({ provider: { ...p, apiKey: undefined, tieneKey: !!p.apiKey } });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.put('/api/settings/llm/providers/:id', (req, res) => {
    try {
      if (!llmSettingsService.getProvider(req.params.id)) return res.status(404).json({ error: 'Proveedor no encontrado' });
      const p = llmSettingsService.saveProvider({ ...(req.body || {}), id: req.params.id });
      res.json({ provider: { ...p, apiKey: undefined, tieneKey: !!p.apiKey } });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/settings/llm/providers/:id', (req, res) => {
    llmSettingsService.deleteProvider(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/settings/llm/providers/:id/models', async (req, res) => {
    try {
      res.json({ models: await llmSettingsService.listModels(req.params.id) });
    } catch (err: any) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/settings/llm/providers/:id/test', async (req, res) => {
    const model = String(req.body?.model || '').trim();
    if (!model) return res.status(400).json({ error: 'Indica el modelo a probar' });
    res.json(await probarModelo(req.params.id, model));
  });

  // ─── Modelo por agente ───────────────────────────────────────────────────
  app.put('/api/settings/llm/assignments/:agent', (req, res) => {
    try {
      const body = req.body || {};
      llmSettingsService.setAssignment(req.params.agent, body.provider && body.model ? { provider: body.provider, model: body.model } : null);
      res.json({ agentes: llmSettingsService.describeAssignments() });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // Respaldo por agente (si el principal falla por cuota/caída) y respaldo global
  app.put('/api/settings/llm/assignments/:agent/fallback', (req, res) => {
    try {
      const body = req.body || {};
      llmSettingsService.setFallback(req.params.agent, body.provider && body.model ? { provider: body.provider, model: body.model } : null);
      res.json({ agentes: llmSettingsService.describeAssignments() });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.get('/api/settings/llm/fallback', (_req, res) => res.json({ fallback: llmSettingsService.getGlobalFallback() }));
  app.put('/api/settings/llm/fallback', (req, res) => {
    try {
      const body = req.body || {};
      llmSettingsService.setGlobalFallback(body.provider && body.model ? { provider: body.provider, model: body.model } : null);
      res.json({ fallback: llmSettingsService.getGlobalFallback(), agentes: llmSettingsService.describeAssignments() });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  /** Proveedores activos con sus modelos: para los selectores de tareas y webhooks. */
  app.get('/api/settings/llm/catalogo', async (_req, res) => {
    res.json({ providers: await llmSettingsService.catalogo() });
  });

  app.get('/api/settings/llm/agentes', (_req, res) => {
    res.json({ agentes: AGENTES_LLM });
  });

  // ─── Variables de entorno ────────────────────────────────────────────────
  app.get('/api/settings/env', (_req, res) => {
    res.json(envSettingsService.listar());
  });

  app.put('/api/settings/env', (req, res) => {
    try {
      const cambios = req.body?.cambios;
      if (!cambios || typeof cambios !== 'object') return res.status(400).json({ error: 'Falta "cambios"' });
      res.json(envSettingsService.guardar(cambios));
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/settings/restart', (_req, res) => {
    res.json(envSettingsService.reiniciar());
  });

  return app;
}
