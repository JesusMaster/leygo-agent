import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentTool, FunctionTool, LlmAgent } from '@google/adk';
import { modelFor, construirLlm } from '../llm/model_factory.js';
import { ejecutar, compilar, fetchSeguro, type SandboxCtx } from './sandbox.js';
import { qdrantService, QdrantKnowledgeService } from '../../services/qdrant.service.js';
import { llmSettingsService } from '../../services/llm_settings.service.js';

/**
 * Agentes personalizados ("self agents"): los crea el agente programador (o la
 * GUI) a partir de una descripción, viven en data/agents/<nombre>/agent.json,
 * y se montan en caliente como herramienta del Coordinator de los canales que
 * elijan. Sus herramientas son código JS que corre en un sandbox (node:vm).
 */

export type CanalAgente = 'telegram' | 'api' | 'buzz' | 'a2a';

export interface CustomToolDef {
  name: string;
  description: string;
  /** JSON Schema simple: { type:'object', properties:{...}, required:[...] } */
  parameters: any;
  /** Cuerpo de `async (args, ctx) => { … return … }` */
  code: string;
  /** Permite ctx.fetch (solo https) */
  network?: boolean;
  /** Casos de prueba: se corren al crear/actualizar */
  tests?: Array<{ args: any; expect?: any; note?: string }>;
}

export interface CustomEnvVar { name: string; description: string; secret?: boolean; }

export interface CustomAgentManifest {
  name: string;               // slug: minúsculas, dígitos y _
  displayName: string;
  description: string;        // cuándo usarlo (lo ve el Coordinator para rutear)
  soul: string;               // personalidad e instrucciones
  tools: CustomToolDef[];
  env: CustomEnvVar[];
  memory: boolean;            // memoria episódica propia (Qdrant) con memory_search / memory_save
  model: string | null;       // "<proveedor>/<modelo>" o null = Ajustes / Gemini por defecto
  channels: CanalAgente[];
  enabled: boolean;
  createdBy: 'ia' | 'gui';
  createdAt: string;
  updatedAt: string;
  version: number;
}

const DIR = path.resolve(process.cwd(), 'data', 'agents');
const SLUG = /^[a-z][a-z0-9_]{1,30}$/;
const RESERVADOS = new Set(['coordinator', 'yisus', 'knowledge_agent', 'faq_agent', 'account_agent', 'triage_agent', 'commitments_agent', 'knowledge_public', 'agent_builder']);

type Registro = { manifest: CustomAgentManifest; agent: LlmAgent; tool: AgentTool; directo?: LlmAgent; runners?: Map<string, any> };

/** "@nami …" al inicio del mensaje (solo se atiende si el slug es un agente personalizado). */
const MENCION = /^\s*@([a-z][a-z0-9_]{1,30})\b[\s:,;\-–—]*/i;

export type Mencion =
  | { tipo: 'ok'; name: string; displayName: string; texto: string }
  | { tipo: 'no_disponible'; name: string; displayName: string; motivo: string };

/** Coordinadores vivos por canal: para montar/desmontar herramientas sin reiniciar. */
type Vivo = { agent: LlmAgent; wrap?: (tool: any) => any };
const coordinadoresVivos = new Map<string, Vivo[]>();
/** `wrap` envuelve la herramienta antes de montarla (A2A: guard de permisos por token). */
export function registrarCoordinadorVivo(canal: string, agent: LlmAgent, wrap?: (tool: any) => any) {
  const lista = coordinadoresVivos.get(canal) || [];
  lista.push({ agent, wrap });
  coordinadoresVivos.set(canal, lista);
}

function schemaGemini(json: any): any {
  const tipo = String(json?.type || 'object').toUpperCase();
  const out: any = { type: tipo };
  if (json?.description) out.description = json.description;
  if (tipo === 'OBJECT') {
    out.properties = {};
    for (const [k, v] of Object.entries(json?.properties || {})) out.properties[k] = schemaGemini(v);
    if (Array.isArray(json?.required) && json.required.length) out.required = json.required;
  }
  if (tipo === 'ARRAY') out.items = schemaGemini(json?.items || { type: 'string' });
  if (Array.isArray(json?.enum)) out.enum = json.enum;
  return out;
}

