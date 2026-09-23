/**
 * Verifica qué rutas HTTP quedan abiertas a internet.
 *
 * No levanta el servidor: ejecuta el middleware contra una tabla de rutas y
 * comprueba que las internas exijan X-Admin-Key y que la recepción de webhooks
 * externos siga siendo pública.
 *
 *   npx tsx scripts/verificar_rutas_publicas.ts
 */
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'clave-de-prueba';

import { guardRutasInternas } from '../src/routes/admin_guard.js';

type Caso = { metodo: string; ruta: string; debeExigirClave: boolean; nota: string };

const CASOS: Caso[] = [
  { metodo: 'POST',   ruta: '/run',                      debeExigirClave: true,  nota: 'coordinator interno completo' },
  { metodo: 'POST',   ruta: '/run_sse',                  debeExigirClave: true,  nota: 'coordinator interno completo (stream)' },
  { metodo: 'GET',    ruta: '/api/usage',                debeExigirClave: true,  nota: 'consumo y gasto' },
  { metodo: 'GET',    ruta: '/api/usage/budget',         debeExigirClave: true,  nota: 'presupuestos' },
  { metodo: 'POST',   ruta: '/api/usage/budget',         debeExigirClave: true,  nota: 'cambiar presupuestos' },
  { metodo: 'POST',   ruta: '/api/usage/refresh-pricing',debeExigirClave: true,  nota: 'recargar catalogo de precios' },
  { metodo: 'POST',   ruta: '/apps/yisus/users/x/sessions', debeExigirClave: true, nota: 'sesiones del ADK' },
  { metodo: 'GET',    ruta: '/webhooks/recent',          debeExigirClave: true,  nota: 'historial de webhooks' },
  { metodo: 'GET',    ruta: '/api/webhooks',             debeExigirClave: true,  nota: 'listado de webhooks' },
  { metodo: 'POST',   ruta: '/api/webhooks',             debeExigirClave: true,  nota: 'crear webhook' },
  { metodo: 'DELETE', ruta: '/api/webhooks/abc',         debeExigirClave: true,  nota: 'borrar webhook' },
  { metodo: 'GET',    ruta: '/api/webhooks/abc/logs',    debeExigirClave: true,  nota: 'logs de un webhook' },
  { metodo: 'DELETE', ruta: '/api/webhooks/abc/logs/12', debeExigirClave: true,  nota: 'borrar un log' },
  { metodo: 'GET',    ruta: '/api/webhooks/models',      debeExigirClave: true,  nota: 'modelos disponibles' },
  { metodo: 'GET',    ruta: '/api/webhooks/logs',        debeExigirClave: true,  nota: 'todas las ejecuciones' },
  { metodo: 'GET',    ruta: '/api/settings/env',         debeExigirClave: true,  nota: 'variables del .env' },
  { metodo: 'PUT',    ruta: '/api/settings/env',         debeExigirClave: true,  nota: 'editar el .env' },
  { metodo: 'GET',    ruta: '/api/settings/llm',         debeExigirClave: true,  nota: 'proveedores LLM (keys)' },
  { metodo: 'POST',   ruta: '/api/settings/restart',     debeExigirClave: true,  nota: 'reiniciar backend' },
  { metodo: 'GET',    ruta: '/api/commitments',          debeExigirClave: true,  nota: 'compromisos' },
  { metodo: 'POST',   ruta: '/api/agents/generate',      debeExigirClave: true,  nota: 'crear agentes con IA' },
  { metodo: 'POST',   ruta: '/api/agents/generate/stream', debeExigirClave: true, nota: 'crear agentes con IA (SSE)' },

  // Publicas a proposito
  { metodo: 'POST',   ruta: '/webhook',                  debeExigirClave: false, nota: 'Telegram entrante' },
  { metodo: 'POST',   ruta: '/webhooks/github',          debeExigirClave: false, nota: 'proveedor externo (valida su secreto)' },
  { metodo: 'POST',   ruta: '/api/webhook/abc',          debeExigirClave: false, nota: 'webhook custom entrante' },
  { metodo: 'POST',   ruta: '/webhook/abc',              debeExigirClave: false, nota: 'webhook custom entrante (alias)' },
  { metodo: 'GET',    ruta: '/.well-known/agent-card.json', debeExigirClave: false, nota: 'Agent Card: publica por especificacion A2A' },
  { metodo: 'POST',   ruta: '/a2a/v1',                   debeExigirClave: false, nota: 'JSON-RPC A2A: autentica con Bearer propio' },
  { metodo: 'GET',    ruta: '/api/status',               debeExigirClave: false, nota: 'sonda de vida para la GUI' },
  { metodo: 'GET',    ruta: '/api/auth/status',          debeExigirClave: false, nota: 'si el login está configurado' },
  { metodo: 'POST',   ruta: '/api/auth/login',           debeExigirClave: false, nota: 'inicio de sesión' },
];

function probar(c: Caso): boolean {
  let paso = false;
  let estado = 0;
  const req: any = { method: c.metodo, path: c.ruta, headers: {} };
  const res: any = { status: (s: number) => { estado = s; return res; }, json: () => res };
  guardRutasInternas(req, res, () => { paso = true; });
  const exigio = !paso && estado === 401;
  return exigio === c.debeExigirClave;
}

let fallos = 0;
console.log('ADMIN_API_KEY definida, sin cabecera X-Admin-Key:\n');
for (const c of CASOS) {
  const ok = probar(c);
  if (!ok) fallos++;
  const etiqueta = c.debeExigirClave ? 'protegida' : 'publica  ';
  console.log(`  ${ok ? 'ok' : 'XX'} ${etiqueta}  ${c.metodo.padEnd(6)} ${c.ruta.padEnd(36)} ${c.nota}`);
}
console.log('');
console.log(fallos === 0 ? 'OK todas las rutas se comportan como corresponde.' : `FALLO en ${fallos} ruta(s).`);
process.exit(fallos === 0 ? 0 : 1);
