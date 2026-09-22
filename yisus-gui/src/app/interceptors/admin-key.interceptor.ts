import { HttpInterceptorFn } from '@angular/common/http';

/**
 * Adjunta la credencial a todas las llamadas al backend:
 * - la sesión de la GUI (Authorization: Bearer ysess_…), que es lo normal;
 * - o, si alguien cargó la clave a mano en un navegador viejo, X-Admin-Key.
 */
export const adminKeyInterceptor: HttpInterceptorFn = (req, next) => {
  const sesion = localStorage.getItem('yisus_auth_token');
  if (sesion) return next(req.clone({ setHeaders: { Authorization: `Bearer ${sesion}` } }));
  const key = localStorage.getItem('yisus_admin_key');
  if (key) return next(req.clone({ setHeaders: { 'X-Admin-Key': key } }));
  return next(req);
};
