import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { expandToolSpec } from '../agents/tool_catalog.js';
import { sqliteReminderService } from '../database/sqlite.service.js';

/**
 * Configuración de qué herramientas ve cada canal.
 *
 * Dos modelos distintos a propósito:
 *
 * - TELEGRAM y BUZZ: lista fija. El interlocutor ya está acotado por otra vía
 *   (TELEGRAM_CHAT_ID en un caso, el canal de Buzz en el otro), así que basta
 *   declarar qué puede usarse.
 *
 * - A2A: por token. Cada token declara su propio set de herramientas, así un
 *   partner puede consultar documentación sin ver nada más. Un token desconocido
 *   no entra, y un token sin herramientas puede conversar pero no ejecutar nada.
 */
export interface ChannelConfigFile {
  telegram?: { tools: string[] };
  buzz?: { tools: string[] };
  api?: { tools: string[] };
  a2a?: {
    defaultTools?: string[];
    tokens?: Array<{ name: string; token: string; tools: string[] }>;
  };
}

export interface A2AScope {
  name: string;
  tools: string[];
}

const CONFIG_PATH = path.resolve(process.cwd(), 'config', 'channels.json');

/** Config por defecto si no existe el archivo: conserva el comportamiento actual. */
const DEFAULTS: Required<Pick<ChannelConfigFile, 'telegram' | 'buzz' | 'api'>> & { a2a: NonNullable<ChannelConfigFile['a2a']> } = {
  telegram: { tools: ['*'] },
  buzz:     { tools: ['*'] },
  api:      { tools: ['*'] },
  a2a:      { defaultTools: [], tokens: [] },
};

let cached: ChannelConfigFile | null = null;

function loadConfig(): ChannelConfigFile {
  if (cached) return cached;

  let fromFile: ChannelConfigFile = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } else {
      console.log(`ℹ️ [Channels] Sin ${CONFIG_PATH}: todos los canales internos quedan con acceso completo y A2A sin tokens.`);
    }
  } catch (err: any) {
    console.warn(`⚠️ [Channels] Error leyendo ${CONFIG_PATH} (${err.message}). Se usan los valores por defecto.`);
  }

  cached = {
    telegram: fromFile.telegram || DEFAULTS.telegram,
    buzz:     fromFile.buzz     || DEFAULTS.buzz,
    api:      fromFile.api      || DEFAULTS.api,
    a2a:      fromFile.a2a      || DEFAULTS.a2a,
  };
  return cached;
}

/** Releer la config sin reiniciar el proceso */
export function reloadChannelConfig(): ChannelConfigFile {
  cached = null;
  return loadConfig();
}

/** Herramientas habilitadas para un canal de lista fija */
export function getChannelTools(channel: 'telegram' | 'buzz' | 'api'): string[] {
  const cfg = loadConfig();
  return expandToolSpec(cfg[channel]?.tools || []);
}

/**
 * Resuelve el valor de un token. `env:NOMBRE` lee la variable de entorno, para no
 * dejar secretos escritos en el JSON.
 */
function resolveTokenValue(raw: string): string | null {
  if (!raw) return null;
  if (raw.startsWith('env:')) {
    return process.env[raw.slice(4)] || null;
  }
  return raw;
}

/**
 * Busca el alcance que corresponde a un token A2A presentado por el cliente.
 * Devuelve null si el token no existe: sin alcance no hay conversación.
 */
export function resolveA2AScope(presented: string | undefined): A2AScope | null {
  if (!presented) return null;

  const cfg = loadConfig();

  // 1) Tokens creados desde la GUI (SQLite). Van primero: son los que se revocan en caliente.
  try {
    const fromDb = sqliteReminderService.findA2ATokenByValue(presented);
    if (fromDb) {
      return { name: fromDb.name, tools: expandToolSpec(fromDb.tools) };
    }
  } catch {
    // Si la base no está disponible se sigue con la config en archivo
  }

  // 2) Tokens declarados en config/channels.json
  for (const entry of cfg.a2a?.tokens || []) {
    const expected = resolveTokenValue(entry.token);
    if (expected && expected === presented) {
      return { name: entry.name, tools: expandToolSpec(entry.tools || []) };
    }
  }

  // Compatibilidad: la clave única A2A_API_KEY conserva el alcance por defecto
  if (process.env.A2A_API_KEY && presented === process.env.A2A_API_KEY) {
    return { name: 'default', tools: expandToolSpec(cfg.a2a?.defaultTools || []) };
  }

  return null;
}

/** Guarda la lista de herramientas de un canal en config/channels.json */
export function saveChannelTools(channel: 'telegram' | 'buzz' | 'api', tools: string[]): void {
  const cfg = loadConfig();
  const next: any = { ...cfg, [channel]: { tools } };

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  cached = next;
}

/** Resumen legible de la configuración vigente (para diagnóstico) */
export function describeChannels() {
  const cfg = loadConfig();
  return {
    telegram: getChannelTools('telegram'),
    buzz:     getChannelTools('buzz'),
    api:      getChannelTools('api'),
    a2a: {
      defaultTools: expandToolSpec(cfg.a2a?.defaultTools || []),
      tokens: (cfg.a2a?.tokens || []).map((t) => ({
        name: t.name,
        configurado: !!resolveTokenValue(t.token),
        tools: expandToolSpec(t.tools || []),
      })),
    },
  };
}

// ─── Alcance A2A de la petición en curso ────────────────────────────────────
// El middleware de Express resuelve el token y deja el alcance acá; el executor
// del protocolo lo lee para construir el agente con las herramientas correctas.
const a2aScopeStorage = new AsyncLocalStorage<A2AScope>();

export function setCurrentA2AScope(scope: A2AScope): void {
  a2aScopeStorage.enterWith(scope);
}

export function currentA2AScope(): A2AScope | undefined {
  return a2aScopeStorage.getStore();
}
