import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { expandToolSpec, TOOLS_DISPONIBLES_A2A_POR_DEFECTO } from '../agents/tool_catalog.js';
import { sqliteReminderService } from '../database/sqlite.service.js';
import { customAgentsService } from '../agents/custom/custom_agents.service.js';

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
    /** Techo del canal: qué herramientas se montan en el agente público */
    disponibles?: string[];
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
  a2a:      { disponibles: TOOLS_DISPONIBLES_A2A_POR_DEFECTO, defaultTools: [], tokens: [] },
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
/** Herramientas que el canal A2A ofrece (techo del canal, no permiso del token) */
export function getToolsDisponiblesA2A(): string[] {
  const cfg = loadConfig();
  const base = expandToolSpec(cfg.a2a?.disponibles || TOOLS_DISPONIBLES_A2A_POR_DEFECTO);
  // Los agentes personalizados con "a2a" en su manifiesto también forman parte del techo
  // (aunque no estén marcados en Canales y tools), para que un token pueda recibirlos.
  return [...new Set([...base, ...customAgentsService.nombresParaCanal('a2a')])];
}

/**
 * Recorta el alcance de un token al techo del canal. No se descarta por
 * "peligrosa" sino por no estar ofrecida: si una herramienta no se monta en el
 * agente público, concederla a un token no significaría nada.
 */
function limitarAlTecho(nombre: string, tools: string[]): string[] {
  const techo = getToolsDisponiblesA2A();
  const dentro = tools.filter((t) => techo.includes(t));
  const fuera = tools.filter((t) => !techo.includes(t));
  if (fuera.length > 0) {
    console.warn(
      `🔒 [A2A] El token "${nombre}" tiene concedidas herramientas que el canal no ofrece: ${fuera.join(', ')}. ` +
      `Agrégalas a a2a.disponibles en config/channels.json si quieres que estén disponibles por A2A.`
    );
  }
  return dentro;
}

export function resolveA2AScope(presented: string | undefined): A2AScope | null {
  if (!presented) return null;

  const cfg = loadConfig();

  // 1) Tokens creados desde la GUI (SQLite). Van primero: son los que se revocan en caliente.
  //
  // El try envuelve SOLO la consulta. Antes abarcaba también el cálculo del
  // alcance, así que un error ahí se tragaba en silencio y un token perfectamente
  // válido terminaba devolviendo null, es decir un 401 de "no existe o fue
  // revocado" que manda a buscar el problema al lado equivocado.
  let fromDb: { name: string; tools: string[] } | null = null;
  try {
    fromDb = sqliteReminderService.findA2ATokenByValue(presented);
  } catch (err: any) {
    console.warn(`⚠️ [A2A] No se pudo consultar la tabla de tokens (${err.message}). Se sigue con config/channels.json.`);
  }
  if (fromDb) {
    return { name: fromDb.name, tools: limitarAlTecho(fromDb.name, expandToolSpec(fromDb.tools)) };
  }

  // 2) Tokens declarados en config/channels.json
  for (const entry of cfg.a2a?.tokens || []) {
    const expected = resolveTokenValue(entry.token);
    if (expected && expected === presented) {
      return { name: entry.name, tools: limitarAlTecho(entry.name, expandToolSpec(entry.tools || [])) };
    }
  }

  // Compatibilidad: la clave única A2A_API_KEY conserva el alcance por defecto
  if (process.env.A2A_API_KEY && presented === process.env.A2A_API_KEY) {
    return { name: 'default', tools: limitarAlTecho('default', expandToolSpec(cfg.a2a?.defaultTools || [])) };
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

/** Persiste el techo del canal A2A */
export function saveToolsDisponiblesA2A(tools: string[]): void {
  const cfg = loadConfig();
  const next: any = { ...cfg, a2a: { ...(cfg.a2a || {}), disponibles: tools } };
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
      disponibles: getToolsDisponiblesA2A(),
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

/** Solo para pruebas: fija el alcance en el contexto actual. En producción usa `runWithA2AScope`. */
export function setCurrentA2AScope(scope: A2AScope): void {
  a2aScopeStorage.enterWith(scope);
}

/**
 * Envuelve el resto de la petición con su alcance: al terminar, el contexto
 * desaparece solo. Con `enterWith` el alcance quedaba pegado al contexto del
 * socket (keep-alive) y podía sobrevivir a la petición.
 */
export function runWithA2AScope<T>(scope: A2AScope, fn: () => T): T {
  return a2aScopeStorage.run(scope, fn);
}

export function currentA2AScope(): A2AScope | undefined {
  return a2aScopeStorage.getStore();
}