/** Avisos de progreso (tests, montaje) hacia quien esté escuchando el turno del builder (SSE de la GUI). */
const progreso = new AsyncLocalStorage<(msg: string, nivel?: 'info' | 'ok' | 'error') => void>();
export function conProgreso<T>(cb: (msg: string, nivel?: 'info' | 'ok' | 'error') => void, fn: () => Promise<T>): Promise<T> {
  return progreso.run(cb, fn);
}
function avisar(msg: string, nivel: 'info' | 'ok' | 'error' = 'info') {
  try { progreso.getStore()?.(msg, nivel); } catch { /* el oyente no debe romper el flujo */ }
}

class CustomAgentsService {
  private registro = new Map<string, Registro>();
  private cargado = false;
  /** Catálogo global de herramientas (lo inyecta tool_catalog.ts para evitar un import circular). */
  private catalogo: Record<string, any> | null = null;
  private grupos: Record<string, string[]> | null = null;

  setCatalogo(catalogo: Record<string, any>, grupos: Record<string, string[]>) {
    this.catalogo = catalogo;
    this.grupos = grupos;
    if (!this.grupos.personalizados) this.grupos.personalizados = [];
    for (const r of this.registro.values()) this.publicarEnCatalogo(r.manifest.name, r.tool);
  }

  private publicarEnCatalogo(name: string, tool: AgentTool) {
    if (!this.catalogo || !this.grupos) return;
    this.catalogo[name] = tool;
    if (!this.grupos.personalizados.includes(name)) this.grupos.personalizados.push(name);
  }

  private quitarDelCatalogo(name: string) {
    if (!this.catalogo || !this.grupos) return;
    delete this.catalogo[name];
    this.grupos.personalizados = this.grupos.personalizados.filter((n) => n !== name);
  }

  // ─── Persistencia ─────────────────────────────────────────────────────
  private rutaDe(name: string) { return path.join(DIR, name, 'agent.json'); }

