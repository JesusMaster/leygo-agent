import { Component, inject, signal, effect } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { AuthService } from './services/auth.service';
import { ToastComponent } from './shared/components/toast';
import { ApiService } from './services/api.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private api = inject(ApiService);
  auth = inject(AuthService);
  private router = inject(Router);
  /** En /login no se muestra el marco (menú, cabecera) */
  esLogin = signal(window.location.pathname.startsWith('/login'));

  isDarkMode = signal(false);
  /** Menú lateral en pantallas chicas (off-canvas) */
  menuOpen = signal(false);
  online = signal<boolean | null>(null);
  protegido = signal(false);
  claveOk = signal<boolean | null>(null);

  constructor() {
    const savedTheme = localStorage.getItem('yisus_theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
      this.isDarkMode.set(true);
      document.body.classList.add('dark-theme');
    }

    this.router.events.subscribe((e) => { if (e instanceof NavigationEnd) this.esLogin.set(e.urlAfterRedirects.startsWith('/login')); });

    // Al iniciar o cerrar sesión se revalida de inmediato (no esperar al siguiente ping)
    effect(() => { this.auth.token(); this.ping(); });
    setInterval(() => this.ping(), 30000);
  }

  private ping() {
    this.api.getStatus().subscribe({
      next: (r) => {
        this.online.set(true);
        this.protegido.set(r.protegido);
        if (!r.protegido) { this.claveOk.set(true); return; }
        if (!this.auth.logueado() && !localStorage.getItem('yisus_admin_key')) { this.claveOk.set(false); return; }
        // El backend exige credencial: se valida la sesión (o la clave) de este navegador
        this.api.validarClave().subscribe({
          next: () => this.claveOk.set(true),
          error: () => this.claveOk.set(false),
        });
      },
      error: () => { this.online.set(false); this.claveOk.set(null); },
    });
  }

  toggleTheme() {
    this.isDarkMode.update((v) => !v);
    document.body.classList.toggle('dark-theme', this.isDarkMode());
    localStorage.setItem('yisus_theme', this.isDarkMode() ? 'dark' : 'light');
  }
}
