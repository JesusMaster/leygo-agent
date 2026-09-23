import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Adjuntos que producen las herramientas (imágenes generadas, archivos).
 *
 * Una herramienta devuelve `adjuntos: [{ tipo, mime, base64, nombre, caption }]`.
 * El base64 NO viaja al modelo (costaría tokens y contexto): se guarda acá, y al
 * modelo le llega `{ id, nombre, mime, url, marcador }`. El modelo pone el
 * marcador `[[adjunto:ID]]` en su respuesta y cada canal lo reemplaza por lo suyo:
 * imagen inline en la GUI, sendPhoto/sendDocument en Telegram, enlace en Google
 * Chat / Buzz / A2A.
 *
 * Los archivos viven en data/adjuntos/<id>.<ext> con un id aleatorio de 128 bits:
 * la URL pública /api/adjuntos/<id> es una URL-capacidad (quien la tiene, la ve),
 * igual que los enlaces de archivos de Slack. Caducan a los 7 días.
 */
export interface AdjuntoEntrada { tipo?: 'imagen' | 'archivo'; mime?: string; base64: string; nombre?: string; caption?: string; }
export interface Adjunto { id: string; tipo: 'imagen' | 'archivo'; mime: string; nombre: string; caption?: string; bytes: number; createdAt: string; agente?: string; }

const DIR = path.resolve(process.cwd(), 'data', 'adjuntos');
const TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_BYTES = 15 * 1024 * 1024;
// El modelo a veces reescribe el id con guiones (formato UUID): se aceptan y se quitan al buscar.
export const MARCADOR = /\[\[\s*adjunto\s*:\s*([a-f0-9-]{16,72})\s*\]\]/gi;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json' };

class AttachmentsService {
  private meta = new Map<string, Adjunto>();
  private cargado = false;

  private cargar() {
    if (this.cargado) return;
    this.cargado = true;
    fs.mkdirSync(DIR, { recursive: true });
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Adjunto;
        this.meta.set(m.id, m);
      } catch { /* meta corrupta: se ignora */ }
    }
    this.purgar();
    const t = setInterval(() => this.purgar(), 6 * 3600 * 1000);
    (t as any).unref?.();
  }

  private purgar() {
    const limite = Date.now() - TTL_MS;
    for (const m of [...this.meta.values()]) {
      if (new Date(m.createdAt).getTime() < limite) {
        for (const f of [this.rutaArchivo(m), path.join(DIR, `${m.id}.json`)]) { try { fs.unlinkSync(f); } catch { /* ya no está */ } }
        this.meta.delete(m.id);
      }
    }
  }

  private rutaArchivo(m: Adjunto) { return path.join(DIR, `${m.id}.${EXT[m.mime] || 'bin'}`); }

  /** URL pública absoluta (para Telegram/Chat/A2A). La GUI usa la relativa. */
  urlPublica(id: string): string {
    const base = (process.env.PUBLIC_BASE_URL || process.env.A2A_BASE_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
    return `${base}/api/adjuntos/${id}`;
  }

  guardar(entrada: AdjuntoEntrada, agente?: string): Adjunto {
    this.cargar();
    const buf = Buffer.from(String(entrada.base64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) throw new Error('adjunto vacío');
    if (buf.length > MAX_BYTES) throw new Error(`adjunto de ${(buf.length / 1048576).toFixed(1)} MB supera el máximo de ${MAX_BYTES / 1048576} MB`);
    const mime = String(entrada.mime || (entrada.tipo === 'imagen' ? 'image/png' : 'application/octet-stream')).toLowerCase();
    const tipo: 'imagen' | 'archivo' = entrada.tipo === 'imagen' || mime.startsWith('image/') ? 'imagen' : 'archivo';
    const id = randomBytes(16).toString('hex');
    const nombre = String(entrada.nombre || `${tipo}-${id.slice(0, 8)}.${EXT[mime] || 'bin'}`).replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]/g, '_').slice(0, 120);
    const m: Adjunto = { id, tipo, mime, nombre, ...(entrada.caption ? { caption: String(entrada.caption).slice(0, 500) } : {}), bytes: buf.length, createdAt: new Date().toISOString(), ...(agente ? { agente } : {}) };
    fs.writeFileSync(this.rutaArchivo(m), buf);
    fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify(m), 'utf8');
    this.meta.set(id, m);
    return m;
  }

  get(id: string): Adjunto | null { this.cargar(); return this.meta.get(String(id || '').toLowerCase().replace(/-/g, '')) || null; }

  leer(id: string): { meta: Adjunto; buffer: Buffer } | null {
    const meta = this.get(id);
    if (!meta) return null;
    try { return { meta, buffer: fs.readFileSync(this.rutaArchivo(meta)) }; } catch { return null; }
  }

  /**
   * Reemplaza en el resultado de una herramienta los `adjuntos` con base64 por
   * referencias livianas (id, url, marcador). Devuelve el resultado modificado.
   */
  procesarResultado(result: any, agente?: string): any {
    if (!result || typeof result !== 'object') return result;
    const lista = Array.isArray(result.adjuntos) ? result.adjuntos : (result.adjunto ? [result.adjunto] : null);
    if (!lista?.length) return result;
    const refs: any[] = [];
    const errores: string[] = [];
    for (const a of lista) {
      if (!a || typeof a !== 'object' || !a.base64) continue;
      try {
        const m = this.guardar(a, agente);
        refs.push({ id: m.id, tipo: m.tipo, nombre: m.nombre, mime: m.mime, url: this.urlPublica(m.id), marcador: `[[adjunto:${m.id}]]` });
      } catch (err: any) { errores.push(err.message); }
    }
    const out = { ...result };
    delete out.adjunto;
    out.adjuntos = refs;
    if (refs.length) out.instruccion_adjuntos = `Para entregar ${refs.length === 1 ? 'el adjunto' : 'los adjuntos'} al usuario, escribe en tu respuesta el marcador tal cual (p. ej. ${refs[0].marcador}); el canal lo convierte en la imagen/archivo. No inventes URLs ni describas el base64.`;
    if (errores.length) out.errores_adjuntos = errores;
    return out;
  }

  /** Extrae los marcadores de un texto: devuelve el texto sin ellos y los adjuntos referenciados. */
  extraer(texto: string): { texto: string; adjuntos: Adjunto[] } {
    const adjuntos: Adjunto[] = [];
    const vistos = new Set<string>();
    const limpio = (texto || '').replace(MARCADOR, (_m, id) => {
      const a = this.get(id);
      if (a && !vistos.has(a.id)) { vistos.add(a.id); adjuntos.push(a); }
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { texto: limpio, adjuntos };
  }

  /** Para canales de solo texto (Google Chat, Buzz, A2A): marcador → enlace. */
  comoEnlaces(texto: string): string {
    return (texto || '').replace(MARCADOR, (_m, id) => {
      const a = this.get(id);
      return a ? `${a.tipo === 'imagen' ? '🖼️' : '📎'} ${a.nombre}: ${this.urlPublica(a.id)}` : '';
    });
  }
}

export const attachmentsService = new AttachmentsService();
