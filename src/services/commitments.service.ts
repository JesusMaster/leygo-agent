import { createHash, randomBytes } from 'node:crypto';
import { sqliteReminderService, type Commitment, type CommitmentStatus } from '../database/sqlite.service.js';
import { qdrantService, QdrantKnowledgeService } from './qdrant.service.js';

/**
 * Compromisos: la lista viva de lo que Jesús debe (y de lo que le deben).
 *
 * Fuente de verdad: SQLite (estado, fechas, historial de feedback). Qdrant es
 * un índice OPCIONAL para dedup semántico y búsqueda por significado: si no hay
 * Qdrant/Ollama, todo sigue funcionando con similitud léxica y LIKE.
 *
 * Lo detectado automáticamente (Chat, Gmail, Meet, backfill) entra como
 * `propuesto` con una fecha sugerida; Jesús lo acepta (por GUI o por chat) y
 * pasa a `pendiente`. Lo manual entra directo como `pendiente`.
 */

export interface Detectado {
  title: string;
  detail?: string | null;
  owner?: string | null;        // responsable; vacío = Jesús
  counterpart?: string | null;
  due?: string | null;          // YYYY-MM-DD si se dijo
  priority?: 'alta' | 'media' | 'baja';
}

export interface Origen {
  type: 'google_chat' | 'gmail' | 'meet' | 'manual' | 'backfill' | string;
  ref?: string | null;
  title?: string | null;
  link?: string | null;
}

const COLECCION = 'commitments';
const NOMBRES_JESUS = /^(jes[uú]s|yisus|jleiva|yo|jes[uú]s leiva|jesus)$/i;
const ABIERTOS: CommitmentStatus[] = ['propuesto', 'pendiente', 'en_curso'];

function hoyIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: process.env.SCHEDULER_TZ || 'America/Santiago' });
}

function normalizar(t: string): string {
  return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'a', 'al', 'y', 'o', 'en', 'con', 'para', 'por', 'que', 'un', 'una', 'del', 'se', 'su', 'sus', 'le', 'lo', 'the', 'to', 'of', 'and', 'on', 'for', 'in']);
