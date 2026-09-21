import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { adminKeyInterceptor } from './interceptors/admin-key.interceptor';
import { errorsInterceptor } from './interceptors/errors.interceptor';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([adminKeyInterceptor, errorsInterceptor])),
  ],
};