  list(): CustomAgentManifest[] {
    this.cargarTodo();
    return [...this.registro.values()].map((r) => r.manifest).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  get(name: string): CustomAgentManifest | null {
    this.cargarTodo();
    return this.registro.get(name)?.manifest || null;
  }

  /** Lee todos los manifiestos y los monta (se llama al arrancar y es idempotente). */
  cargarTodo(): void {
    if (this.cargado) return;
    this.cargado = true;
    fs.mkdirSync(DIR, { recursive: true });
    for (const d of fs.readdirSync(DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const ruta = this.rutaDe(d.name);
      if (!fs.existsSync(ruta)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(ruta, 'utf8')) as CustomAgentManifest;
        this.montar(m, false);
      } catch (err: any) {
        console.warn(`⚠️ [Agentes] No se pudo cargar ${d.name}: ${err?.message}`);
      }
    }
    if (this.registro.size) console.log(`🧩 [Agentes] ${this.registro.size} agente(s) personalizado(s): ${[...this.registro.keys()].join(', ')}`);
  }

  private guardar(m: CustomAgentManifest) {
    fs.mkdirSync(path.dirname(this.rutaDe(m.name)), { recursive: true });
    fs.writeFileSync(this.rutaDe(m.name), JSON.stringify(m, null, 2), 'utf8');
    // soul.md es solo una vista legible para quien abra la carpeta.
    fs.writeFileSync(path.join(DIR, m.name, 'soul.md'), `# ${m.displayName}\n\n${m.soul}\n`, 'utf8');
  }

  // ─── Validación ──────────────────────────────────────────────────────
  validar(input: Partial<CustomAgentManifest>, existente?: CustomAgentManifest): { ok: true; manifest: CustomAgentManifest } | { ok: false; errores: string[] } {
    const errores: string[] = [];
    const name = String(input.name || existente?.name || '').trim();
    if (!SLUG.test(name)) errores.push('name: usa minúsculas, dígitos y _ (2-31 caracteres, empieza con letra), p. ej. "nami"');
    if (RESERVADOS.has(name)) errores.push(`name "${name}" está reservado`);
    const displayName = String(input.displayName ?? existente?.displayName ?? '').trim();
    if (!displayName) errores.push('displayName es obligatorio');
    const description = String(input.description ?? existente?.description ?? '').trim();
    if (description.length < 15) errores.push('description: explica en 1-2 frases cuándo debe usarlo el Coordinator');
    const soul = String(input.soul ?? existente?.soul ?? '').trim();
    if (soul.length < 20) errores.push('soul: describe personalidad, tono y cómo debe trabajar');

    const tools: CustomToolDef[] = [];
    const vistos = new Set<string>();
    for (const t of (input.tools ?? existente?.tools ?? []) as any[]) {
      const tn = String(t?.name || '').trim();
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(tn)) { errores.push(`tool "${tn || '?'}": nombre inválido (minúsculas, dígitos, _)`); continue; }
      if (vistos.has(tn)) { errores.push(`tool "${tn}" repetida`); continue; }
      vistos.add(tn);
      if (!t.description || String(t.description).length < 10) errores.push(`tool "${tn}": falta description`);
      let params: any = t.parameters;
      if (typeof params === 'string') {
        try { params = params.trim() ? JSON.parse(params) : null; } catch (e: any) { errores.push(`tool "${tn}": parameters no es JSON válido (${e.message})`); params = null; }
      }
      if (!params || typeof params !== 'object') params = { type: 'object', properties: {} };
      if (!params.type) params.type = 'object';
      if (String(params.type).toLowerCase() !== 'object') errores.push(`tool "${tn}": parameters.type debe ser "object"`);
      if (!params.properties || typeof params.properties !== 'object') params.properties = {};
      for (const [pk, pv] of Object.entries<any>(params.properties)) {
        if (!pv || typeof pv !== 'object' || !pv.type) errores.push(`tool "${tn}": parameters.properties.${pk} necesita "type"`);
      }
      if (Array.isArray(params.required)) {
        const faltan = params.required.filter((k: any) => !(k in params.properties));
        if (faltan.length) errores.push(`tool "${tn}": "required" nombra propiedades que no existen en "properties": ${faltan.join(', ')} (agrégalas a properties)`);
      }
      const code = String(t.code || '');
      if (!code.trim()) errores.push(`tool "${tn}": falta code`);
      else {
        const c = compilar(code, tn);
        if (!c.ok) errores.push(`tool "${tn}": ${c.error}`);
        if (/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bglobalThis\b/.test(code)) errores.push(`tool "${tn}": no se permite require/import/process/globalThis`);
      }
      tools.push({ name: tn, description: String(t.description || ''), parameters: params, code, network: !!t.network, tests: Array.isArray(t.tests) ? t.tests.slice(0, 10) : [] });
    }

    const env: CustomEnvVar[] = [];
    for (const e of (input.env ?? existente?.env ?? []) as any[]) {
      const en = String(e?.name || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(en)) { errores.push(`env "${en || '?'}": nombre inválido`); continue; }
      env.push({ name: en, description: String(e?.description || ''), secret: !!e?.secret });
    }

    const channels = ((input.channels ?? existente?.channels ?? ['telegram', 'api']) as string[]).filter((c) => ['telegram', 'api', 'buzz', 'a2a'].includes(c)) as CanalAgente[];
    const model = input.model !== undefined ? (input.model ? String(input.model) : null) : (existente?.model ?? null);
    if (model && !llmSettingsService.resolverRef(model)) errores.push(`model "${model}": proveedor desconocido (usa "<proveedor>/<modelo>" de Ajustes)`);

    if (errores.length) return { ok: false, errores };
    const ahora = new Date().toISOString();
    return {
      ok: true,
      manifest: {
        name, displayName, description, soul, tools, env, channels, model,
        memory: input.memory !== undefined ? !!input.memory : (existente?.memory ?? false),
        enabled: input.enabled !== undefined ? !!input.enabled : (existente?.enabled ?? true),
        createdBy: existente?.createdBy || (input.createdBy === 'gui' ? 'gui' : 'ia'),
        createdAt: existente?.createdAt || ahora,
        updatedAt: ahora,
        version: (existente?.version || 0) + 1,
      },
    };
  }

