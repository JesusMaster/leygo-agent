import { generarTexto } from '../llm/model_factory.js';
import { llmSettingsService } from '../../services/llm_settings.service.js';
import { customAgentsService, type CustomAgentManifest, type CustomToolDef, type CustomEnvVar } from './custom_agents.service.js';
import { compilar } from './sandbox.js';

/**
 * Generador de herramientas con IA para un agente personalizado.
 *
 * - generar(): de una petición en lenguaje natural a una herramienta completa (parámetros,
 *   código y tests), probada en el sandbox. NO la guarda: la GUI la deja como borrador
 *   para que Jesús la revise y la integre con "Guardar".
 * - sugerir(): herramientas recomendadas según la personalidad y lo que el agente ya sabe hacer.
 *
 * Usa el modelo asignado a 'agent_builder' en Ajustes (el mismo del agente programador).
 */

const MODELO_DEFECTO = 'gemini-3.8-flash';

const CONTRATO = `
# CONTRATO DEL CÓDIGO
- Es el CUERPO de: async (args, ctx) => { ... }. Termina con "return" de un objeto serializable
  (números, strings, objetos planos). Incluye datos de entrada y unidades en el retorno para que el
  agente pueda explicar el resultado.
- Disponible: Math, JSON, Date, Number, String, Array, Object, parseFloat, parseInt, ctx.log(...), ctx.now().
- ctx.env.NOMBRE: variables del agente. ctx.memory.search(q, limit)/save(text, meta) si el agente tiene memoria.
- ctx.fetch(url, init) SOLO si network=true: solo https, devuelve { status, ok, text, json }.
- PROHIBIDO: require, import, process, globalThis, archivos, eval. No existen en el sandbox.
- Valida los args (números finitos, strings no vacíos) y lanza Error con un mensaje claro si falta algo.
- Convierte unidades con constantes exactas y redondea resultados con decimales (Math.round(x*100)/100).
- Si necesitas una API key, léela de ctx.env y, si falta, devuelve { exito: false, error: 'Falta X: configúrala en Variables del agente' }.

# PARÁMETROS (JSON Schema)
- { "type": "object", "properties": {...}, "required": [...] }. TODO argumento que use el código va en
  "properties" con "type" y "description" (con unidades). "required" solo nombra claves de "properties".

# TESTS
- 1 a 3 casos con valores conocidos: { "args": {...}, "expect": <resultado EXACTO que devuelve el código> }.
- Cada test debe ejecutarse SIN lanzar error (un test que espera un error cuenta como fallido): no
  pongas casos de validación con args inválidos.
- Si la herramienta usa red, deja "tests": [] (los tests no pueden llamar a la red).

# ADJUNTOS (imágenes o archivos)
- Devuelve { adjuntos: [{ tipo: 'imagen'|'archivo', mime, base64, nombre, caption }], ...datos }. El sistema
  los guarda y el agente recibe un marcador. Nunca devuelvas base64 en otro campo.

# APIS DE GEMINI (si hacen falta)
- Texto: POST https://generativelanguage.googleapis.com/v1beta/models/<MODELO>:generateContent, header
  'x-goog-api-key': ctx.env.GEMINI_API_KEY, body {"contents":[{"parts":[{"text": prompt}]}]}; texto en
  candidates[0].content.parts[i].text.
- Imagen: mismo endpoint con "generationConfig":{"responseModalities":["IMAGE"],"imageConfig":{"aspectRatio":"9:16"}};
  la imagen viene en parts[i].inlineData { mimeType, data }.
- Usa SOLO modelos de la lista de disponibles que se entrega abajo. No inventes nombres.
`;

export interface ResultadoTest { args: any; ok: boolean; detalle?: string; resultado?: any }
export interface HerramientaGenerada {
  tool: CustomToolDef;
  tests: ResultadoTest[];
  envNuevas: CustomEnvVar[];
  nota: string;
  intentos: number;
}
export interface Sugerencia { nombre: string; titulo: string; descripcion: string; pedido: string; network: boolean; requiere?: string }

const cacheSugerencias = new Map<string, Sugerencia[]>();

function contextoAgente(m: CustomAgentManifest): string {
  const tools = m.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n') || '(ninguna)';
  const env = m.env.map((e) => `${e.name}${e.description ? ` (${e.description})` : ''}`).join(', ') || '(ninguna)';
  return [
    `AGENTE: ${m.displayName} (@${m.name})`,
    `CUÁNDO SE USA: ${m.description}`,
    `PERSONALIDAD (extracto):\n${m.soul.slice(0, 1800)}`,
    `HERRAMIENTAS QUE YA TIENE:\n${tools}`,
    `VARIABLES DECLARADAS: ${env}`,
    `MEMORIA PROPIA: ${m.memory ? 'sí' : 'no'}`,
  ].join('\n\n');
}

