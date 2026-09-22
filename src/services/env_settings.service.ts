import fs from 'node:fs';
import path from 'node:path';

/**
 * Lectura y edición del `.env` desde la GUI.
 *
 * - Nunca devuelve un secreto completo: solo una máscara y si está definido.
 * - Al guardar se conserva el orden y los comentarios del archivo; las claves
 *   nuevas se agregan al final. También se actualiza `process.env`, pero la
 *   mayoría de los servicios leen la variable al arrancar: se avisa qué
 *   requiere reinicio.
 */

export interface EnvVarMeta {
  key: string;
  grupo: string;
  descripcion: string;
  secreto?: boolean;
  /** true si el backend la toma en caliente (no hace falta reiniciar) */
  caliente?: boolean;
  placeholder?: string;
}

export const ENV_CATALOGO: EnvVarMeta[] = [
  { key: 'PORT',            grupo: 'Servidor', descripcion: 'Puerto HTTP del backend.', placeholder: '4000' },
  { key: 'NODE_ENV',        grupo: 'Servidor', descripcion: 'development o production.' },
  { key: 'LOG_LEVEL',       grupo: 'Servidor', descripcion: 'Nivel de log (debug, info, warn, error).' },
  { key: 'ADK_APP_NAME',    grupo: 'Servidor', descripcion: 'Nombre de la app en el ADK (sesiones).' },
  { key: 'A2A_BASE_URL',    grupo: 'Servidor', descripcion: 'URL pública que se publica en el Agent Card (A2A).' },
  { key: 'GUI_ORIGIN',      grupo: 'Servidor', descripcion: 'Orígenes permitidos (CORS) para la GUI, separados por coma.' },

  { key: 'ADMIN_API_KEY',     grupo: 'Acceso', descripcion: 'Clave de administración para llamar al API directo (X-Admin-Key).', secreto: true, caliente: true },
  { key: 'GUI_USER',          grupo: 'Acceso', descripcion: 'Usuario para iniciar sesión en la GUI.', caliente: true },
  { key: 'GUI_PASSWORD_HASH', grupo: 'Acceso', descripcion: 'Hash scrypt de la contraseña de la GUI (npm run gui:password).', secreto: true, caliente: true },

  { key: 'GEMINI_API_KEY',    grupo: 'Modelos', descripcion: 'Key de Google AI Studio. Es el proveedor por defecto de todos los agentes.', secreto: true },
  { key: 'OLLAMA_BASE_URL',   grupo: 'Modelos', descripcion: 'URL de Ollama para embeddings y modelos locales.', placeholder: 'http://localhost:11434' },
  { key: 'OLLAMA_EMBED_MODEL', grupo: 'Modelos', descripcion: 'Modelo de embeddings (Qdrant).', placeholder: 'nomic-embed-text' },

  { key: 'MONTHLY_BUDGET_USD',          grupo: 'Presupuesto', descripcion: 'Presupuesto mensual global en USD (el guardado en SQLite tiene prioridad).', caliente: true },
  { key: 'MONTHLY_BUDGET_USD_TELEGRAM', grupo: 'Presupuesto', descripcion: 'Presupuesto mensual del canal Telegram.', caliente: true },
  { key: 'MONTHLY_BUDGET_USD_BUZZ',     grupo: 'Presupuesto', descripcion: 'Presupuesto mensual del canal Buzz.', caliente: true },
  { key: 'MONTHLY_BUDGET_USD_A2A',      grupo: 'Presupuesto', descripcion: 'Presupuesto mensual del canal A2A.', caliente: true },

  { key: 'GOOGLE_CLIENT_ID',     grupo: 'Google', descripcion: 'OAuth client id (Gmail, Calendar, Drive, Chat).' },
  { key: 'GOOGLE_CLIENT_SECRET', grupo: 'Google', descripcion: 'OAuth client secret.', secreto: true },
  { key: 'GOOGLE_REFRESH_TOKEN', grupo: 'Google', descripcion: 'Refresh token con los scopes completos (npm run google:oauth).', secreto: true },
  { key: 'GOOGLE_REDIRECT_URI',  grupo: 'Google', descripcion: 'Redirect URI registrado en el proyecto de Google.' },

  { key: 'TELEGRAM_TOKEN',   grupo: 'Telegram', descripcion: 'Token del bot (BotFather).', secreto: true },
  { key: 'TELEGRAM_CHAT_ID', grupo: 'Telegram', descripcion: 'Chat id de Jesús: destino de avisos y 2FA.' },

  { key: 'NOSTR_PRIVATE_KEY',     grupo: 'Buzz / Nostr', descripcion: 'Clave privada (nsec/hex) de la identidad del agente en Buzz.', secreto: true },
  { key: 'NOSTR_SUMMARY_SECONDS', grupo: 'Buzz / Nostr', descripcion: 'Cada cuántos segundos se resume la actividad.' },
  { key: 'NOSTR_DEBUG_EVENTS',    grupo: 'Buzz / Nostr', descripcion: 'true para loguear todos los eventos recibidos.' },

  { key: 'QDRANT_URL',     grupo: 'Datos', descripcion: 'URL de Qdrant (cerebro digital).' },
  { key: 'QDRANT_API_KEY', grupo: 'Datos', descripcion: 'API key de Qdrant.', secreto: true },
  { key: 'MONGO_URI',      grupo: 'Datos', descripcion: 'Conexión a MongoDB.', secreto: true },
  { key: 'REDIS_HOST',     grupo: 'Datos', descripcion: 'Host de Redis (sesiones del ADK).' },
  { key: 'REDIS_PORT',     grupo: 'Datos', descripcion: 'Puerto de Redis.' },
  { key: 'REDIS_PASSWORD', grupo: 'Datos', descripcion: 'Contraseña de Redis.', secreto: true },
  { key: 'REDIS_DB',       grupo: 'Datos', descripcion: 'Número de base en Redis.' },
];