  /** Corre los tests declarados de cada herramienta; devuelve fallos legibles. */
  async probarTools(m: CustomAgentManifest): Promise<string[]> {
    const fallos: string[] = [];
    for (const t of m.tools) {
      const casos = t.tests || [];
      avisar(`Probando ${t.name} (${casos.length} test${casos.length === 1 ? '' : 's'})…`);
      let fallosTool = 0;
      for (const [i, caso] of casos.entries()) {
        const r = await ejecutar(t.code, caso.args, this.ctxPara(m, t), t.name);
        if (!r.ok) { fallos.push(`${t.name} test #${i + 1}: ${r.error}`); fallosTool++; continue; }
        if (caso.expect !== undefined && JSON.stringify(r.result) !== JSON.stringify(caso.expect)) {
          fallos.push(`${t.name} test #${i + 1}: esperaba ${JSON.stringify(caso.expect)} y devolvió ${JSON.stringify(r.result).slice(0, 200)}`);
          fallosTool++;
        }
      }
      if (casos.length) avisar(fallosTool ? `${t.name}: ${fallosTool} test${fallosTool === 1 ? '' : 's'} fallaron` : `${t.name}: tests OK`, fallosTool ? 'error' : 'ok');
    }
    return fallos;
  }

  async probarTool(name: string, toolName: string, args: any) {
    const m = this.get(name);
    if (!m) throw new Error(`No existe el agente ${name}`);
    const t = m.tools.find((x) => x.name === toolName);
    if (!t) throw new Error(`El agente ${name} no tiene la herramienta ${toolName}`);
    return ejecutar(t.code, args, this.ctxPara(m, t), t.name);
  }

  // ─── Alta / edición / baja ───────────────────────────────────────────
  async crear(input: Partial<CustomAgentManifest>): Promise<{ manifest: CustomAgentManifest; fallosTests: string[] }> {
    this.cargarTodo();
    const v = this.validar(input);
    if (!v.ok) throw new Error(v.errores.join(' · '));
    if (this.registro.has(v.manifest.name)) throw new Error(`Ya existe un agente llamado "${v.manifest.name}"`);
    const fallosTests = await this.probarTools(v.manifest);
    if (fallosTests.length) throw new Error(`Los tests de las herramientas fallaron: ${fallosTests.join(' · ')}`);
    this.guardar(v.manifest);
    this.montar(v.manifest, true);
    return { manifest: v.manifest, fallosTests };
  }

  async actualizar(name: string, cambios: Partial<CustomAgentManifest>): Promise<{ manifest: CustomAgentManifest; fallosTests: string[] }> {
    this.cargarTodo();
    const actual = this.get(name);
    if (!actual) throw new Error(`No existe el agente ${name}`);
    const v = this.validar({ ...cambios, name }, actual);
    if (!v.ok) throw new Error(v.errores.join(' · '));
    const fallosTests = cambios.tools ? await this.probarTools(v.manifest) : [];
    if (fallosTests.length) throw new Error(`Los tests de las herramientas fallaron: ${fallosTests.join(' · ')}`);
    this.desmontar(name);
    this.guardar(v.manifest);
    this.montar(v.manifest, true);
    return { manifest: v.manifest, fallosTests };
  }

  eliminar(name: string): boolean {
    this.cargarTodo();
    if (!this.registro.has(name)) return false;
    this.desmontar(name);
    fs.rmSync(path.join(DIR, name), { recursive: true, force: true });
    return true;
  }

  // ─── Montaje en caliente ─────────────────────────────────────────────
  private montar(m: CustomAgentManifest, enCaliente: boolean) {
    const agent = this.construirAgente(m);
    const tool = new AgentTool({ agent });
    this.registro.set(m.name, { manifest: m, agent, tool });
    this.publicarEnCatalogo(m.name, tool);
    if (!m.enabled) return;
    for (const canal of m.channels) {
      for (const { agent: coord, wrap } of coordinadoresVivos.get(canal) || []) {
        if (!(coord.tools as any[]).some((t: any) => t?.name === m.name)) (coord.tools as any[]).push(wrap ? wrap(tool) : tool);
      }
    }
    if (enCaliente) {
      console.log(`🧩 [Agentes] "${m.displayName}" (${m.name}) montado en ${m.channels.join(', ') || 'ningún canal'}`);
      avisar(`${m.displayName} montado en ${m.channels.join(', ') || 'ningún canal'}`, 'ok');
    }
  }

