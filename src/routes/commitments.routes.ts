import { Router } from 'express';
import express from 'express';
import { adminGuard } from './admin_guard.js';
import { commitmentsService } from '../services/commitments.service.js';
import { commitmentsBackfillService, commitmentsEnrichService } from '../services/commitments_backfill.service.js';
import type { CommitmentStatus } from '../database/sqlite.service.js';

const ESTADOS: CommitmentStatus[] = ['propuesto', 'pendiente', 'en_curso', 'hecho', 'cancelado', 'descartado'];

export default function createCommitmentsRoutes() {
  const app = Router();
  app.use(express.json());
  app.use('/api/commitments', adminGuard);

  app.get('/api/commitments', (req, res) => {
    const q = req.query as Record<string, string>;
    const status = q.status ? (q.status.split(',').filter((s) => ESTADOS.includes(s as any)) as CommitmentStatus[]) : undefined;
    const mine = q.mine === '1' ? true : q.mine === '0' ? false : undefined;
    res.json({
      hoy: new Date().toLocaleDateString('en-CA', { timeZone: process.env.SCHEDULER_TZ || 'America/Santiago' }),
      items: commitmentsService.listar({ status, mine, vencidos: q.vencidos === '1', sinFecha: q.sinFecha === '1', q: q.q || undefined, limit: parseInt(q.limit || '300', 10) }),
      stats: commitmentsService.stats(),
    });
  });

  app.get('/api/commitments/backfill', (_req, res) => res.json(commitmentsBackfillService.estado));
  app.post('/api/commitments/backfill', (req, res) => {
    res.json(commitmentsBackfillService.iniciar({ limite: req.body?.limite, desde: req.body?.desde }));
  });

  /** Simulación de dedup: qué pasaría con estos detectados, sin crear nada. */
  app.post('/api/commitments/dedup-check', async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const r = await commitmentsService.decidirDuplicados(items);
    res.json({ decisiones: r.map((x) => ({ title: x.d.title, resultado: x.dup ? `duplicado de [${x.dup.id}] ${x.dup.title}` : 'nuevo', via: x.via })) });
  });

  /** Cambio de estado en lote (p. ej. descartar propuestos antiguos tras un backfill). */
  app.post('/api/commitments/bulk', async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const status = req.body?.status as CommitmentStatus;
    if (!ids.length || !ESTADOS.includes(status)) return res.status(400).json({ error: 'Indica ids y un estado válido' });
    let n = 0;
    for (const id of ids) if (await commitmentsService.actualizar(id, { status }, 'jesus', req.body?.note || 'Cambio en lote')) n++;
    res.json({ actualizados: n });
  });

  /** Completa el contexto (detail) de los compromisos que no lo tienen, desde su fuente. */
  app.get('/api/commitments/enrich', (_req, res) => res.json(commitmentsEnrichService.estado));
  app.post('/api/commitments/enrich', (_req, res) => res.json(commitmentsEnrichService.iniciar()));

  app.get('/api/commitments/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    res.json({ items: await commitmentsService.buscar(q, { soloAbiertos: req.query.abiertos !== '0', limit: 20 }) });
  });

  app.post('/api/commitments', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Falta el título' });
      const c = await commitmentsService.crear({ title: b.title, detail: b.detail, owner: b.owner, counterpart: b.counterpart, due: b.due_date || b.due, priority: b.priority, status: b.status }, { type: 'manual' }, 'jesus');
      res.status(201).json({ item: c });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/commitments/:id', (req, res) => {
    const c = commitmentsService.obtener(req.params.id);
    if (!c) return res.status(404).json({ error: 'No existe' });
    res.json({ item: c, updates: commitmentsService.historial(req.params.id, 100) });
  });

  app.put('/api/commitments/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const cambios: any = {};
      for (const k of ['title', 'detail', 'owner', 'counterpart', 'due_date', 'status', 'priority']) if (b[k] !== undefined) cambios[k] = b[k];
      if (cambios.status && !ESTADOS.includes(cambios.status)) return res.status(400).json({ error: 'Estado inválido' });
      const c = await commitmentsService.actualizar(req.params.id, cambios, 'jesus', b.note);
      if (!c) return res.status(404).json({ error: 'No existe' });
      res.json({ item: c });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/commitments/:id/accept', async (req, res) => {
    const c = await commitmentsService.aceptar(req.params.id, req.body?.due_date || null, 'jesus');
    if (!c) return res.status(404).json({ error: 'No existe' });
    res.json({ item: c });
  });

  /** Avisa a la contraparte por los canales elegidos (chat, email, buzz, a2a, telegram). */
  app.post('/api/commitments/:id/notify', async (req, res) => {
    try {
      const r = await commitmentsService.notificar(req.params.id, req.body?.delivery || [], req.body?.message, 'jesus');
      res.json({ ...r, updates: commitmentsService.historial(req.params.id, 100) });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/commitments/:id/default-message', (req, res) => {
    const c = commitmentsService.obtener(req.params.id);
    if (!c) return res.status(404).json({ error: 'No existe' });
    if (req.query.kind === 'recordatorio') return res.json({ message: commitmentsService.mensajeRecordatorio(c) });
    const status = (req.query.status as string) || c.status;
    res.json({ message: commitmentsService.mensajePorDefecto({ ...c, status: status as any }) });
  });

  /** Friendly reminder automático: 1 día antes y cada día vencido, por los canales guardados. */
  app.put('/api/commitments/:id/reminder', (req, res) => {
    const c = commitmentsService.configurarRecordatorio(req.params.id, !!req.body?.auto, req.body?.delivery || null, 'jesus');
    if (!c) return res.status(404).json({ error: 'No existe' });
    res.json({ item: c });
  });

  app.post('/api/commitments/:id/notes', (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Falta el texto' });
    if (!commitmentsService.nota(req.params.id, text, 'jesus')) return res.status(404).json({ error: 'No existe' });
    res.json({ updates: commitmentsService.historial(req.params.id, 100) });
  });

  app.delete('/api/commitments/:id', async (req, res) => {
    res.json({ ok: await commitmentsService.eliminar(req.params.id) });
  });

  return app;
}
