import { Component, inject, signal, effect, computed } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { AuthService } from './services/auth.service';
import { ToastComponent } from './shared/components/toast';
import { ApiService } from './services/api.service';

interface ItemMenu { ruta: string; nombre: string; icono: string; ayuda: string; corto?: string; aviso?: 'escalamientos' | 'compromisos' }
interface GrupoMenu { titulo: string; items: ItemMenu[]; abajo?: boolean }

/**
 * Menú por intención de uso, de lo diario a lo ocasional:
 * conversar → lo que espera tu decisión → lo que corre solo → cómo está armado el agente → sistema.
 */
const MENU: GrupoMenu[] = [
  { titulo: '', items: [
    { ruta: '/chat', nombre: 'Chat', icono: 'ph-chat-circle-dots', ayuda: 'Conversa con Yisus y sus agentes' },
  ] },
  { titulo: 'Por atender', items: [
    { ruta: '/escalations', nombre: 'Escalamientos', corto: 'Escalados', icono: 'ph-warning-octagon', ayuda: 'Temas que esperan tu decisión', aviso: 'escalamientos' },
    { ruta: '/commitments', nombre: 'Compromisos', icono: 'ph-check-square', ayuda: 'Lo que prometiste y te prometieron', aviso: 'compromisos' },
  ] },
  { titulo: 'Automatizaciones', items: [
    { ruta: '/tasks', nombre: 'Tareas programadas', corto: 'Tareas', icono: 'ph-calendar-check', ayuda: 'Lo que Yisus hace solo, a su hora' },
    { ruta: '/webhooks', nombre: 'Webhooks', icono: 'ph-share-network', ayuda: 'Payloads de otros sistemas que la IA procesa' },
  ] },
  { titulo: 'Configurar', items: [
    { ruta: '/agents', nombre: 'Agentes', icono: 'ph-robot', ayuda: 'Agentes especializados, su personalidad y herramientas' },
    { ruta: '/channels', nombre: 'Canales y tools', icono: 'ph-sliders-horizontal', ayuda: 'Qué puede hacer Yisus en cada canal' },
    { ruta: '/tokens', nombre: 'Conexiones A2A', icono: 'ph-plugs-connected', ayuda: 'Agentes que le hablan a Yisus y a los que él les habla' },
  ] },
  { titulo: 'Sistema', abajo: true, items: [
    { ruta: '/usage', nombre: 'Consumo', icono: 'ph-chart-bar', ayuda: 'Tokens y costo por agente, canal y modelo' },
    { ruta: '/settings', nombre: 'Ajustes', icono: 'ph-gear', ayuda: 'Conexión, modelos y variables de entorno' },
  ] },
];
/** Barra inferior en móvil: lo de uso diario. */
const BARRA = ['/chat', '/escalations', '/commitments', '/tasks'];

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
  /** Dependencias del backend que no están conectadas (p. ej. ["Redis"]). */
  caidos = signal<string[]>([]);
  claveOk = signal<boolean | null>(null);

  menu = MENU;
  barra = MENU.flatMap((g) => g.items).filter((i) => BARRA.includes(i.ruta));
  /** Contadores de lo que espera tu atención (null = aún no se sabe). */
  pendientes = signal<{ escalamientos: number; compromisos: { propuestos: number; vencidos: number } } | null>(null);
  /** Teclado abierto en móvil: se esconde la barra inferior para dejarle espacio al chat. */
  teclado = signal(false);
  private ruta = signal(window.location.pathname);
  /** "Más" queda marcado cuando estás en una sección que no está en la barra. */
  enMas = computed(() => !BARRA.some((r) => this.ruta().startsWith(r)));

  constructor() {
    const savedTheme = localStorage.getItem('yisus_theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
      this.isDarkMode.set(true);
      document.body.classList.add('dark-theme');
    }

    this.router.events.subscribe((e) => {
      if (!(e instanceof NavigationEnd)) return;
      this.esLogin.set(e.urlAfterRedirects.startsWith('/login'));
      this.ruta.set(e.urlAfterRedirects.split('?')[0]);
      // Al salir de Escalamientos o Compromisos el contador se refresca sin esperar al ping.
      if (this.claveOk()) this.cargarPendientes();
    });

    this.ajustarAltoVisual();

    // Al iniciar o cerrar sesión se revalida de inmediato (no esperar al siguiente ping)
    effect(() => { this.auth.token(); this.ping(); });
    setInterval(() => this.ping(), 30000);
  }

  /**
   * iOS Safari no achica el layout cuando aparece el teclado: desplaza el
   * documento y la cabecera queda arriba, inaccesible. Se mide el viewport
   * visual y se usa como alto de la app; así el chat cabe sobre el teclado y
   * la cabecera con el menú sigue a la vista.
   */
  private ajustarAltoVisual() {
    const vv = window.visualViewport;
    if (!vv) return;
    const aplicar = () => {
      document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
      this.teclado.set(window.innerHeight - vv.height > 120);
      if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', aplicar);
    vv.addEventListener('scroll', aplicar);
    window.addEventListener('orientationchange', () => setTimeout(aplicar, 300));
    aplicar();
  }

  private ping() {
    this.api.getStatus().subscribe({
      next: (r) => {
        this.online.set(true);
        this.protegido.set(r.protegido);
        const nombres: Record<string, string> = { redis: 'Redis', mongo: 'MongoDB' };
        this.caidos.set(Object.entries(r.servicios || {})
          .filter(([, v]) => v !== 'conectado' && v !== 'no-configurado')
          .map(([k]) => nombres[k] || k));
        if (!r.protegido) { this.claveOk.set(true); this.cargarPendientes(); return; }
        if (!this.auth.logueado() && !localStorage.getItem('yisus_admin_key')) { this.claveOk.set(false); return; }
        // El backend exige credencial: se valida la sesión (o la clave) de este navegador
        this.api.validarClave().subscribe({
          next: () => { this.claveOk.set(true); this.cargarPendientes(); },
          error: () => this.claveOk.set(false),
        });
      },
      error: () => { this.online.set(false); this.claveOk.set(null); this.caidos.set([]); },
    });
  }

  private cargarPendientes() {
    this.api.getPendientes().subscribe({ next: (p) => this.pendientes.set(p), error: () => {} });
  }

  /** Número del aviso de un ítem del menú; urgente = hay algo vencido o por decidir. */
  aviso(it: ItemMenu): { n: number; urgente: boolean; texto: string } | null {
    const p = this.pendientes();
    if (!p || !it.aviso) return null;
    if (it.aviso === 'escalamientos') {
      return p.escalamientos ? { n: p.escalamientos, urgente: true, texto: `${p.escalamientos} esperando tu decisión` } : null;
    }
    const { propuestos, vencidos } = p.compromisos;
    const n = propuestos + vencidos;
    if (!n) return null;
    const partes = [vencidos ? `${vencidos} vencido${vencidos === 1 ? '' : 's'}` : '', propuestos ? `${propuestos} por aceptar` : ''].filter(Boolean);
    return { n, urgente: vencidos > 0, texto: partes.join(' · ') };
  }

  toggleTheme() {
    this.isDarkMode.update((v) => !v);
    document.body.classList.toggle('dark-theme', this.isDarkMode());
    localStorage.setItem('yisus_theme', this.isDarkMode() ? 'dark' : 'light');
  }
}