  private desmontar(name: string) {
    for (const lista of coordinadoresVivos.values()) {
      for (const { agent: coord } of lista) {
        const i = (coord.tools as any[]).findIndex((t: any) => t?.name === name);
        if (i >= 0) (coord.tools as any[]).splice(i, 1);
      }
    }
    this.registro.delete(name);
    this.quitarDelCatalogo(name);
  }

  /** Herramientas (AgentTool) de los agentes habilitados para un canal: para construir coordinadores. */
  toolsParaCanal(canal: CanalAgente): AgentTool[] {
    this.cargarTodo();
    return [...this.registro.values()].filter((r) => r.manifest.enabled && r.manifest.channels.includes(canal)).map((r) => r.tool);
  }

  /** Nombres de los agentes personalizados habilitados para un canal (para techos de permisos). */
  nombresParaCanal(canal: CanalAgente): string[] {
    this.cargarTodo();
    return [...this.registro.values()].filter((r) => r.manifest.enabled && r.manifest.channels.includes(canal)).map((r) => r.manifest.name);
  }

  /**
   * Une las herramientas del canal (config/channels.json) con las de los agentes
   * personalizados, sin repetir nombres: un agente puede venir por las dos vías
   * (marcado en "Canales y tools" Y con el canal en su manifiesto) y el ADK aborta
   * con "Duplicate tool name".
   */
  unirSinDuplicar(base: any[], extra: any[]): any[] {
    const vistos = new Set<string>();
    const out: any[] = [];
    for (const t of [...base, ...extra]) {
      const n = String(t?.name || '');
      if (n && vistos.has(n)) continue;
      if (n) vistos.add(n);
      out.push(t);
    }
    return out;
  }

  /** Texto de ruteo que el Coordinator agrega a su instrucción (dinámico). */
  seccionRuteo(canal: CanalAgente): string {
    const lista = this.list().filter((m) => m.enabled && m.channels.includes(canal));
    if (!lista.length) return '';
    return `\n\n# AGENTES PERSONALIZADOS DISPONIBLES\n\nJesús creó estos agentes especialistas. Cuando la consulta calce con su descripción, delega en la herramienta del mismo nombre y entrega su respuesta respetando su personalidad (no la reescribas en tu tono):\n${lista.map((m) => `- **${m.displayName}** → herramienta '${m.name}': ${m.description}`).join('\n')}`;
  }

  nombres(): string[] { this.cargarTodo(); return [...this.registro.keys()]; }
  toolDe(name: string): AgentTool | undefined { this.cargarTodo(); return this.registro.get(name)?.tool; }
  agenteDe(name: string): LlmAgent | undefined { this.cargarTodo(); return this.registro.get(name)?.agent; }

