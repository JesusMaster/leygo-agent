import { Router } from 'express';
import express from 'express';
import { adminGuard } from './admin_guard.js';
import { conProgreso, customAgentsService } from '../agents/custom/custom_agents.service.js';
import { builderAgent } from '../agents/builder.agent.js';
import { generarHerramienta, sugerirHerramientas } from '../agents/custom/tool_generator.js';
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

  /**
   * Igual que /generate pero en SSE: la GUI ve en vivo qué está haciendo el agente
   * programador (diseño, creación, tests por herramienta, correcciones, montaje).
   * Eventos: {type:'estado', texto, nivel} · {type:'paso', texto} · {type:'fin', respuesta, pasos, nuevos, agents} · {type:'error', error}
   */
  app.post('/api/agents/generate/stream', async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Falta la descripción del agente' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const emitir = (ev: any) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* cliente cerró */ } };
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* nada */ } }, 15000);

    const { Runner, InMemorySessionService } = await import('@google/adk');
    const sessions = new InMemorySessionService();
    const runner = new Runner({ appName: 'agent_builder', agent: builderAgent, sessionService: sessions });
    const session = await sessions.createSession({ appName: 'agent_builder', userId: 'gui' });
    beginUsageScope('api', `builder-${session.id}`, `[Builder] ${prompt.slice(0, 80)}`);
    const antes = new Set(customAgentsService.nombres());
    let texto = '';
    const pasos: string[] = [];
    const etiqueta = (call: any): string => {
      const a = call.args || {};
      switch (call.name) {
        case 'create_custom_agent': return `Creando ${a.displayName || a.name || 'el agente'} con ${Array.isArray(a.tools) ? a.tools.length : '?'} herramienta(s)${Array.isArray(a.tools) && a.tools.length ? ': ' + a.tools.map((t: any) => t?.name).filter(Boolean).join(', ') : ''}…`;
        case 'update_custom_agent': return `Corrigiendo ${a.displayName || a.name || 'el agente'}…`;
        case 'test_custom_tool': return `Probando a mano ${a.tool || 'una herramienta'} de ${a.agent || '?'}…`;
        case 'get_custom_agent': case 'list_custom_agents': return 'Revisando los agentes existentes…';
        case 'delete_custom_agent': return `Eliminando ${a.name}…`;
        default: return `Llamando ${call.name}…`;
      }
    };
    emitir({ type: 'estado', texto: 'Leyendo la petición y diseñando el agente (soul, herramientas, tests)…', nivel: 'info' });
    try {
      await conProgreso((msg, nivel) => emitir({ type: 'estado', texto: msg, nivel: nivel || 'info' }), async () => {
        for await (const ev of runner.runAsync({ userId: 'gui', sessionId: session.id, newMessage: { role: 'user', parts: [{ text: prompt }] } })) {
          for (const p of (ev as any).content?.parts || []) {
            if (p.functionCall) { pasos.push(`→ ${p.functionCall.name}`); emitir({ type: 'estado', texto: etiqueta(p.functionCall), nivel: 'info' }); }
            if (p.functionResponse) {
              const r = p.functionResponse.response || {};
              const resumen = String(r.result || r.message || '').replace(/\*\*/g, '').slice(0, 200);
              pasos.push(`← ${p.functionResponse.name}: ${resumen}`);
              if (r.status === 'error' || r.status === 'sin_permiso') emitir({ type: 'estado', texto: `Rechazado: ${resumen}. El programador corrige y reintenta…`, nivel: 'error' });
              else if (p.functionResponse.name === 'create_custom_agent' || p.functionResponse.name === 'update_custom_agent') emitir({ type: 'estado', texto: resumen || 'Listo', nivel: 'ok' });
            }
            if (p.text && (ev as any).author !== 'user' && !(ev as any).partial) texto += p.text;
          }
          if ((ev as any).errorMessage) { pasos.push(`⚠️ ${(ev as any).errorMessage}`); emitir({ type: 'estado', texto: `El modelo falló: ${(ev as any).errorMessage}`, nivel: 'error' }); }
        }
      });
      const nuevos = customAgentsService.nombres().filter((n) => !antes.has(n));
      emitir({ type: 'fin', respuesta: texto.trim(), pasos, nuevos, agents: customAgentsService.list() });
    } catch (err: any) {
      emitir({ type: 'error', error: err?.message || String(err) });
    } finally {
      clearInterval(keepAlive);
      flushUsageScope().catch(() => {});
      res.end();
    }
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
    const draft = req.body?.draft && typeof req.body.draft.code === 'string'
      ? { code: String(req.body.draft.code).slice(0, 50_000), network: !!req.body.draft.network } : undefined;
    try { res.json(await customAgentsService.probarTool(req.params.name, req.params.tool, req.body?.args || {}, draft)); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  /** Herramienta nueva con IA: devuelve un BORRADOR probado (no lo guarda; la GUI lo integra al guardar). */
  app.post('/api/agents/:name/tools/generate', async (req, res) => {
    const pedido = String(req.body?.pedido || '').trim();
    if (!pedido) return res.status(400).json({ error: 'Describe la herramienta que quieres' });
    beginUsageScope('api', `agent-tool-${req.params.name}`, `[Herramienta IA ${req.params.name}] ${pedido.slice(0, 80)}`);
    try { res.json(await generarHerramienta(req.params.name, pedido)); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
    finally { flushUsageScope().catch(() => {}); }
  });

  /** Herramientas recomendadas para el agente (se cachean por versión; ?refrescar=1 recalcula). */
  app.get('/api/agents/:name/tools/suggestions', async (req, res) => {
    beginUsageScope('api', `agent-sug-${req.params.name}`, `[Sugerencias ${req.params.name}]`);
    try { res.json({ sugerencias: await sugerirHerramientas(req.params.name, req.query.refrescar === '1') }); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
    finally { flushUsageScope().catch(() => {}); }
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
