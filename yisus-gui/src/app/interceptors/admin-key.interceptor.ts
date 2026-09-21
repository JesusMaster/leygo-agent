import { HttpInterceptorFn } from '@angular/common/http';

/**
 * Adjunta la clave de administración a todas las llamadas al backend.
 * Se guarda en localStorage desde la vista de Ajustes; el backend la exige en
 * X-Admin-Key cuando ADMIN_API_KEY está definida.
 */
export const adminKeyInterceptor: HttpInterceptorFn = (req, next) => {
  const key = localStorage.getItem('yisus_admin_key');
  if (!key) return next(req);
  return next(req.clone({ setHeaders: { 'X-Admin-Key': key } }));
};