  // ─── Construcción del LlmAgent ───────────────────────────────────────
  private construirAgente(m: CustomAgentManifest, modo: 'tool' | 'directo' = 'tool'): LlmAgent {
    const tools: any[] = m.tools.map((t) => new FunctionTool({
      name: t.name,
      description: t.description,
      parameters: schemaGemini(t.parameters) as any,
      execute: async (args: any) => {
        const r = await ejecutar(t.code, args, this.ctxPara(m, t), t.name);
        if (!r.ok) return { status: 'error', message: r.error, logs: r.logs };
        return { status: 'success', result: r.result, ...(r.logs.length ? { logs: r.logs } : {}) };
      },
    }));
    if (m.memory) tools.push(...this.toolsMemoria(m));

    const envDoc = m.env.length ? `\n\nVARIABLES DISPONIBLES PARA TUS HERRAMIENTAS: ${m.env.map((e) => e.name).join(', ')} (${m.env.filter((e) => !this.valorEnv(m, e.name)).map((e) => e.name).join(', ') || 'todas'} ${m.env.some((e) => !this.valorEnv(m, e.name)) ? 'AÚN SIN VALOR: avísalo si una herramienta falla por eso' : 'configuradas'}).` : '';
    const memDoc = m.memory ? `\n\nMEMORIA: tienes memoria propia. Usa 'memory_save' para guardar datos que Jesús te pida recordar o que valga la pena retener (preferencias, resultados, contexto), y 'memory_search' antes de responder algo que pudo haberse hablado antes.` : '';

    const ref = m.model ? llmSettingsService.resolverRef(m.model) : null;
    const comoTrabajas = modo === 'directo'
      ? `- Jesús te habla directamente (te mencionó con @${m.name}), sin pasar por el Coordinator de Yisus: respóndele tú, en tu personalidad, con la respuesta completa.`
      : `- Estás montado como herramienta del Coordinator de Yisus (el agente de Jesús Leiva): recibes una consulta, la resuelves con tus herramientas y terminas el turno con la respuesta completa.`;
    const base = `${m.soul}

# CÓMO TRABAJAS
${comoTrabajas}
- Usa tus herramientas para calcular o consultar en vez de estimar de cabeza; muestra los datos de entrada y el resultado.
- Si te falta un dato para calcular, pídelo en una sola pregunta clara.
- Responde en español salvo que te hablen en otro idioma. Tus respuestas se leen en Telegram, chat y GUI: usa markdown simple y escribe fórmulas en texto plano (p. ej. 32 × 3 = 96 NM), nunca LaTeX ($…$).${envDoc}${memDoc}`;
    return new LlmAgent({
      name: m.name,
      model: ref ? construirLlm(ref.provider, ref.model, m.name) : modelFor(m.name, 'gemini-3.8-flash'),
      includeContents: 'none',
      description: m.description,
      // En modo directo el agente no ve el historial del Coordinator: solo sus propios turnos @slug de la sesión.
      instruction: modo === 'directo' ? (ctx: any) => base + this.historialDirecto(m.name, ctx) : base,
      tools,
    });
  }

  /** Últimos intercambios "@slug" de la sesión (pregunta de Jesús + respuesta del agente), para continuidad. */
  private historialDirecto(name: string, ctx: any, max = 6): string {
    const eventos: any[] = ctx?.invocationContext?.session?.events || [];
    const actual = ctx?.invocationContext?.invocationId;
    const pares: { q: string; a: string }[] = [];
    let pendiente: string | null = null;
    for (const ev of eventos) {
      if (ev?.invocationId && ev.invocationId === actual) break;
      const texto = (ev?.content?.parts || []).map((p: any) => p?.text || '').filter(Boolean).join('').trim();
      if (!texto) continue;
      if (ev.author === 'user') { pendiente = texto; continue; }
      if (ev.author === name && !ev.partial && pendiente !== null) { pares.push({ q: pendiente, a: texto }); pendiente = null; }
    }
    if (!pares.length) return '';
    const ultimos = pares.slice(-max);
    return `\n\n# CONVERSACIÓN PREVIA CONTIGO (esta sesión, del más antiguo al más reciente)\n` +
      ultimos.map((p) => `Jesús: ${p.q.slice(0, 600)}\nTú: ${p.a.slice(0, 900)}`).join('\n\n');
  }

  // ─── Mención directa (@slug) ─────────────────────────────────────────
  /**
   * Detecta "@slug …" al inicio del mensaje. Solo aplica a agentes personalizados
   * en canales de Jesús (api, telegram); Buzz y A2A siempre pasan por el Coordinator.
   * Devuelve null si no hay mención o el slug no es un agente personalizado.
   */
  resolverMencion(texto: string, canal: CanalAgente): Mencion | null {
    if (canal === 'buzz' || canal === 'a2a') return null;
    const m = MENCION.exec(texto || '');
    if (!m) return null;
    const name = m[1].toLowerCase();
    const r = this.get(name);
    if (!r) return null;
    const resto = texto.slice(m[0].length).trim();
    if (!r.enabled) return { tipo: 'no_disponible', name, displayName: r.displayName, motivo: `${r.displayName} está desactivado. Actívalo en la vista Agentes.` };
    if (!r.channels.includes(canal)) return { tipo: 'no_disponible', name, displayName: r.displayName, motivo: `${r.displayName} no está habilitado para este canal (${canal}). Actívalo en la vista Agentes → canales.` };
    return { tipo: 'ok', name, displayName: r.displayName, texto: resto || `Hola ${r.displayName}, preséntate y dime en qué me puedes ayudar.` };
  }

