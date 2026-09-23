import { Router } from 'express';
import express from 'express';
import { adminGuard } from './admin_guard.js';
import { customAgentsService } from '../agents/custom/custom_agents.service.js';
import { builderAgent } from '../agents/builder.agent.js';
import { beginUsageScope, flushUsageScope } from '../utils/usage_collector.js';

/** Agentes personalizados: CRUD, prueba, y creación con IA (agente programador). */
export default function createAgentsRoutes() {
  const app = Router();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/agents', adminGuard);

  app.get('/api/agents', (_req, res) => res.json({ agents: customAgentsService.list() }));

  /** Crea un agente a partir de una descripción, corriendo el agente programador de forma aislada. */
  app.post('/api/agents/generate', async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Falta la descripción del agente' });
    const { Runner, InMemorySessionService } = await import('@google/adk');
    const sessions = new InMemorySessionService();
    const runner = new Runner({ appName: 'agent_builder', agent: builderAgent, sessionService: sessions });
    const session = await sessions.createSession({ appName: 'agent_builder', userId: 'gui' });
    beginUsageScope('api', `builder-${session.id}`, `[Builder] ${prompt.slice(0, 80)}`);
    const antes = new Set(customAgentsService.nombres());
    let texto = '';
    const pasos: string[] = [];
    try {
      for await (const ev of runner.runAsync({ userId: 'gui', sessionId: session.id, newMessage: { role: 'user', parts: [{ text: prompt }] } })) {
        for (const p of (ev as any).content?.parts || []) {
          if (p.functionCall) pasos.push(`→ ${p.functionCall.name}`);
          if (p.functionResponse) pasos.push(`← ${p.functionResponse.name}: ${String(p.functionResponse.response?.result || p.functionResponse.response?.message || '').slice(0, 160)}`);
          if (p.text && (ev as any).author !== 'user' && !(ev as any).partial) texto += p.text;
        }
        if ((ev as any).errorMessage) pasos.push(`⚠️ ${(ev as any).errorMessage}`);
      }
    } finally {
      flushUsageScope().catch(() => {});
    }
    const nuevos = customAgentsService.nombres().filter((n) => !antes.has(n));
    res.json({ respuesta: texto.trim(), pasos, nuevos, agents: customAgentsService.list() });
  });

  app.get('/api/agents/:name', (req, res) => {
    const m = customAgentsService.get(req.params.name);
    if (!m) return res.status(404).json({ error: 'No existe' });
    res.json({ agent: m });
  });

  app.post('/api/agents', async (req, res) => {
    try {
      const { manifest } = await customAgentsService.crear({ ...(req.body || {}), createdBy: 'gui' });
      res.status(201).json({ agent: manifest });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.put('/api/agents/:name', async (req, res) => {
    try {
      const { manifest } = await customAgentsService.actualizar(req.params.name, req.body || {});
      res.json({ agent: manifest });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/agents/:name', (req, res) => {
    res.json({ ok: customAgentsService.eliminar(req.params.name) });
  });

  app.post('/api/agents/:name/tools/:tool/test', async (req, res) => {
    try { res.json(await customAgentsService.probarTool(req.params.name, req.params.tool, req.body?.args || {})); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  /** Conversación de prueba con el agente, sin pasar por el Coordinator. */
  app.post('/api/agents/:name/chat', async (req, res) => {
    const texto = String(req.body?.text || '').trim();
    if (!texto) return res.status(400).json({ error: 'Falta el texto' });
    beginUsageScope('api', `agent-test-${req.params.name}`, `[Prueba ${req.params.name}] ${texto.slice(0, 80)}`);
    try { res.json(await customAgentsService.conversar(req.params.name, texto)); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
    finally { flushUsageScope().catch(() => {}); }
  });

  return app;
}
