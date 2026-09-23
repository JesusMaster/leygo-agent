import { qdrantService, QdrantKnowledgeService } from './qdrant.service.js';
import { sqliteReminderService } from '../database/sqlite.service.js';
import { commitmentsService, parsearTareas, linkGmail, linkChat, type Detectado } from './commitments.service.js';
import { generarTexto } from '../agents/llm/model_factory.js';
import { beginUsageScope, flushUsageScope } from '../utils/usage_collector.js';

/**
 * Backfill: recorre lo que ya está en la memoria episódica (Meet, Chat, Gmail)
 * y convierte sus tareas/acuerdos en compromisos "propuestos".
 *
 * Idempotente: cada punto procesado queda anotado en system_config
 * (commitments.backfill.<pointId>), así se puede relanzar sin duplicar.
 * Corre en segundo plano; el estado se consulta por /api/commitments/backfill.
 */
export interface BackfillEstado {
  corriendo: boolean;
  iniciado: number | null;
  terminado: number | null;
  puntos: number;
  procesados: number;
  saltados: number;
  nuevos: number;
  repetidos: number;
  error: string | null;
  ultimo: string | null;
}

class CommitmentsBackfillService {
  estado: BackfillEstado = { corriendo: false, iniciado: null, terminado: null, puntos: 0, procesados: 0, saltados: 0, nuevos: 0, repetidos: 0, error: null, ultimo: null };

  iniciar(opts: { limite?: number; desde?: string } = {}): BackfillEstado {
    if (this.estado.corriendo) return this.estado;
    this.estado = { corriendo: true, iniciado: Date.now(), terminado: null, puntos: 0, procesados: 0, saltados: 0, nuevos: 0, repetidos: 0, error: null, ultimo: null };
    this.correr(opts).catch((err) => { this.estado.error = err?.message || String(err); }).finally(() => { this.estado.corriendo = false; this.estado.terminado = Date.now(); });
    return this.estado;
  }

  private async correr(opts: { limite?: number; desde?: string }): Promise<void> {
    const client = qdrantService.raw;
    let offset: any = undefined;
    const limite = opts.limite ?? 2000;
    while (this.estado.puntos < limite) {
      const page = await client.scroll(QdrantKnowledgeService.EPISODIC_COLLECTION, { limit: 50, offset, with_payload: true, with_vector: false });
      for (const p of page.points || []) {
        if (this.estado.puntos >= limite) break;
        this.estado.puntos++;
        const pl: any = p.payload || {};
        const flag = `commitments.backfill2.${p.id}`;
        if (sqliteReminderService.getConfig(flag, '')) { this.estado.saltados++; continue; }
        if (opts.desde && pl.date && String(pl.date) < opts.desde) { this.estado.saltados++; continue; }
        // Solo los puntos "resumen" (con tasks o agreements); los chunks de detalle se saltan.
        const tareas: string[] = Array.isArray(pl.tasks) ? pl.tasks : [];
        let acuerdos: string[] = Array.isArray(pl.agreements) ? pl.agreements : Array.isArray(pl.decisions) ? pl.decisions : [];
        // Las reuniones de Meet guardan los acuerdos dentro del texto del punto "Resumen Ejecutivo y Acuerdos".
        if (!tareas.length && !acuerdos.length && /resumen/i.test(String(pl.section || '')) && typeof pl.content === 'string') {
          const m = pl.content.match(/Acuerdos y Decisiones Clave:\n([\s\S]+)$/);
          acuerdos = (m ? m[1] : pl.content).split('\n').map((l: string) => l.replace(/^[-•\s]+/, '').trim()).filter((l: string) => l.length > 8).slice(0, 25);
        }
        if (!tareas.length && !acuerdos.length) { sqliteReminderService.setConfig(flag, '1'); this.estado.saltados++; continue; }

        try {
          const detectados = await this.estructurar(pl, tareas, acuerdos);
          const origen = this.origenDe(pl);
          const r = await commitmentsService.ingestarDetectados(detectados, origen);
          this.estado.nuevos += r.nuevos.length;
          this.estado.repetidos += r.repetidos;
          this.estado.ultimo = pl.title || String(p.id);
        } catch (err: any) {
          console.warn(`⚠️ [Backfill] ${pl.title || p.id}: ${err?.message}`);
        }
        sqliteReminderService.setConfig(flag, '1');
        this.estado.procesados++;
      }
      offset = page.next_page_offset;
      if (!offset) break;
    }
  }

