import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { attachmentsService } from '../../services/attachments.service.js';

/**
 * Ejecuta el código de una herramienta de agente personalizado en un Worker
 * aislado (ver sandbox_worker.ts): sin require/import/fs/process, sin red
 * salvo `network: true` (solo https), y con tiempo máximo real — si el código
 * se cuelga, el hilo se mata.
 *
 * `code` es el CUERPO de `async (args, ctx) => { … }` y debe hacer `return`.
 */
export interface SandboxCtx {
  env: Record<string, string>;
  memory?: { search: (q: string, limit?: number) => Promise<Array<{ text: string; meta?: any; score?: number }>>; save: (text: string, meta?: any) => Promise<string> };
  fetch?: (url: string, init?: any) => Promise<{ status: number; ok: boolean; text: string; json: any }>;
  log: (...a: any[]) => void;
  now: () => string;
  /** Nombre del agente dueño (para atribuir los adjuntos que produzca la herramienta). */
  agente?: string;
}

export interface SandboxResult { ok: boolean; result?: any; error?: string; logs: string[]; ms: number; }

const TIMEOUT_MS = 10_000;
const MAX_RESULT = 20_000;

/** Verificación de sintaxis sin ejecutar nada. */
export function compilar(code: string, nombre = 'tool'): { ok: true } | { ok: false; error: string } {
  try {
    new vm.Script(`(async (args, ctx) => {\n${code}\n})`, { filename: `${nombre}.js` });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: `Error de sintaxis: ${err?.message || err}` };
  }
}

function workerUrl(): URL {
  const ts = import.meta.url.endsWith('.ts');
  return new URL(`./sandbox_worker.${ts ? 'ts' : 'js'}`, import.meta.url);
}

export async function ejecutar(code: string, args: any, ctx: SandboxCtx, nombre = 'tool', timeoutMs = TIMEOUT_MS): Promise<SandboxResult> {
  const comp = compilar(code, nombre);
  if (!comp.ok) return { ok: false, error: comp.error, logs: [], ms: 0 };
  const t0 = Date.now();

  return new Promise<SandboxResult>((resolve) => {
    let terminado = false;
    const worker = new Worker(workerUrl(), {
      execArgv: process.execArgv,
      workerData: { code, argsJson: JSON.stringify(args ?? {}), envJson: JSON.stringify(ctx.env || {}), network: !!ctx.fetch, memory: !!ctx.memory, nombre },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    const fin = (r: SandboxResult) => { if (terminado) return; terminado = true; clearTimeout(timer); worker.terminate().catch(() => {}); resolve(r); };
    const timer = setTimeout(() => fin({ ok: false, error: `Tiempo agotado (${timeoutMs / 1000}s): la herramienta se colgó y se detuvo`, logs: [], ms: Date.now() - t0 }), timeoutMs);

    worker.on('message', async (m: any) => {
      if (m?.type === 'done') {
        if (!m.ok) return fin({ ok: false, error: m.error, logs: m.logs || [], ms: m.ms });
        let result: any = null;
        try { result = JSON.parse(m.resultJson); } catch { result = m.resultJson; }
        // Los adjuntos (base64 de varios MB) se sacan ANTES de medir el tamaño: el modelo
        // recibe solo la referencia, y el archivo queda guardado para el canal.
        result = attachmentsService.procesarResultado(result, ctx.agente || nombre);
        const s = JSON.stringify(result) ?? 'null';
        if (s.length > MAX_RESULT) result = { truncado: true, resultado: s.slice(0, MAX_RESULT) };
        return fin({ ok: true, result, logs: m.logs || [], ms: m.ms });
      }
      if (m?.type === 'rpc') {
        try {
          let out: any;
          switch (m.metodo) {
            case 'fetch': out = ctx.fetch ? await ctx.fetch(m.params[0], m.params[1] ? JSON.parse(m.params[1]) : undefined) : (() => { throw new Error('Esta herramienta no tiene red (network=false)'); })(); break;
            case 'memory_search': out = ctx.memory ? await ctx.memory.search(m.params[0], m.params[1]) : []; break;
            case 'memory_save': out = ctx.memory ? await ctx.memory.save(m.params[0], m.params[1] ? JSON.parse(m.params[1]) : undefined) : (() => { throw new Error('Este agente no tiene memoria'); })(); break;
            default: throw new Error(`RPC desconocido: ${m.metodo}`);
          }
          worker.postMessage({ type: 'rpc_result', id: m.id, result: JSON.stringify(out ?? null) });
        } catch (err: any) {
          worker.postMessage({ type: 'rpc_result', id: m.id, error: err?.message || String(err) });
        }
      }
    });
    worker.on('error', (err) => fin({ ok: false, error: err?.message || String(err), logs: [], ms: Date.now() - t0 }));
    worker.on('exit', (code) => { if (!terminado) fin({ ok: false, error: `El sandbox terminó inesperadamente (código ${code})`, logs: [], ms: Date.now() - t0 }); });
  });
}

/** fetch restringido para herramientas con `network: true`: solo https, respuesta acotada. */
export function fetchSeguro(): NonNullable<SandboxCtx['fetch']> {
  return async (url: string, init?: any) => {
    if (!/^https:\/\//i.test(url)) throw new Error('Solo se permiten URLs https://');
    const ctrl = new AbortController();
    // 60 s y 12 MB: generar una imagen tarda 5–20 s y vuelve como base64 de varios MB
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(url, { method: init?.method || 'GET', headers: init?.headers, body: init?.body, signal: ctrl.signal });
      const text = (await res.text()).slice(0, 12_000_000);
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* no es JSON */ }
      return { status: res.status, ok: res.ok, text, json };
    } finally { clearTimeout(timer); }
  };
}
