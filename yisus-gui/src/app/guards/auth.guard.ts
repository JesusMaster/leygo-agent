import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/** Sin sesión → /login (recordando adónde iba). */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.logueado()) return true;
  return router.createUrlTree(['/login'], { queryParams: state.url && state.url !== '/' ? { volver: state.url } : {} });
};
