import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { customAgentsService, type CustomAgentManifest } from '../custom/custom_agents.service.js';
import { currentUsageScope } from '../../utils/usage_collector.js';
import { llmSettingsService } from '../../services/llm_settings.service.js';

/** Solo Jesús (Telegram, API, GUI) puede crear o cambiar agentes. */
function externo(): boolean {
  const ch = currentUsageScope()?.channel;
  return ch === 'buzz' || ch === 'a2a';
}
const SOLO_JESUS = { status: 'sin_permiso', result: 'Solo Jesús puede crear o modificar agentes.' };

const toolSchema = z.object({
  name: z.string().describe('snake_case, p. ej. "km_a_millas"'),
  description: z.string().describe('Qué hace y cuándo usarla (lo lee el modelo del agente).'),
  parameters: z.string().describe('JSON Schema serializado como STRING (JSON.stringify), p. ej. \'{"type":"object","properties":{"km":{"type":"number","description":"…"}},"required":["km"]}\'. Cada clave de "required" debe existir en "properties".'),
  code: z.string().describe('Cuerpo de `async (args, ctx) => { … }`. Debe terminar con `return <valor serializable>`. Sin require/import/process. Disponibles: Math, JSON, Date, ctx.env.X, ctx.memory (si el agente tiene memoria), ctx.fetch(url) solo si network=true, ctx.log().'),
  network: z.boolean().optional().describe('true si necesita ctx.fetch (solo https).'),
  tests: z.array(z.object({ args: z.any(), expect: z.any().optional(), note: z.string().optional() })).optional().describe('1-3 casos que se ejecutan al guardar; si fallan, la creación se rechaza.'),
});

const manifestSchema = z.object({
  name: z.string().describe('slug: minúsculas, dígitos y _, p. ej. "nami"'),
  displayName: z.string().describe('Nombre visible, p. ej. "Nami"'),
  description: z.string().describe('1-2 frases: para qué sirve y cuándo debe delegarle el Coordinator. Es el texto de ruteo.'),
  soul: z.string().describe('Personalidad, tono, rol y cómo trabaja. Escribe 1-3 párrafos en segunda persona ("Eres…").'),
  tools: z.array(toolSchema).describe('Herramientas programadas. Una por capacidad concreta.'),
  env: z.array(z.object({ name: z.string(), description: z.string(), secret: z.boolean().optional() })).optional().describe('Variables que necesitan sus herramientas (API keys, URLs). Jesús les pone valor en Ajustes.'),
  memory: z.boolean().optional().describe('true si debe recordar cosas entre conversaciones (memoria episódica propia).'),
  model: z.string().optional().describe('"<proveedor>/<modelo>" o vacío para el por defecto.'),
  channels: z.array(z.enum(['telegram', 'api', 'buzz', 'a2a'])).optional().describe('Dónde queda disponible. Por defecto telegram y api.'),
});

export const createCustomAgent = new FunctionTool({
  name: 'create_custom_agent',
  description: 'Crea un agente personalizado con sus herramientas programadas y lo monta en caliente en el Coordinator. Valida el código, corre los tests y rechaza si algo falla (corrige y vuelve a llamar).',
  parameters: manifestSchema as any,
  execute: async (args: any) => {
    if (externo()) return SOLO_JESUS;
    try {
      const { manifest } = await customAgentsService.crear({ ...args, createdBy: 'ia' } as Partial<CustomAgentManifest>);
      return { status: 'success', result: resumen(manifest, 'creado y montado') };
    } catch (err: any) { return { status: 'error', message: err.message }; }
  },
});

export const updateCustomAgent = new FunctionTool({
  name: 'update_custom_agent',
  description: 'Modifica un agente personalizado existente: soul, descripción, herramientas (la lista reemplaza a la anterior: incluye las que se conservan), env, memoria, modelo, canales o enabled. Se vuelve a montar en caliente.',
  parameters: manifestSchema.partial().extend({ name: z.string(), enabled: z.boolean().optional() }) as any,
  execute: async (args: any) => {
    if (externo()) return SOLO_JESUS;
    try {
      const { name, ...cambios } = args;
      const { manifest } = await customAgentsService.actualizar(name, cambios);
      return { status: 'success', result: resumen(manifest, 'actualizado') };
    } catch (err: any) { return { status: 'error', message: err.message }; }
  },
});

