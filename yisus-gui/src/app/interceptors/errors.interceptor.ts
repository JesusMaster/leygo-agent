import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { ToastService } from '../services/toast.service';

/**
 * Traduce los errores del backend a algo accionable.
 *
 * Un 401 en estas rutas casi siempre significa lo mismo: la clave de
 * administración no está cargada en este navegador, o quedó una antigua.
 */
export const errorsInterceptor: HttpInterceptorFn = (req, next) => {
  const toast = inject(ToastService);

  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401) {
        const hayClave = !!localStorage.getItem('yisus_admin_key');
        toast.error(
          hayClave
            ? 'La clave de administración no es válida. Revisa ADMIN_API_KEY en el .env y actualízala en Ajustes.'
            : 'Falta la clave de administración. Cárgala en Ajustes (es la ADMIN_API_KEY del .env).'
        );
      } else if (err.status === 0) {
        toast.error('Sin conexión con el backend. Revisa la URL en Ajustes y que el servicio esté corriendo.');
      }
      return throwError(() => err);
    })
  );
};