  private origenDe(pl: any) {
    if (pl.source === 'gmail') return { type: 'gmail', ref: pl.threadId, title: pl.title, link: pl.threadId ? linkGmail(pl.threadId) : null };
    if (pl.source === 'google_chat') return { type: 'google_chat', ref: pl.threadId, title: pl.title, link: pl.threadId ? linkChat(pl.threadId) : null };
    return { type: 'meet', ref: pl.fileId || pl.sourceId || pl.filePath || null, title: pl.title, link: pl.link || null };
  }

  /** Si las tareas ya vienen estructuradas se usan; si son strings, la IA las normaliza en una sola llamada. */
  private async estructurar(pl: any, tareas: string[], acuerdos: string[]): Promise<Detectado[]> {
    const parse = parsearTareas(tareas);
    const yaEstructuradas = parse.detectados.filter((d) => d.owner);
    if (yaEstructuradas.length === parse.detectados.length && parse.detectados.length && !acuerdos.length) return parse.detectados;

    const prompt = `Eres el asistente de Jesús Leiva (CTO de Apprecio). De esta reunión/hilo extrae SOLO compromisos accionables con responsable claro.
Título: ${pl.title || ''}
Fecha: ${pl.date || ''}
Participantes: ${(pl.participants || []).join(', ')}
Resumen: ${String(pl.summary || (typeof pl.content === 'string' ? pl.content.slice(0, 1500) : '')).slice(0, 1500)}
Tareas anotadas:
${tareas.map((t) => `- ${t}`).join('\n') || '(ninguna)'}
Acuerdos:
${acuerdos.map((t) => `- ${t}`).join('\n') || '(ninguno)'}

Responde ÚNICAMENTE con un JSON array (puede ser []), sin markdown:
[{"owner": "responsable (Jesús si es él)", "task": "compromiso concreto", "context": "1-2 frases: de qué se trata y por qué surgió (problema, proyecto, qué se espera)", "counterpart": "con quién o null", "due": "YYYY-MM-DD o null", "priority": "alta|media|baja"}]
Descarta decisiones sin acción, contexto y cosas que claramente ya se hicieron.`;
    beginUsageScope('system', 'commitments_backfill', `Backfill compromisos: ${pl.title || ''}`);
    try {
      const raw = (await generarTexto('commitments_agent', 'gemini-3.5-flash', prompt)).replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      const arr = JSON.parse(raw || '[]');
      return parsearTareas(arr).detectados;
    } finally {
      flushUsageScope().catch(() => {});
    }
  }
}

export const commitmentsBackfillService = new CommitmentsBackfillService();

/**
 * Enriquecimiento: a los compromisos sin `detail` les escribe 1-2 frases de
 * contexto a partir de su fuente (resumen de la reunión / hilo en Qdrant).
 * Agrupa por fuente: una llamada a la IA por reunión, no por compromiso.
 */
export interface EnrichEstado { corriendo: boolean; total: number; hechos: number; sinFuente: number; error: string | null; errores: string[]; }

class CommitmentsEnrichService {
  estado: EnrichEstado = { corriendo: false, total: 0, hechos: 0, sinFuente: 0, error: null, errores: [] };

  iniciar(): EnrichEstado {
    if (this.estado.corriendo) return this.estado;
    this.estado = { corriendo: true, total: 0, hechos: 0, sinFuente: 0, error: null, errores: [] };
    this.correr().catch((e) => { this.estado.error = e?.message || String(e); }).finally(() => { this.estado.corriendo = false; });
    return this.estado;
  }

