import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

/**
 * Hilo de ejecución de una herramienta personalizada.
 *
 * - Corre en un Worker: el hilo principal lo mata si se pasa del tiempo, así
 *   que un `while(true)` no cuelga al agente.
 * - El código corre en un contexto de `vm` creado desde un objeto sin
 *   prototipo y SIN pasarle objetos del realm anfitrión: los intrínsecos
 *   (Math, JSON, Object, Function…) son los del contexto nuevo. Las únicas
 *   funciones del anfitrión que entran (log, fetch, memoria) tienen prototipo
 *   null, así `fn.constructor` no lleva a `Function` del anfitrión.
 * - Todo lo que cruza la frontera (args, env, respuestas de fetch/memoria)
 *   viaja como JSON string y se parsea DENTRO del contexto.
 */

interface Entrada { code: string; argsJson: string; envJson: string; network: boolean; memory: boolean; nombre: string; }

const entrada = workerData as Entrada;
const logs: string[] = [];
let seq = 0;
const pendientes = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

parentPort!.on('message', (m: any) => {
  if (m?.type === 'rpc_result') {
    const p = pendientes.get(m.id);
    if (!p) return;
    pendientes.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  }
});

/** Llama al hilo principal y espera un string JSON. */
function rpc(metodo: string, ...params: any[]): Promise<string> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pendientes.set(id, { resolve, reject });
    parentPort!.postMessage({ type: 'rpc', id, metodo, params: JSON.parse(JSON.stringify(params)) });
  });
}

function sinPrototipo<T extends Function>(fn: T): T { Object.setPrototypeOf(fn, null); return fn; }

const log = sinPrototipo((...a: any[]) => { if (logs.length < 50) logs.push(a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' ')); });
const hostFetch = sinPrototipo((url: string, initJson: string) => rpc('fetch', url, initJson));
const hostMemSearch = sinPrototipo((q: string, limit: number) => rpc('memory_search', q, limit));
const hostMemSave = sinPrototipo((text: string, metaJson: string) => rpc('memory_save', text, metaJson));
const hostNow = sinPrototipo(() => new Date().toISOString());

function safeJson(x: any): string { try { return JSON.stringify(x); } catch { return String(x); } }

async function main() {
  const t0 = Date.now();
  const sandbox = Object.create(null);
  sandbox.__log = log; sandbox.__now = hostNow;
  if (entrada.network) sandbox.__fetch = hostFetch;
  if (entrada.memory) { sandbox.__memSearch = hostMemSearch; sandbox.__memSave = hostMemSave; }
  sandbox.__argsJson = entrada.argsJson; sandbox.__envJson = entrada.envJson;
  const contexto = vm.createContext(sandbox, { name: entrada.nombre });

  const envoltorio = `
    'use strict';
    const console = { log: (...a) => __log(...a), info: (...a) => __log(...a), warn: (...a) => __log(...a), error: (...a) => __log(...a) };
    const __args = JSON.parse(__argsJson);
    const __ctx = {
      env: JSON.parse(__envJson),
      log: (...a) => __log(...a),
      now: () => __now(),
      fetch: typeof __fetch === 'function' ? async (url, init) => JSON.parse(await __fetch(String(url), JSON.stringify(init ?? null))) : undefined,
      memory: typeof __memSearch === 'function' ? {
        search: async (q, limit) => JSON.parse(await __memSearch(String(q), Number(limit) || 5)),
        save: async (text, meta) => __memSave(String(text), JSON.stringify(meta ?? null)),
      } : undefined,
    };
    (async (args, ctx) => {
${entrada.code}
    })(__args, __ctx).then((r) => JSON.stringify(r === undefined ? null : r), (e) => { throw e; });
  `;
  try {
    const script = new vm.Script(envoltorio, { filename: `${entrada.nombre}.js` });
    const promesa = script.runInContext(contexto, { timeout: 5000 }) as Promise<string>;
    const json = await promesa;
    parentPort!.postMessage({ type: 'done', ok: true, resultJson: json ?? 'null', logs, ms: Date.now() - t0 });
  } catch (err: any) {
    parentPort!.postMessage({ type: 'done', ok: false, error: err?.message || String(err), logs, ms: Date.now() - t0 });
  }
}

main();