/** Cualquier variable no catalogada que huela a secreto también se enmascara. */
const PATRON_SECRETO = /(KEY|SECRET|TOKEN|PASSWORD|PASS|URI|PRIVATE)/i;

export function esSecreto(key: string): boolean {
  const meta = ENV_CATALOGO.find((m) => m.key === key);
  return meta ? !!meta.secreto : PATRON_SECRETO.test(key);
}

function mascara(v: string): string {
  if (!v) return '';
  if (v.length <= 6) return '••••';
  return `${v.slice(0, 2)}${'•'.repeat(Math.min(12, v.length - 6))}${v.slice(-4)}`;
}

/** Quita comillas envolventes como hace dotenv. */
function desquitar(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function citar(v: string): string {
  return /[\s#"'\\]/.test(v) ? JSON.stringify(v) : v;
}

class EnvSettingsService {
  readonly ruta = path.resolve(process.cwd(), '.env');

  private leerLineas(): string[] {
    try { return fs.readFileSync(this.ruta, 'utf8').split(/\r?\n/); } catch { return []; }
  }

  /** Variables del archivo, en orden, más las del catálogo que falten. */
  listar() {
    const lineas = this.leerLineas();
    const enArchivo = new Map<string, string>();
    for (const l of lineas) {
      const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (m) enArchivo.set(m[1], desquitar(m[2]));
    }
    const vistos = new Set<string>();
    const out: Array<EnvVarMeta & { valor: string | null; definida: boolean; enArchivo: boolean; secreto: boolean; grupo: string }> = [];
    const push = (key: string) => {
      if (vistos.has(key)) return;
      vistos.add(key);
      const meta = ENV_CATALOGO.find((m) => m.key === key) || { key, grupo: 'Otras', descripcion: '' };
      const secreto = esSecreto(key);
      const bruto = enArchivo.has(key) ? enArchivo.get(key)! : (process.env[key] ?? '');
      out.push({
        ...meta,
        secreto,
        valor: bruto ? (secreto ? mascara(bruto) : bruto) : null,
        definida: !!bruto,
        enArchivo: enArchivo.has(key),
      });
    };
    for (const m of ENV_CATALOGO) push(m.key);
    for (const k of enArchivo.keys()) push(k);
    return { ruta: this.ruta, vars: out };
  }

  /**
   * Aplica cambios: `{ CLAVE: 'valor' }`; un valor null/'' elimina la clave del
   * archivo (se deja comentada) y de process.env. Devuelve qué necesita reinicio.
   */
  guardar(cambios: Record<string, string | null>): { cambiadas: string[]; requierenReinicio: string[] } {
    const lineas = this.leerLineas();
    const cambiadas: string[] = [];
    const requierenReinicio: string[] = [];
    const pendientes = new Map(Object.entries(cambios));

    for (const [key] of pendientes) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Nombre de variable inválido: ${key}`);
    }

    const nuevas: string[] = [];
    for (const l of lineas) {
      const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (m && pendientes.has(m[1])) {
        const key = m[1];
        const valor = pendientes.get(key);
        pendientes.delete(key);
        if (valor === null || valor === '') {
          nuevas.push(`# ${l.trim()}   (quitada desde la GUI)`);
        } else {
          nuevas.push(`${key}=${citar(valor as string)}`);
        }
        cambiadas.push(key);
        continue;
      }
      nuevas.push(l);
    }
    // Claves que no estaban en el archivo.
    const agregar = [...pendientes.entries()].filter(([, v]) => v !== null && v !== '');
    if (agregar.length) {
      if (nuevas.length && nuevas[nuevas.length - 1].trim() !== '') nuevas.push('');
      nuevas.push('# Agregadas desde la GUI');
      for (const [key, valor] of agregar) { nuevas.push(`${key}=${citar(valor!)}`); cambiadas.push(key); }
    }

    fs.writeFileSync(this.ruta, nuevas.join('\n'), 'utf8');

    for (const key of cambiadas) {
      const valor = cambios[key];
      if (valor === null || valor === '') delete process.env[key];
      else process.env[key] = valor;
      const meta = ENV_CATALOGO.find((m) => m.key === key);
      if (!meta?.caliente) requierenReinicio.push(key);
    }
    return { cambiadas, requierenReinicio };
  }

  /** Reinicio del backend. En desarrollo (tsx watch) basta con tocar src/index.ts. */
  reiniciar(): { modo: 'watch' | 'exit' } {
    const entrada = process.argv[1] || '';
    const enWatch = /\.ts$/.test(entrada) || !!process.env.TSX_WATCH || process.env.npm_lifecycle_event === 'dev';
    const indexTs = path.resolve(process.cwd(), 'src/index.ts');
    if (enWatch && fs.existsSync(indexTs)) {
      const ahora = new Date();
      setTimeout(() => fs.utimesSync(indexTs, ahora, ahora), 300);
      return { modo: 'watch' };
    }
    setTimeout(() => process.exit(0), 300);
    return { modo: 'exit' };
  }
}

export const envSettingsService = new EnvSettingsService();