  /**
   * Runner para hablar con el agente directamente sobre la MISMA sesión del canal
   * (los eventos quedan en el historial con author = slug; el Coordinator los ve
   * como contexto en turnos posteriores). Se cachea por agente + servicio de sesiones.
   */
  /**
   * Decide quién atiende el turno de un canal de Jesús: si el mensaje empieza con
   * "@slug" de un agente personalizado disponible, ese agente (runner directo y
   * mensaje sin la mención); si el agente existe pero no está disponible, un
   * aviso (no se corre nada); si no, el runner del Coordinator.
   */
  async prepararTurno(opts: { canal: CanalAgente; newMessage: any; appName: string; sessionService: any; runnerCoordinator: any }): Promise<{
    runner: any; newMessage: any; directo?: { name: string; displayName: string }; aviso?: string;
  }> {
    const { canal, newMessage, appName, sessionService, runnerCoordinator } = opts;
    const parts: any[] = newMessage?.parts || [];
    const iTexto = parts.findIndex((p) => typeof p?.text === 'string' && p.text.trim());
    const men = iTexto >= 0 ? this.resolverMencion(parts[iTexto].text, canal) : null;
    if (!men) return { runner: runnerCoordinator, newMessage };
    if (men.tipo === 'no_disponible') return { runner: runnerCoordinator, newMessage, directo: { name: men.name, displayName: men.displayName }, aviso: `⚠️ ${men.motivo}` };
    const nuevo = { ...newMessage, parts: parts.map((p, i) => (i === iTexto ? { ...p, text: men.texto } : p)) };
    return { runner: await this.runnerDirecto(men.name, appName, sessionService), newMessage: nuevo, directo: { name: men.name, displayName: men.displayName } };
  }

  async runnerDirecto(name: string, appName: string, sessionService: any): Promise<any> {
    this.cargarTodo();
    const r = this.registro.get(name);
    if (!r) throw new Error(`No existe el agente ${name}`);
    if (!r.directo) r.directo = this.construirAgente(r.manifest, 'directo');
    if (!r.runners) r.runners = new Map();
    const clave = appName;
    let runner = r.runners.get(clave);
    if (!runner) {
      const { Runner } = await import('@google/adk');
      runner = new Runner({ appName, agent: r.directo, sessionService });
      r.runners.set(clave, runner);
    }
    return runner;
  }

  private valorEnv(m: CustomAgentManifest, name: string): string | undefined {
    return process.env[`AGENT_${m.name.toUpperCase()}_${name}`] ?? process.env[name];
  }

  private ctxPara(m: CustomAgentManifest, t: CustomToolDef): SandboxCtx {
    const env: Record<string, string> = {};
    for (const e of m.env) { const v = this.valorEnv(m, e.name); if (v !== undefined) env[e.name] = v; }
    return {
      env,
      log: () => {},
      now: () => new Date().toISOString(),
      ...(t.network ? { fetch: fetchSeguro() } : {}),
      ...(m.memory ? { memory: this.memoriaDe(m) } : {}),
    };
  }

  // ─── Memoria episódica propia (Qdrant, opcional) ─────────────────────
  private coleccion(m: CustomAgentManifest) { return `agent_${m.name}`; }
  private memOk = new Map<string, boolean>();

  private async asegurarMemoria(m: CustomAgentManifest): Promise<boolean> {
    const col = this.coleccion(m);
    if (this.memOk.has(col)) return this.memOk.get(col)!;
    try {
      const ex = await qdrantService.raw.collectionExists(col);
      if (!ex.exists) await qdrantService.raw.createCollection(col, { vectors: { size: QdrantKnowledgeService.EMBEDDING_DIM, distance: 'Cosine' } });
      this.memOk.set(col, true);
    } catch (err: any) {
      console.warn(`ℹ️ [Agentes] ${m.name} sin memoria vectorial: ${err?.message}`);
      this.memOk.set(col, false);
    }
    return this.memOk.get(col)!;
  }

