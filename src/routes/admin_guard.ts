import express from 'express';
import { guiAuthService } from '../services/gui_auth.service.js';

/**
 * Guard compartido de administración.
 *
 * Vive aparte de admin.routes.ts porque index.routes.ts también lo necesita: ahí
 * están /run, /run_sse y /api/usage, que corren el coordinator interno (con Gmail,
 * Calendar y Drive) y exponen el gasto. Estaban públicos.
 *
 * Se monta por prefijo, nunca global: /.well-known/agent-card.json y /a2a/v1 son
 * públicos por especificación y tienen su propia autenticación por token Bearer.
 */
export function adminGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return next();

  const presented =
    (req.headers['x-admin-key'] as string) ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (presented && presented === expected) return next();

  // Sesión de la GUI: quien inició sesión con usuario y contraseña pasa igual que con la clave.
  const sesion = guiAuthService.validar(presented);
  if (sesion) { (req as any).guiUser = sesion.user; return next(); }

  res.status(401).json({ error: 'No autorizado: inicia sesión o envía X-Admin-Key' });
}

/**
 * Rutas de index.routes.ts que NO pueden quedar abiertas.
 *
 * Se listan con el método porque varias comparten prefijo con endpoints que sí
 * deben ser públicos: POST /api/webhook/:id lo llama un proveedor externo, pero
 * GET/PUT/DELETE /api/webhooks/:id es administración.
 */
export const RUTAS_PROTEGIDAS: Array<{ metodos: string[]; test: (ruta: string) => boolean }> = [
  // Conversación con el coordinator interno: tiene TODAS las herramientas.
  { metodos: ['POST'], test: (r) => r === '/run' || r === '/run_sse' },
  // Sesiones del ADK.
  { metodos: ['POST', 'GET', 'DELETE'], test: (r) => r.startsWith('/apps/') },
  // Consumo y presupuesto.
  { metodos: ['GET', 'POST'], test: (r) => r === '/api/usage' || r.startsWith('/api/usage/') },
  // Administración de webhooks (la recepción de eventos externos queda fuera).
  { metodos: ['GET'], test: (r) => r === '/webhooks/recent' },
  { metodos: ['GET', 'POST', 'PUT', 'DELETE'], test: (r) => r === '/api/webhooks' || /^\/api\/webhooks\/[^/]+(\/logs(\/[^/]+)?|\/test|\/secret)?$/.test(r) },
  // Ajustes: proveedores LLM, asignaciones y variables del .env.
  { metodos: ['GET', 'POST', 'PUT', 'DELETE'], test: (r) => r === '/api/settings' || r.startsWith('/api/settings/') },
  { metodos: ['GET', 'POST', 'PUT', 'DELETE'], test: (r) => r === '/api/commitments' || r.startsWith('/api/commitments/') },
  { metodos: ['GET', 'POST', 'PUT', 'DELETE'], test: (r) => r === '/api/agents' || r.startsWith('/api/agents/') },
];

/**
 * Middleware único que aplica el guard solo a las rutas de arriba.
 *
 * Se decide por método + ruta en vez de por prefijo porque la recepción de
 * webhooks externos (POST /webhook, /webhooks/:provider, /api/webhook/:id)
 * tiene que seguir siendo pública: la autentica su propio secreto.
 */
export function guardRutasInternas(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const ruta = (req.path || '').replace(/\/+$/, '') || '/';
  const aplica = RUTAS_PROTEGIDAS.some(
    (r) => r.metodos.includes(req.method) && r.test(ruta),
  );
  if (!aplica) return next();
  return adminGuard(req, res, next);
}