export const listCustomAgents = new FunctionTool({
  name: 'list_custom_agents',
  description: 'Lista los agentes personalizados existentes con sus herramientas, canales y estado.',
  parameters: z.object({}) as any,
  execute: async () => {
    const lista = customAgentsService.list();
    if (!lista.length) return { status: 'success', result: 'No hay agentes personalizados todavía.' };
    return { status: 'success', result: lista.map((m) => resumen(m, m.enabled ? 'activo' : 'desactivado')).join('\n\n') };
  },
});

export const getCustomAgent = new FunctionTool({
  name: 'get_custom_agent',
  description: 'Devuelve la definición completa de un agente personalizado (soul, herramientas con su código, env, memoria) para revisarlo o modificarlo.',
  parameters: z.object({ name: z.string() }) as any,
  execute: async (args: any) => {
    const m = customAgentsService.get(args.name);
    if (!m) return { status: 'error', message: `No existe el agente ${args.name}` };
    return { status: 'success', result: JSON.stringify(m, null, 2) };
  },
});

export const deleteCustomAgent = new FunctionTool({
  name: 'delete_custom_agent',
  description: 'Elimina un agente personalizado (solo si Jesús lo pidió explícitamente).',
  parameters: z.object({ name: z.string() }) as any,
  execute: async (args: any) => {
    if (externo()) return SOLO_JESUS;
    return customAgentsService.eliminar(args.name) ? { status: 'success', result: `Agente ${args.name} eliminado.` } : { status: 'error', message: `No existe el agente ${args.name}` };
  },
});

export const testCustomTool = new FunctionTool({
  name: 'test_custom_tool',
  description: 'Ejecuta una herramienta de un agente personalizado con argumentos de prueba y devuelve el resultado o el error (útil para verificar antes o después de crear).',
  parameters: z.object({ agent: z.string(), tool: z.string(), args: z.any() }) as any,
  execute: async (args: any) => {
    try {
      const r = await customAgentsService.probarTool(args.agent, args.tool, args.args || {});
      return r.ok ? { status: 'success', result: JSON.stringify(r.result), logs: r.logs, ms: r.ms } : { status: 'error', message: r.error, logs: r.logs };
    } catch (err: any) { return { status: 'error', message: err.message }; }
  },
});

function resumen(m: CustomAgentManifest, estado: string): string {
  return `**${m.displayName}** ('${m.name}') — ${estado}\n  ${m.description}\n  Herramientas: ${m.tools.map((t) => t.name).join(', ') || 'ninguna'}${m.memory ? ' + memoria propia' : ''}\n  Canales: ${m.channels.join(', ')}${m.env.length ? `\n  Variables: ${m.env.map((e) => e.name).join(', ')} (configúralas en Ajustes → Claves y variables como AGENT_${m.name.toUpperCase()}_<NOMBRE>)` : ''}${m.model ? `\n  Modelo: ${m.model}` : ''}`;
}

/**
 * Modelos REALES de los proveedores configurados en Ajustes. El programador debe
 * consultarlos antes de escribir una herramienta que llame a un LLM o a una API de
 * generación (imágenes, audio): adivinar nombres de modelo de memoria produce
 * herramientas que nacen rotas (p. ej. "imagen-3.0-generate-002" ya no existe).
 */
export const listProviderModels = new FunctionTool({
  name: 'list_provider_models',
  description: 'Lista los proveedores LLM configurados (id, tipo, baseUrl, si tienen clave) y los modelos que cada uno ofrece HOY según su API. Úsala antes de programar una herramienta que llame a un modelo (texto, imagen, audio). "filtro" acota por texto, p. ej. "image".',
  parameters: z.object({ filtro: z.string().optional().describe('Subcadena para filtrar modelos, p. ej. "image", "flash", "tts"'), proveedor: z.string().optional().describe('id del proveedor (p. ej. "gemini"); vacío = todos') }) as any,
  execute: async (args: any) => {
    const filtro = String(args?.filtro || '').toLowerCase();
    const out: any[] = [];
    for (const p of llmSettingsService.listProviders()) {
      if (!p.enabled) continue;
      if (args?.proveedor && p.id !== args.proveedor) continue;
      let modelos: string[] = [];
      try { modelos = await llmSettingsService.listModels(p.id); } catch (err: any) { modelos = [`(no se pudieron listar: ${err.message})`]; }
      if (filtro) modelos = modelos.filter((m) => m.toLowerCase().includes(filtro));
      out.push({ id: p.id, kind: p.kind, baseUrl: llmSettingsService.baseUrlEfectiva(p) || null, tieneKey: !!(p as any).tieneKey, envKeySugerida: p.kind === 'gemini' ? 'GEMINI_API_KEY' : undefined, modelos });
    }
    return { status: 'success', result: out };
  },
});