  private memoriaDe(m: CustomAgentManifest): NonNullable<SandboxCtx['memory']> {
    return {
      search: async (q, limit = 5) => {
        if (!(await this.asegurarMemoria(m))) return [];
        const vector = await qdrantService.generateEmbedding(q);
        const res = await qdrantService.raw.query(this.coleccion(m), { query: vector, limit, with_payload: true });
        return (res.points || []).map((p: any) => ({ text: p.payload?.text, meta: p.payload?.meta, score: p.score }));
      },
      save: async (text, meta) => {
        if (!(await this.asegurarMemoria(m))) throw new Error('La memoria vectorial no está disponible (Qdrant/Ollama)');
        const id = createHash('sha256').update(`${m.name}:${text}`).digest('hex');
        const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`;
        const vector = await qdrantService.generateEmbedding(text);
        await qdrantService.raw.upsert(this.coleccion(m), { wait: true, points: [{ id: uuid, vector, payload: { text, meta: meta ?? null, at: new Date().toISOString() } }] });
        return uuid;
      },
    };
  }

  private toolsMemoria(m: CustomAgentManifest): any[] {
    const mem = this.memoriaDe(m);
    return [
      new FunctionTool({
        name: 'memory_search',
        description: 'Busca en tu memoria propia (cosas guardadas en conversaciones anteriores) por significado.',
        parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' }, limit: { type: 'NUMBER' } }, required: ['query'] } as any,
        execute: async (args: any) => {
          try {
            const r = await mem.search(String(args.query || ''), Number(args.limit) || 5);
            return { status: 'success', result: r.length ? r.map((x) => `• ${x.text}${x.meta ? ` (${JSON.stringify(x.meta)})` : ''}`).join('\n') : 'Nada guardado sobre eso.' };
          } catch (err: any) { return { status: 'error', message: err.message }; }
        },
      }),
      new FunctionTool({
        name: 'memory_save',
        description: 'Guarda un dato en tu memoria propia para futuras conversaciones (preferencias, resultados, contexto).',
        parameters: { type: 'OBJECT', properties: { text: { type: 'STRING' }, meta: { type: 'OBJECT' } }, required: ['text'] } as any,
        execute: async (args: any) => {
          try { await mem.save(String(args.text || ''), args.meta); return { status: 'success', result: 'Guardado.' }; }
          catch (err: any) { return { status: 'error', message: err.message }; }
        },
      }),
    ];
  }

  /** Prueba directa del agente (GUI): un turno aislado, sin el Coordinator. */
  async conversar(name: string, texto: string): Promise<{ respuesta: string; pasos: string[] }> {
    const agent = this.agenteDe(name);
    if (!agent) throw new Error(`No existe el agente ${name}`);
    const { Runner, InMemorySessionService } = await import('@google/adk');
    const sessions = new InMemorySessionService();
    const runner = new Runner({ appName: `test_${name}`, agent, sessionService: sessions });
    const session = await sessions.createSession({ appName: `test_${name}`, userId: 'gui' });
    let respuesta = '';
    const pasos: string[] = [];
    for await (const ev of runner.runAsync({ userId: 'gui', sessionId: session.id, newMessage: { role: 'user', parts: [{ text: texto }] } })) {
      for (const p of (ev as any).content?.parts || []) {
        if (p.functionCall) pasos.push(`→ ${p.functionCall.name}(${JSON.stringify(p.functionCall.args).slice(0, 120)})`);
        if (p.functionResponse) pasos.push(`← ${p.functionResponse.name}: ${JSON.stringify(p.functionResponse.response).slice(0, 200)}`);
        if (p.text && (ev as any).author !== 'user' && !(ev as any).partial) respuesta += p.text;
      }
      if ((ev as any).errorMessage) pasos.push(`⚠️ ${(ev as any).errorMessage}`);
    }
    return { respuesta: respuesta.trim(), pasos };
  }
}

export const customAgentsService = new CustomAgentsService();
