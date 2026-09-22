import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { ToastService } from '../services/toast.service';
import { AuthService } from '../services/auth.service';

/**
 * Traduce los errores del backend a algo accionable.
 *
 * Un 401 con sesión cargada significa que la sesión venció o fue cerrada en
 * otro lado: se limpia y se vuelve al login. Las rutas de auth se excluyen
 * (un 401 ahí es "contraseña incorrecta", lo maneja la propia página).
 */
export const errorsInterceptor: HttpInterceptorFn = (req, next) => {
  const toast = inject(ToastService);
  const auth = inject(AuthService);
  const router = inject(Router);

  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      const esAuth = /\/api\/auth\//.test(req.url);
      if (err.status === 401 && !esAuth) {
        if (auth.logueado()) {
          auth.limpiar();
          toast.error('Tu sesión venció. Vuelve a iniciar sesión.');
          void router.navigate(['/login'], { queryParams: { volver: router.url } });
        } else if (localStorage.getItem('yisus_admin_key')) {
          toast.error('La clave de administración no es válida. Inicia sesión o revisa ADMIN_API_KEY.');
        } else {
          void router.navigate(['/login']);
        }
      } else if (err.status === 0) {
        toast.error('Sin conexión con el backend. Revisa la URL en Ajustes y que el servicio esté corriendo.');
      }
      return throwError(() => err);
    })
  );
};