function tokens(t: string): Set<string> {
  return new Set(normalizar(t).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function uuidDe(id: string): string {
  const h = createHash('sha256').update(`commitment:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function esJesus(nombre?: string | null): boolean {
  return !nombre || NOMBRES_JESUS.test(nombre.trim());
}

/** Fecha sugerida: N días hábiles desde hoy según prioridad. */
export function proponerFecha(priority: 'alta' | 'media' | 'baja' = 'media', desde = new Date()): string {
  const habiles = priority === 'alta' ? 2 : priority === 'baja' ? 10 : 5;
  const d = new Date(desde);
  let n = 0;
  while (n < habiles) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return d.toLocaleDateString('en-CA', { timeZone: process.env.SCHEDULER_TZ || 'America/Santiago' });
}

class CommitmentsService {
  private qdrantOk: boolean | null = null;

  // ─── Qdrant (opcional) ────────────────────────────────────────────────
  private async qdrant(): Promise<boolean> {
    if (this.qdrantOk !== null) return this.qdrantOk;
    try {
      const ex = await qdrantService.raw.collectionExists(COLECCION);
      if (!ex.exists) await qdrantService.raw.createCollection(COLECCION, { vectors: { size: QdrantKnowledgeService.EMBEDDING_DIM, distance: 'Cosine' } });
      this.qdrantOk = true;
    } catch (err: any) {
      console.warn(`ℹ️ [Compromisos] Sin índice vectorial (${err?.message}); se usa solo SQLite.`);
      this.qdrantOk = false;
    }
    return this.qdrantOk;
  }

  private textoEmbedding(c: Pick<Commitment, 'title' | 'detail' | 'counterpart' | 'owner'>): string {
    return [c.title, c.detail, c.counterpart ? `con ${c.counterpart}` : '', `responsable ${c.owner}`].filter(Boolean).join('\n');
  }

  private async indexar(c: Commitment): Promise<void> {
    if (!(await this.qdrant())) return;
    try {
      const vector = await qdrantService.generateEmbedding(this.textoEmbedding(c));
      await qdrantService.raw.upsert(COLECCION, { wait: true, points: [{ id: uuidDe(c.id), vector, payload: { commitmentId: c.id, title: c.title, owner: c.owner, mine: c.mine, counterpart: c.counterpart, status: c.status, due_date: c.due_date } }] });
    } catch (err: any) {
      console.warn(`⚠️ [Compromisos] No se pudo indexar ${c.id}: ${err?.message}`);
    }
  }

  private async desindexar(id: string): Promise<void> {
    if (!(await this.qdrant())) return;
    try { await qdrantService.raw.delete(COLECCION, { wait: true, points: [uuidDe(id)] }); } catch { /* opcional */ }
  }

  /** Búsqueda semántica (si hay Qdrant) con fallback a LIKE. */
  async buscar(q: string, opts: { soloAbiertos?: boolean; limit?: number } = {}): Promise<Array<Commitment & { score?: number }>> {
    const limit = opts.limit ?? 10;
    if (await this.qdrant()) {
      try {
        const vector = await qdrantService.generateEmbedding(q);
        const res = await qdrantService.raw.query(COLECCION, { query: vector, limit: limit * 2, with_payload: true });
        const out: Array<Commitment & { score?: number }> = [];
        for (const p of res.points || []) {
          const c = sqliteReminderService.getCommitment(String((p.payload as any)?.commitmentId));
          if (!c) continue;
          if (opts.soloAbiertos && !ABIERTOS.includes(c.status)) continue;
          out.push({ ...c, score: p.score });
          if (out.length >= limit) break;
        }
        return out;
      } catch (err: any) {
        console.warn(`⚠️ [Compromisos] Búsqueda vectorial falló (${err?.message}); uso LIKE.`);
      }
    }
    return sqliteReminderService.listCommitments({ q, status: opts.soloAbiertos ? ABIERTOS : undefined, limit });
  }

  // ─── Dedup ────────────────────────────────────────────────────────────
  /**
   * Candidatos a duplicado de un detectado: los abiertos (y los cerrados en los
   * últimos 45 días, para no reproponer lo que ya se hizo) con parecido léxico
   * o semántico. Devuelve los mejores con su puntaje.
   */
  private async candidatos(d: Detectado): Promise<Array<{ c: Commitment; s: number; via: 'lexico' | 'semantico' }>> {
    const hace45 = Date.now() - 45 * 86400000;
    const base = sqliteReminderService.listCommitments({ limit: 800 }).filter((c) => ABIERTOS.includes(c.status) || (c.updated_at >= hace45 && c.status !== 'descartado'));
    const tk = tokens(`${d.title} ${d.counterpart || ''}`);
    const out = new Map<string, { c: Commitment; s: number; via: 'lexico' | 'semantico' }>();
    for (const c of base) {
      const s = jaccard(tk, tokens(`${c.title} ${c.counterpart || ''}`));
      if (s >= 0.3) out.set(c.id, { c, s, via: 'lexico' });
    }
    if (await this.qdrant()) {
      try {
        const vector = await qdrantService.generateEmbedding(this.textoEmbedding({ title: d.title, detail: d.detail || null, counterpart: d.counterpart || null, owner: d.owner || 'Jesús' }));
        const res = await qdrantService.raw.query(COLECCION, { query: vector, limit: 5, with_payload: true, score_threshold: 0.72 });
        for (const p of res.points || []) {
          const c = sqliteReminderService.getCommitment(String((p.payload as any)?.commitmentId));
          if (!c || c.status === 'descartado') continue;
          if (!ABIERTOS.includes(c.status) && c.updated_at < hace45) continue;
          const prev = out.get(c.id);
          if (!prev || (p.score || 0) > prev.s) out.set(c.id, { c, s: p.score || 0, via: 'semantico' });
        }
      } catch { /* opcional */ }
    }
    return [...out.values()].sort((a, b) => b.s - a.s).slice(0, 5);
  }

  /**
   * Decide, para un lote de detectados de una misma fuente, cuáles son nuevos y
   * cuáles ya existen. Parecido obvio (léxico ≥ 0.6 o semántico ≥ 0.9) se
   * resuelve solo; lo dudoso se le pregunta a la IA en UNA llamada por lote,
   * mostrándole los candidatos. Sin candidatos = nuevo, sin llamar a nada.
   */
  async decidirDuplicados(items: Detectado[]): Promise<Array<{ d: Detectado; dup: Commitment | null; via: string }>> {
    const decisiones: Array<{ d: Detectado; dup: Commitment | null; via: string }> = [];
    const dudosos: Array<{ idx: number; cands: Array<{ c: Commitment; s: number; via: string }> }> = [];
    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      const cands = await this.candidatos(d);
      const top = cands[0];
      if (!top) { decisiones.push({ d, dup: null, via: 'sin candidatos' }); continue; }
      if ((top.via === 'lexico' && top.s >= 0.6) || (top.via === 'semantico' && top.s >= 0.9)) { decisiones.push({ d, dup: top.c, via: `${top.via} ${top.s.toFixed(2)}` }); continue; }
      decisiones.push({ d, dup: null, via: 'pendiente IA' });
      dudosos.push({ idx: i, cands });
    }
    if (!dudosos.length) return decisiones;

    // Una sola llamada para todos los dudosos del lote.
    const { generarTexto } = await import('../agents/llm/model_factory.js');
    const { beginUsageScope, flushUsageScope } = await import('../utils/usage_collector.js');
    const bloque = dudosos.map(({ idx, cands }) => {
      const d = items[idx];
      return `#${idx}: "${d.title}"${d.counterpart ? ` (con ${d.counterpart})` : ''}${d.owner ? ` [responsable ${d.owner}]` : ''}\n   candidatos: ${cands.map((k) => `[${k.c.id}] "${k.c.title}"${k.c.counterpart ? ` (con ${k.c.counterpart})` : ''} [${k.c.status}]`).join(' | ')}`;
    }).join('\n');
    const prompt = `Eres el asistente de Jesús Leiva. Para cada compromiso nuevo (#n) decide si es EL MISMO compromiso que alguno de sus candidatos ya registrados (misma acción y mismo responsable/contraparte, aunque esté dicho con otras palabras o más detalle) o si es uno distinto.
Reglas:
- "mismo" si es la misma acción aunque cambie la redacción, o si es el siguiente paso / una parte / más detalle de un compromiso ya registrado sobre el mismo tema y con el mismo responsable (p. ej. "pedir a Producto los accesos del Panel" es parte de "Panel de Engagement: traspasar a CORE"). Ante la duda, "mismo": es mejor anotar una mención que duplicar.
- "distinto" solo si es otro tema, otra entrega claramente separada u otro responsable.

${bloque}

Responde ÚNICAMENTE con JSON: {"<n>": "<id del candidato>" | "nuevo"}`;
    beginUsageScope('system', 'commitments_dedup', 'Dedup de compromisos');
    try {
      const raw = (await generarTexto('commitments_agent', 'gemini-3.5-flash', prompt)).replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      const obj = JSON.parse(raw || '{}');
      for (const { idx, cands } of dudosos) {
        const v = String(obj[idx] ?? obj[`#${idx}`] ?? 'nuevo').trim();
        const hit = cands.find((k) => k.c.id === v.replace(/[\[\]]/g, ''));
        decisiones[idx] = { d: items[idx], dup: hit ? hit.c : null, via: hit ? 'IA' : 'IA: nuevo' };
      }
    } catch (err: any) {
      console.warn(`⚠️ [Compromisos] Dedup por IA falló (${err?.message}); los dudosos entran como nuevos.`);
      for (const { idx } of dudosos) decisiones[idx] = { d: items[idx], dup: null, via: 'IA falló → nuevo' };
    } finally {
      flushUsageScope().catch(() => {});
    }
    return decisiones;
  }

  // ─── Altas ────────────────────────────────────────────────────────────
  private nuevoId(): string {
    let id = randomBytes(3).toString('hex');
    while (sqliteReminderService.getCommitment(id)) id = randomBytes(3).toString('hex');
    return id;
  }

  /** Alta manual (por chat o GUI): entra directo como pendiente. */
  async crear(d: Detectado & { status?: CommitmentStatus }, origen: Origen = { type: 'manual' }, by = 'jesus'): Promise<Commitment> {
    const owner = (d.owner || '').trim() || 'Jesús';
    const priority = d.priority || 'media';
    const c = sqliteReminderService.createCommitment({
      id: this.nuevoId(),
      title: d.title.trim(),
      detail: d.detail?.trim() || null,
      owner,
      mine: esJesus(owner) ? 1 : 0,
      counterpart: d.counterpart?.trim() || null,
      due_date: d.due || null,
      proposed_due: d.due ? null : proponerFecha(priority),
      status: d.status || 'pendiente',
      priority,
      source_type: origen.type,
      source_ref: origen.ref || null,
      source_title: origen.title || null,
      source_link: origen.link || null,
      fingerprint: [...tokens(d.title)].sort().join(' '),
    });
    sqliteReminderService.addCommitmentUpdate({ commitment_id: c.id, at: Date.now(), kind: 'creado', text: origen.type === 'manual' ? 'Creado a mano' : `Detectado en ${origen.type}${origen.title ? `: ${origen.title}` : ''}`, by });
    this.indexar(c).catch(() => {});
    return c;
  }

  /**
   * Entrada automática: cada detectado entra como `propuesto` con fecha sugerida,
   * salvo que ya exista uno abierto equivalente (se anota la nueva mención).
   */
  async ingestarDetectados(items: Detectado[], origen: Origen): Promise<{ nuevos: Commitment[]; repetidos: number }> {
    const nuevos: Commitment[] = [];
    let repetidos = 0;
    const validos = items.filter((d) => d?.title && d.title.trim().length >= 6);
    const decisiones = await this.decidirDuplicados(validos);
    for (const { d, dup } of decisiones) {
      if (dup) {
        repetidos++;
        sqliteReminderService.addCommitmentUpdate({ commitment_id: dup.id, at: Date.now(), kind: 'mencion', text: `Vuelve a aparecer en ${origen.type}${origen.title ? `: ${origen.title}` : ''}${origen.link ? ` — ${origen.link}` : ''}`, by: 'auto' });
        if (!dup.due_date && d.due) sqliteReminderService.updateCommitment(dup.id, { proposed_due: d.due });
        if (dup.status === 'hecho' || dup.status === 'cancelado') {
          sqliteReminderService.addCommitmentUpdate({ commitment_id: dup.id, at: Date.now(), kind: 'nota', text: 'Ojo: ya estaba cerrado y vuelve a mencionarse; revisa si se reabrió.', by: 'auto' });
        }
        continue;
      }
      nuevos.push(await this.crear({ ...d, status: 'propuesto' }, origen, 'auto'));
    }
    return { nuevos, repetidos };
  }

  // ─── Cambios ──────────────────────────────────────────────────────────
  async aceptar(id: string, due?: string | null, by = 'jesus'): Promise<Commitment | null> {
    const c = sqliteReminderService.getCommitment(id);
    if (!c) return null;
    const fecha = due || c.due_date || c.proposed_due || proponerFecha(c.priority);
    const n = sqliteReminderService.updateCommitment(id, { status: c.status === 'propuesto' ? 'pendiente' : c.status, due_date: fecha, proposed_due: null })!;
    sqliteReminderService.addCommitmentUpdate({ commitment_id: id, at: Date.now(), kind: 'aceptado', text: `Aceptado con fecha ${fecha}`, by });
    this.indexar(n).catch(() => {});
    return n;
  }

  async actualizar(id: string, cambios: Partial<Pick<Commitment, 'title' | 'detail' | 'owner' | 'counterpart' | 'due_date' | 'status' | 'priority'>>, by = 'jesus', nota?: string): Promise<Commitment | null> {
    const c = sqliteReminderService.getCommitment(id);
    if (!c) return null;
    const patch: Partial<Commitment> = { ...cambios };
    if (cambios.owner !== undefined) patch.mine = esJesus(cambios.owner) ? 1 : 0;
    if (cambios.status === 'hecho') patch.completed_at = Date.now();
    if (cambios.status && cambios.status !== 'hecho') patch.completed_at = null;
    if (cambios.due_date) patch.proposed_due = null;
    const n = sqliteReminderService.updateCommitment(id, patch)!;
    const partes: string[] = [];
    if (cambios.status && cambios.status !== c.status) partes.push(`estado ${c.status} → ${cambios.status}`);
    if (cambios.due_date !== undefined && cambios.due_date !== c.due_date) partes.push(`fecha ${c.due_date || '—'} → ${cambios.due_date || '—'}`);
    if (cambios.owner && cambios.owner !== c.owner) partes.push(`responsable → ${cambios.owner}`);
    if (cambios.priority && cambios.priority !== c.priority) partes.push(`prioridad → ${cambios.priority}`);
    if (cambios.title && cambios.title !== c.title) partes.push('título editado');
    if (partes.length || nota) {
      sqliteReminderService.addCommitmentUpdate({ commitment_id: id, at: Date.now(), kind: cambios.status ? 'estado' : cambios.due_date !== undefined ? 'fecha' : 'edicion', text: [partes.join(' · '), nota].filter(Boolean).join(' — '), by });
    }
    this.indexar(n).catch(() => {});
    return n;
  }

  nota(id: string, texto: string, by = 'jesus'): boolean {
    if (!sqliteReminderService.getCommitment(id)) return false;
    sqliteReminderService.addCommitmentUpdate({ commitment_id: id, at: Date.now(), kind: 'nota', text: texto.trim(), by });
    sqliteReminderService.updateCommitment(id, {});
    return true;
  }

  /**
   * Notifica a la contraparte (o a quien sea) por uno o más canales y lo deja
   * en el historial. `mensaje` vacío = texto por defecto según el estado.
   */
  async notificar(id: string, destinos: Array<{ channel: string; target?: string | null }>, mensaje?: string, by = 'jesus'): Promise<{ enviados: string[]; fallos: string[] }> {
    const c = sqliteReminderService.getCommitment(id);
    if (!c) throw new Error(`No existe el compromiso ${id}`);
    if (!destinos?.length) throw new Error('Indica al menos un canal');
    const { scheduledTasksService } = await import('./scheduled_tasks.service.js');
    const texto = (mensaje || '').trim() || this.mensajePorDefecto(c);
    const fallos = await scheduledTasksService.entregarPor(destinos as any, texto);
    const enviados = destinos.map((d) => scheduledTasksService.etiquetaDestino(d as any)).filter((e) => !fallos.some((f) => f.startsWith(e.split(' (')[0])));
    sqliteReminderService.addCommitmentUpdate({
      commitment_id: id, at: Date.now(), kind: 'notificado',
      text: `${enviados.length ? `Avisado por ${enviados.join(' + ')}` : 'No se pudo avisar'}${fallos.length ? ` · fallos: ${fallos.join(' · ')}` : ''}: "${texto.slice(0, 200)}"`, by,
    });
    if (fallos.length === destinos.length) throw new Error(`No se pudo notificar — ${fallos.join(' · ')}`);
    return { enviados, fallos };
  }

  /** Friendly reminder para quien le debe algo a Jesús. */
  mensajeRecordatorio(c: Commitment): string {
    const nombre = (c.mine ? c.counterpart : c.owner)?.split(' ')[0];
    const saludo = nombre ? `Hola ${nombre}, ` : 'Hola, ';
    const hoy = hoyIso();
    const cuando = c.due_date
      ? (c.due_date < hoy ? `lo teníamos para el ${c.due_date} y ya se nos pasó` : c.due_date === hoy ? `lo teníamos para hoy` : `lo teníamos para el ${c.due_date}`)
      : 'no le pusimos fecha';
    return `${saludo}¿cómo vas con "${c.title}"? ${cuando.charAt(0).toUpperCase() + cuando.slice(1)}. Si necesitas algo de mi lado o hay que mover la fecha, me dices. Gracias.`;
  }

  /** Configura (o apaga) el friendly reminder automático de un compromiso. */
  configurarRecordatorio(id: string, auto: boolean, delivery: Array<{ channel: string; target?: string | null }> | null, by = 'jesus'): Commitment | null {
    const c = sqliteReminderService.getCommitment(id);
    if (!c) return null;
    const n = sqliteReminderService.updateCommitment(id, { reminder_auto: auto ? 1 : 0, reminder_delivery: delivery?.length ? JSON.stringify(delivery) : c.reminder_delivery })!;
    sqliteReminderService.addCommitmentUpdate({ commitment_id: id, at: Date.now(), kind: 'recordatorio', text: auto ? `Reminder automático activado (1 día antes y cada día vencido)${delivery?.length ? ` por ${delivery.map((d) => d.channel).join(' + ')}` : ''}` : 'Reminder automático desactivado', by });
    return n;
  }

  /**
   * Reminders automáticos del día (los llama la rutina "Aviso de compromisos"):
   * compromisos que otros le deben a Jesús, con reminder_auto, cuya fecha es
   * mañana o ya pasó, y que no se recordaron hoy. Devuelve un resumen para Jesús.
   */
  async enviarRecordatoriosAutomaticos(): Promise<string> {
    const hoy = hoyIso();
    const manana = new Date(); manana.setDate(manana.getDate() + 1);
    const mananaIso = manana.toLocaleDateString('en-CA', { timeZone: process.env.SCHEDULER_TZ || 'America/Santiago' });
    const inicioHoy = new Date(`${hoy}T00:00:00`).getTime();
    const candidatos = sqliteReminderService.listCommitments({ status: ['pendiente', 'en_curso'], limit: 500 })
      .filter((c) => c.reminder_auto && c.reminder_delivery && c.due_date && (c.due_date <= hoy || c.due_date === mananaIso) && (!c.last_reminded_at || c.last_reminded_at < inicioHoy));
    const lineas: string[] = [];
    for (const c of candidatos) {
      try {
        const destinos = JSON.parse(c.reminder_delivery!);
        const r = await this.notificar(c.id, destinos, this.mensajeRecordatorio(c), 'auto');
        sqliteReminderService.updateCommitment(c.id, { last_reminded_at: Date.now() });
        lineas.push(`• ${c.owner}: "${c.title}" (${c.due_date}) → ${r.enviados.join(' + ')}${r.fallos.length ? ` · fallos: ${r.fallos.join(' · ')}` : ''}`);
      } catch (err: any) {
        lineas.push(`• ${c.owner}: "${c.title}" → no se pudo: ${err?.message}`);
      }
    }
    return lineas.length ? `🔔 Friendly reminders enviados:\n${lineas.join('\n')}` : '';
  }

  mensajePorDefecto(c: Commitment): string {
    const quien = c.counterpart ? `${c.counterpart.split(' ')[0]}, ` : '';
    if (c.status === 'hecho') return `${quien}listo lo de "${c.title}". Cualquier cosa me avisas.`;
    if (c.status === 'cancelado') return `${quien}te aviso que "${c.title}" queda sin efecto por ahora. Te cuento si se retoma.`;
    if (c.due_date) return `${quien}sobre "${c.title}": lo tengo para el ${c.due_date}. Te confirmo cuando esté.`;
    return `${quien}sobre "${c.title}": lo tengo en la lista, te confirmo fecha en breve.`;
  }

  async eliminar(id: string): Promise<boolean> {
    const ok = sqliteReminderService.deleteCommitment(id);
    if (ok) this.desindexar(id).catch(() => {});
    return ok;
  }

  // ─── Consultas ────────────────────────────────────────────────────────
  listar = sqliteReminderService.listCommitments.bind(sqliteReminderService);
  obtener = sqliteReminderService.getCommitment.bind(sqliteReminderService);
  historial = sqliteReminderService.listCommitmentUpdates.bind(sqliteReminderService);
  stats = sqliteReminderService.commitmentStats.bind(sqliteReminderService);

  /** Corte para el digest y el aviso diario. */
  panorama() {
    const hoy = hoyIso();
    const abiertos = sqliteReminderService.listCommitments({ status: ['pendiente', 'en_curso'], limit: 500 });
    const en7 = new Date(); en7.setDate(en7.getDate() + 7);
    const limite7 = en7.toLocaleDateString('en-CA', { timeZone: process.env.SCHEDULER_TZ || 'America/Santiago' });
    return {
      hoy,
      vencidos: abiertos.filter((c) => c.due_date && c.due_date < hoy),
      paraHoy: abiertos.filter((c) => c.due_date === hoy),
      proximos: abiertos.filter((c) => c.due_date && c.due_date > hoy && c.due_date <= limite7),
      sinFecha: abiertos.filter((c) => !c.due_date),
      propuestos: sqliteReminderService.listCommitments({ status: ['propuesto'], limit: 100 }),
    };
  }

  private linea(c: Commitment): string {
    const quien = c.mine ? '' : ` (${c.owner})`;
    const con = c.counterpart ? ` · ${c.counterpart}` : '';
    return `• [${c.id}] ${c.title}${quien}${con}${c.due_date ? ` — ${c.due_date}` : c.proposed_due ? ` — sugerida ${c.proposed_due}` : ''}`;
  }

  /** Texto para el digest matutino ('' si no hay nada que decir). */
  textoDigest(): string {
    const p = this.panorama();
    const partes: string[] = [];
    if (p.vencidos.length) partes.push(`Vencidos (${p.vencidos.length}):\n${p.vencidos.map((c) => this.linea(c)).join('\n')}`);
    if (p.paraHoy.length) partes.push(`Para hoy (${p.paraHoy.length}):\n${p.paraHoy.map((c) => this.linea(c)).join('\n')}`);
    if (p.proximos.length) partes.push(`Próximos 7 días (${p.proximos.length}):\n${p.proximos.slice(0, 8).map((c) => this.linea(c)).join('\n')}`);
    if (p.propuestos.length) partes.push(`Propuestos sin revisar: ${p.propuestos.length} (acéptalos o descártalos en la GUI o dime "acepta el [id]").`);
    return partes.join('\n\n');
  }

  /** Aviso diario (rutina integrada). Vacío = no molestar. */
  textoAviso(): string {
    const p = this.panorama();
    if (!p.vencidos.length && !p.paraHoy.length && !p.propuestos.length) return '';
    const partes: string[] = ['📌 **Compromisos**'];
    if (p.vencidos.length) partes.push(`⚠️ Vencidos (${p.vencidos.length}):\n${p.vencidos.map((c) => this.linea(c)).join('\n')}`);
    if (p.paraHoy.length) partes.push(`Hoy (${p.paraHoy.length}):\n${p.paraHoy.map((c) => this.linea(c)).join('\n')}`);
    if (p.propuestos.length) partes.push(`Propuestos por revisar (${p.propuestos.length}):\n${p.propuestos.slice(0, 6).map((c) => this.linea(c)).join('\n')}${p.propuestos.length > 6 ? '\n…' : ''}`);
    const ahora = Date.now();
    for (const c of [...p.vencidos, ...p.paraHoy]) sqliteReminderService.updateCommitment(c.id, { last_notified_at: ahora });
    return partes.join('\n\n');
  }
}

