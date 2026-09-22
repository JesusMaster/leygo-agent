import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="login-wrap">
      <form class="login-card" (submit)="entrar($event)">
        <div class="logo">
          <svg viewBox="0 0 226.772 226.772" xmlns="http://www.w3.org/2000/svg">
            <circle style="fill:none;stroke:var(--text-main);stroke-width:8;" cx="50.827" cy="49.444" r="24.941" />
            <circle cx="50.386" cy="175.193" r="27.5" style="fill:var(--text-main);" />
            <line style="stroke:var(--text-main);stroke-width:10;" x1="77.886" y1="175.193" x2="151.193" y2="175.193" />
            <line style="stroke:var(--accent-primary);stroke-width:10;stroke-dasharray:8.458,8.458;" x1="161.444" y1="152.791" x2="80.705" y2="72.051" />
            <circle style="fill:var(--accent-primary);" cx="178.693" cy="175.193" r="27.5" />
            <line style="stroke:var(--text-main);stroke-width:10;" x1="50.386" y1="147.693" x2="50.386" y2="74.386" />
          </svg>
          <span class="logo-text">yisus</span>
        </div>
        <h2>Iniciar sesión</h2>
        <p class="sub">La consola del agente. Al entrar, la clave de administración se carga sola.</p>

        @if (auth.configurado() === false) {
          <div class="aviso warn">
            El inicio de sesión no está configurado en el backend. En el <code>.env</code> define
            <code>GUI_USER</code> y <code>GUI_PASSWORD_HASH</code> (genera el hash con <code>npm run gui:password</code>) y reinicia.
          </div>
        } @else if (auth.configurado() === null) {
          <div class="aviso">No se pudo consultar el backend. <a href="#" (click)="irAjustes($event)">Revisa la URL</a>.</div>
        }

        <label class="field">
          <span>Usuario</span>
          <input type="email" name="user" [(ngModel)]="user" autocomplete="username" placeholder="jleiva@dcanje.com" autofocus />
        </label>
        <label class="field">
          <span>Contraseña</span>
          <input type="password" name="password" [(ngModel)]="password" autocomplete="current-password" />
        </label>

        @if (error()) { <div class="aviso danger">{{ error() }}</div> }

        <button class="btn-primary" type="submit" [disabled]="!user.trim() || !password || cargando()">
          @if (cargando()) { <i class="ph ph-circle-notch spin"></i> Entrando… } @else { Entrar }
        </button>

        <p class="pie">¿Usas el API directo? La clave <code>X-Admin-Key</code> queda visible en Ajustes después de entrar.</p>
      </form>
    </div>
  `,
  styles: [`
    :host { display: flex; flex: 1; min-height: 100dvh; }
    .login-wrap { flex: 1; display: grid; place-items: center; padding: 24px; background: var(--bg-main); }
    .login-card { width: min(420px, 100%); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 16px; padding: 32px 28px; display: flex; flex-direction: column; gap: 14px; }
    .logo { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .logo svg { width: 34px; height: 34px; }
    .logo-text { font-family: 'Space Grotesk', sans-serif; font-weight: 900; font-size: 28px; }
    h2 { margin: 0; font-size: 22px; }
    .sub { margin: -6px 0 6px; color: var(--text-dim); font-size: 14px; }
    .field { margin: 0; }
    .aviso { font-size: 13px; padding: 10px 12px; border-radius: 8px; background: var(--bg-input); border: 1px solid var(--border-light); color: var(--text-dim); }
    .aviso.warn { border-color: var(--warn); color: var(--warn); }
    .aviso.danger { border-color: var(--danger); color: var(--danger); }
    .aviso code { font-size: 12px; }
    .btn-primary { width: 100%; justify-content: center; display: inline-flex; align-items: center; gap: 8px; padding: 12px; font-size: 15px; margin-top: 4px; }
    .spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
    .pie { margin: 4px 0 0; font-size: 12px; color: var(--text-dim); text-align: center; }
  `],
})
export class LoginComponent {
  auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  user = localStorage.getItem('yisus_session_user') || '';
  password = '';
  error = signal<string | null>(null);
  cargando = signal(false);

  constructor() {
    if (this.auth.logueado()) { void this.router.navigateByUrl('/chat'); return; }
    void this.auth.estado().then((e) => { if (e.usuario && !this.user) this.user = e.usuario; });
  }

  async entrar(ev: Event) {
    ev.preventDefault();
    this.error.set(null);
    this.cargando.set(true);
    try {
      await this.auth.login(this.user.trim(), this.password);
      const volver = this.route.snapshot.queryParamMap.get('volver');
      void this.router.navigateByUrl(volver && volver.startsWith('/') ? volver : '/chat');
    } catch (e: any) {
      this.error.set(e?.error?.error || (e?.status === 0 ? 'Sin conexión con el backend.' : 'No se pudo iniciar sesión.'));
    } finally {
      this.cargando.set(false);
      this.password = '';
    }
  }

  irAjustes(ev: Event) { ev.preventDefault(); void this.router.navigateByUrl('/settings'); }
}
