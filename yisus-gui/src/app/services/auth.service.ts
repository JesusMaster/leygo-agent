import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

const CLAVE = 'yisus_auth_token';
const USUARIO = 'yisus_auth_user';

/**
 * Sesión de la GUI: usuario y contraseña → token de sesión que el backend
 * acepta en lugar de la clave de administración. La GUI nunca conoce la clave.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);

  readonly token = signal<string | null>(AuthService.leerToken());

  /** Si en 'yisus_session' quedó un token de una versión anterior, se toma; si es un id de chat, se deja en paz. */
  private static leerToken(): string | null {
    const t = localStorage.getItem(CLAVE);
    if (t) return t;
    const viejo = localStorage.getItem('yisus_session');
    if (viejo && viejo.startsWith('ysess_')) { localStorage.setItem(CLAVE, viejo); localStorage.removeItem('yisus_session'); return viejo; }
    return null;
  }
  readonly usuario = signal<string | null>(localStorage.getItem(USUARIO));
  /** null = todavía no se consultó */
  readonly configurado = signal<boolean | null>(null);

  constructor() {
    // Sesión guardada sin usuario (p. ej. migrada): se pregunta al backend quién es
    if (this.token() && !this.usuario()) {
      this.http.get<{ usuario?: string }>(`${this.baseUrl}/api/admin/me`).subscribe({
        next: (r) => { if (r.usuario) { localStorage.setItem(USUARIO, r.usuario); this.usuario.set(r.usuario); } },
        error: () => {},
      });
    }
  }

  get baseUrl(): string {
    return localStorage.getItem('yisus_api_url') || `${window.location.protocol}//${window.location.hostname}:4000`;
  }

  logueado(): boolean { return !!this.token(); }

  async estado(): Promise<{ configurado: boolean; usuario: string | null }> {
    try {
      const r = await firstValueFrom(this.http.get<{ configurado: boolean; usuario: string | null }>(`${this.baseUrl}/api/auth/status`));
      this.configurado.set(r.configurado);
      return r;
    } catch {
      this.configurado.set(null);
      return { configurado: false, usuario: null };
    }
  }

  async login(user: string, password: string): Promise<void> {
    const r = await firstValueFrom(this.http.post<{ token: string; usuario: string }>(`${this.baseUrl}/api/auth/login`, { user, password }));
    localStorage.setItem(CLAVE, r.token);
    localStorage.setItem(USUARIO, r.usuario);
    // La clave manual ya no hace falta: si quedó de antes, se retira para no mezclar
    localStorage.removeItem('yisus_admin_key');
    this.token.set(r.token);
    this.usuario.set(r.usuario);
  }

  async logout(): Promise<void> {
    const t = this.token();
    if (t) { try { await firstValueFrom(this.http.post(`${this.baseUrl}/api/auth/logout`, {})); } catch {} }
    this.limpiar();
    void this.router.navigateByUrl('/login');
  }

  /** Cuando el backend responde 401 con sesión cargada: la sesión venció o fue borrada. */
  limpiar(): void {
    localStorage.removeItem(CLAVE);
    localStorage.removeItem(USUARIO);
    this.token.set(null);
    this.usuario.set(null);
  }
}