  private indices = false;
  /** Qdrant Cloud exige índice de payload para filtrar: se crean una vez (idempotente). */
  private async asegurarIndices(): Promise<void> {
    if (this.indices) return;
    for (const field of ['fileId', 'threadId', 'sourceId', 'title']) {
      try { await qdrantService.raw.createPayloadIndex(QdrantKnowledgeService.EPISODIC_COLLECTION, { field_name: field, field_schema: 'keyword', wait: true }); }
      catch { /* ya existe */ }
    }
    this.indices = true;
  }

  /** Busca el punto-resumen de la fuente por ref (fileId/threadId) o, si no hay ref, por título. */
  private async fuente(ref: string | null, title: string | null): Promise<any | null> {
    await this.asegurarIndices();
    const client = qdrantService.raw;
    const intentos: Array<{ key: string; value: string }> = [];
    if (ref) intentos.push({ key: 'fileId', value: ref }, { key: 'threadId', value: ref }, { key: 'sourceId', value: ref });
    if (title) intentos.push({ key: 'title', value: title });
    for (const { key, value } of intentos) {
      try {
        const r = await client.scroll(QdrantKnowledgeService.EPISODIC_COLLECTION, { limit: 5, with_payload: true, with_vector: false, filter: { must: [{ key, match: { value } }] } });
        const pts = r.points || [];
        if (!pts.length) continue;
        const resumen = pts.find((p: any) => /resumen|acuerdos/i.test(String(p.payload?.section || ''))) || pts[0];
        return resumen.payload;
      } catch (err: any) {
        if (this.estado.errores.length < 5) this.estado.errores.push(`${key}=${value.slice(0, 40)}: ${err?.message || err}`);
      }
    }
    return null;
  }

  private async correr(): Promise<void> {
    const pendientes = sqliteReminderService.listCommitments({ limit: 1000 }).filter((c) => !c.detail && (c.source_ref || c.source_title) && ['propuesto', 'pendiente', 'en_curso'].includes(c.status));
    this.estado.total = pendientes.length;
    const porFuente = new Map<string, typeof pendientes>();
    for (const c of pendientes) { const k = c.source_ref || `t:${c.source_title}`; if (!porFuente.has(k)) porFuente.set(k, []); porFuente.get(k)!.push(c); }

    for (const [ref, grupo] of porFuente) {
      const pl = await this.fuente(grupo[0].source_ref, grupo[0].source_title);
      if (!pl) { this.estado.sinFuente += grupo.length; continue; }
      const contexto = String(pl.summary || pl.content || '').slice(0, 5000);
      const prompt = `Eres el asistente de Jesús Leiva (CTO de Apprecio). Para cada compromiso, escribe en 1-2 frases de qué se trata y por qué surgió (el problema o proyecto detrás y qué se espera), usando SOLO la fuente. Si la fuente no lo explica, escribe lo que se pueda inferir con cautela.
Fuente: ${pl.title || ''} (${pl.date || ''})
${contexto}

Compromisos:
${grupo.map((c) => `- id ${c.id}: ${c.title}${c.counterpart ? ` (con ${c.counterpart})` : ''}`).join('\n')}

Responde ÚNICAMENTE con un JSON objeto { "<id>": "contexto" }, sin markdown.`;
      beginUsageScope('system', 'commitments_enrich', `Contexto compromisos: ${pl.title || ref}`);
      try {
        const raw = (await generarTexto('commitments_agent', 'gemini-3.5-flash', prompt)).replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
        const obj = JSON.parse(raw || '{}');
        for (const c of grupo) {
          const d = String(obj[c.id] || '').trim();
          if (d) { sqliteReminderService.updateCommitment(c.id, { detail: d }); this.estado.hechos++; }
        }
      } catch (err: any) {
        console.warn(`⚠️ [Compromisos] Contexto de ${ref}: ${err?.message}`);
      } finally {
        flushUsageScope().catch(() => {});
      }
    }
  }
}

export const commitmentsEnrichService = new CommitmentsEnrichService();