/** Modelos disponibles hoy (para que la IA no invente nombres). Corto y con límite de tiempo. */
async function modelosDisponibles(): Promise<string> {
  const lineas: string[] = [];
  for (const p of llmSettingsService.listProviders()) {
    if (!p.enabled) continue;
    try {
      const ms = await Promise.race([
        llmSettingsService.listModels(p.id),
        new Promise<string[]>((_, mal) => setTimeout(() => mal(new Error('timeout')), 8000)),
      ]);
      const utiles = ms.filter((m) => !/(embed|tts|audio|realtime|moderation|computer|robotics)/i.test(m)).slice(0, 40);
      lineas.push(`- ${p.id} (${p.kind}${p.kind === 'gemini' ? ', usa ctx.env.GEMINI_API_KEY' : ''}): ${utiles.join(', ')}`);
    } catch { /* proveedor sin respuesta: se omite */ }
  }
  return lineas.join('\n') || '(no se pudieron listar)';
}

/** Saca el primer bloque JSON de la respuesta del modelo (con o sin ```json). */
function extraerJson(texto: string): any {
  const limpio = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(limpio); } catch { /* sigue */ }
  const ini = Math.min(...['{', '['].map((c) => { const i = limpio.indexOf(c); return i < 0 ? Infinity : i; }));
  const fin = Math.max(limpio.lastIndexOf('}'), limpio.lastIndexOf(']'));
  if (Number.isFinite(ini) && fin > ini) return JSON.parse(limpio.slice(ini, fin + 1));
  throw new Error('La IA no devolvió JSON válido');
}

function normalizarTool(x: any, existentes: string[]): { tool: CustomToolDef; envNuevas: CustomEnvVar[]; nota: string } {
  let nombre = String(x?.name || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(nombre)) nombre = `tool_${nombre || 'nueva'}`;
  let final = nombre.slice(0, 50);
  for (let i = 2; existentes.includes(final); i++) final = `${nombre.slice(0, 46)}_${i}`;
  let params = x?.parameters;
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
  if (!params || typeof params !== 'object') params = { type: 'object', properties: {}, required: [] };
  params.type = 'object';
  params.properties = params.properties && typeof params.properties === 'object' ? params.properties : {};
  params.required = Array.isArray(params.required) ? params.required.filter((r: string) => r in params.properties) : [];
  const tests = Array.isArray(x?.tests) ? x.tests.filter((t: any) => t && typeof t.args === 'object').slice(0, 5) : [];
  const envNuevas = (Array.isArray(x?.env_nuevas) ? x.env_nuevas : [])
    .map((e: any) => ({ name: String(e?.name || '').toUpperCase().replace(/[^A-Z0-9_]/g, ''), description: String(e?.description || ''), secret: e?.secret !== false }))
    .filter((e: CustomEnvVar) => /^[A-Z][A-Z0-9_]*$/.test(e.name));
  return {
    tool: { name: final, description: String(x?.description || '').trim(), parameters: params, code: String(x?.code || '').trim(), network: !!x?.network, tests },
    envNuevas,
    nota: String(x?.nota || '').trim(),
  };
}

async function correrTests(agente: string, t: CustomToolDef): Promise<ResultadoTest[]> {
  const out: ResultadoTest[] = [];
  for (const c of t.tests || []) {
    try {
      const r = await customAgentsService.probarTool(agente, t.name, c.args, { code: t.code, network: t.network });
      if (!r.ok) out.push({ args: c.args, ok: false, detalle: r.error });
      else if (c.expect !== undefined && JSON.stringify(r.result) !== JSON.stringify(c.expect)) {
        out.push({ args: c.args, ok: false, resultado: r.result, detalle: `esperaba ${JSON.stringify(c.expect)} y devolvió ${JSON.stringify(r.result).slice(0, 200)}` });
      } else out.push({ args: c.args, ok: true, resultado: r.result });
    } catch (e: any) {
      out.push({ args: c.args, ok: false, detalle: e?.message || String(e) });
    }
  }
  return out;
}

