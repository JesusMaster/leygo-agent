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
    return { type: 'meet', ref: pl.sourceId || pl.filePath || null, title: pl.title, link: pl.link || null };
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
Tareas anotadas:
${tareas.map((t) => `- ${t}`).join('\n') || '(ninguna)'}
Acuerdos:
${acuerdos.map((t) => `- ${t}`).join('\n') || '(ninguno)'}

Responde ÚNICAMENTE con un JSON array (puede ser []), sin markdown:
[{"owner": "responsable (Jesús si es él)", "task": "compromiso concreto", "counterpart": "con quién o null", "due": "YYYY-MM-DD o null", "priority": "alta|media|baja"}]
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