export const commitmentsService = new CommitmentsService();

/**
 * Normaliza la lista de tareas que devuelve la IA: acepta objetos
 * {owner, task, counterpart, due, priority} o strings "Responsable: tarea".
 * Devuelve los strings (para el payload de Qdrant) y los detectados (para la lista).
 */
export function parsearTareas(tasks: any): { strings: string[]; detectados: Detectado[] } {
  const strings: string[] = [];
  const detectados: Detectado[] = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t && typeof t === 'object') {
      const task = String(t.task || t.tarea || t.title || '').trim();
      if (!task) continue;
      const owner = String(t.owner || t.responsable || '').trim() || null;
      const counterpart = String(t.counterpart || t.contraparte || '').trim() || null;
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(t.due || t.fecha || '')) ? String(t.due || t.fecha) : null;
      const priority = ['alta', 'media', 'baja'].includes(t.priority) ? t.priority : undefined;
      const detail = String(t.context || t.contexto || t.detail || '').trim() || null;
      strings.push(`${owner || 'Jesús'}: ${task}${due ? ` (para ${due})` : ''}`);
      detectados.push({ title: task, detail, owner, counterpart, due, priority });
    } else if (typeof t === 'string' && t.trim()) {
      strings.push(t.trim());
      const m = t.match(/^\s*([^:]{2,40}):\s*(.+)$/);
      const owner = m ? m[1].trim() : null;
      const task = (m ? m[2] : t).trim();
      const fecha = task.match(/(\d{4}-\d{2}-\d{2})/);
      detectados.push({ title: task.replace(/\s*\(para \d{4}-\d{2}-\d{2}\)\s*$/, ''), owner, due: fecha ? fecha[1] : null });
    }
  }
  return { strings, detectados };
}

export function linkGmail(threadId: string): string { return `https://mail.google.com/mail/u/0/#all/${threadId}`; }
export function linkChat(threadName: string): string {
  const m = (threadName || '').match(/^spaces\/([^/]+)(?:\/threads\/([^/]+))?/);
  return m ? `https://mail.google.com/chat/u/0/#chat/space/${m[1]}${m[2] ? `/${m[2]}` : ''}` : '';
}