export async function generarHerramienta(agente: string, pedido: string): Promise<HerramientaGenerada> {
  const m = customAgentsService.get(agente);
  if (!m) throw new Error(`No existe el agente ${agente}`);
  const texto = String(pedido || '').trim();
  if (texto.length < 8) throw new Error('Describe con un poco más de detalle qué debe hacer la herramienta');

  const base = [
    'Eres el ingeniero de herramientas de Yisus. Programas UNA herramienta para un agente personalizado.',
    contextoAgente(m),
    `PEDIDO DE JESÚS:\n${texto.slice(0, 2000)}`,
    CONTRATO,
    `MODELOS DISPONIBLES HOY:\n${await modelosDisponibles()}`,
    `RESPONDE SOLO con un objeto JSON (sin texto antes ni después) con esta forma:
{
  "name": "snake_case, verbo_objeto, distinto de las que ya tiene",
  "description": "qué hace y cuándo usarla (el modelo del agente lee esto para decidir)",
  "parameters": { "type": "object", "properties": { ... }, "required": [ ... ] },
  "code": "cuerpo JS de async (args, ctx) => { ... }",
  "network": false,
  "tests": [ { "args": { ... }, "expect": ... } ],
  "env_nuevas": [ { "name": "NOMBRE_EN_MAYUSCULAS", "description": "para qué es", "secret": true } ],
  "nota": "1-2 frases para Jesús: qué hace, supuestos y qué configurar (vacío si nada)"
}
"env_nuevas" solo incluye variables que el código lee de ctx.env y el agente aún no tiene.`,
  ].join('\n\n');

  const existentes = m.tools.map((t) => t.name);
  let prompt = base;
  let ultimo: HerramientaGenerada | null = null;
  for (let intento = 1; intento <= 2; intento++) {
    const crudo = await generarTexto('agent_builder', MODELO_DEFECTO, prompt);
    const { tool, envNuevas, nota } = normalizarTool(extraerJson(crudo), existentes);
    const errores: string[] = [];
    if (!tool.code) errores.push('falta el código');
    if (tool.description.length < 10) errores.push('la descripción es muy corta');
    const comp = tool.code ? compilar(tool.code, tool.name) : null;
    if (comp && !comp.ok) errores.push(comp.error);
    const tests = errores.length ? [] : await correrTests(agente, tool);
    for (const t of tests) if (!t.ok) errores.push(`test ${JSON.stringify(t.args)}: ${t.detalle}`);
    const envFaltan = envNuevas.filter((e) => !m.env.some((x) => x.name === e.name));
    ultimo = { tool, tests, envNuevas: envFaltan, nota, intentos: intento };
    if (!errores.length) return ultimo;
    // Un reintento con los errores concretos: suele bastar para corregir tests mal calculados.
    prompt = `${base}\n\nTU INTENTO ANTERIOR:\n${JSON.stringify({ ...tool, env_nuevas: envNuevas, nota })}\n\nFALLÓ POR:\n- ${errores.join('\n- ')}\n\nCorrígelo y responde de nuevo SOLO con el JSON completo.`;
  }
  return ultimo!;
}

export async function sugerirHerramientas(agente: string, refrescar = false): Promise<Sugerencia[]> {
  const m = customAgentsService.get(agente);
  if (!m) throw new Error(`No existe el agente ${agente}`);
  const clave = `${m.name}@${m.version}`;
  if (!refrescar && cacheSugerencias.has(clave)) return cacheSugerencias.get(clave)!;

  const prompt = [
    'Eres el ingeniero de herramientas de Yisus. Propón herramientas NUEVAS que harían más útil a este agente.',
    contextoAgente(m),
    `Reglas:
- Entre 4 y 6 propuestas, concretas y programables en JS en un sandbox (cálculos, conversiones, validaciones,
  formateo, o llamadas https a APIs públicas o a Gemini con una API key).
- No repitas lo que ya hace una herramienta existente. Prioriza lo que el agente más necesita según su rol.
- "pedido" es la instrucción en lenguaje natural, completa y específica (entradas, salida, unidades), que se
  usará para programarla.
- "requiere" solo si necesita algo externo (p. ej. "API key de OpenWeather"); si no, omítelo.`,
    `RESPONDE SOLO con un arreglo JSON:
[ { "nombre": "snake_case", "titulo": "Nombre corto legible", "descripcion": "1 frase de para qué sirve",
    "pedido": "instrucción completa para programarla", "network": false, "requiere": "opcional" } ]`,
  ].join('\n\n');

  const crudo = await generarTexto('agent_builder', MODELO_DEFECTO, prompt);
  const lista = extraerJson(crudo);
  const existentes = new Set(m.tools.map((t) => t.name));
  const sugerencias: Sugerencia[] = (Array.isArray(lista) ? lista : [])
    .map((s: any) => ({
      nombre: String(s?.nombre || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
      titulo: String(s?.titulo || s?.nombre || '').slice(0, 60),
      descripcion: String(s?.descripcion || '').slice(0, 240),
      pedido: String(s?.pedido || s?.descripcion || '').slice(0, 1500),
      network: !!s?.network,
      ...(s?.requiere ? { requiere: String(s.requiere).slice(0, 80) } : {}),
    }))
    .filter((s: Sugerencia) => s.titulo && s.pedido && !existentes.has(s.nombre))
    .slice(0, 6);
  cacheSugerencias.set(clave, sugerencias);
  return sugerencias;
}
