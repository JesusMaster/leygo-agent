import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
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

  isDarkMode = signal(false);
  online = signal<boolean | null>(null);
  protegido = signal(false);

  constructor() {
    const savedTheme = localStorage.getItem('yisus_theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
      this.isDarkMode.set(true);
      document.body.classList.add('dark-theme');
    }

    this.ping();
    setInterval(() => this.ping(), 30000);
  }

  private ping() {
    this.api.getStatus().subscribe({
      next: (r) => { this.online.set(true); this.protegido.set(r.protegido); },
      error: () => this.online.set(false),
    });
  }

  toggleTheme() {
    this.isDarkMode.update((v) => !v);
    document.body.classList.toggle('dark-theme', this.isDarkMode());
    localStorage.setItem('yisus_theme', this.isDarkMode() ? 'dark' : 'light');
  }
}
