import { Component, inject, signal } from '@angular/core';
import { ApiService, ChannelsConfig } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

type Canal = 'telegram' | 'buzz' | 'api';

/**
 * Qué herramientas ve cada canal.
 *
 * Es la cara visible de config/channels.json: el agente de cada canal se arma con
 * este set, así que una herramienta desmarcada acá el modelo ni siquiera la ve.
 */
@Component({
  selector: 'app-channels',
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Canales y herramientas</h2>
          <p class="sub">
            Cada canal arma su propio agente con las herramientas que marques. Lo que no está marcado,
            el modelo no lo ve: no es un permiso que se pida después, la herramienta directamente no existe para ese canal.
          </p>
        </div>
        <button class="btn-secondary" (click)="load()"><i class="ph ph-arrows-clockwise"></i> Recargar</button>
      </div>

      @if (loading()) {
        <div class="empty">Cargando configuración…</div>
      } @else if (!config()) {
        <div class="empty">No se pudo leer la configuración. Revisa la URL del backend en Ajustes.</div>
      } @else {
        @for (canal of canales; track canal) {
          <div class="card">
            <div class="row">
              <div>
                <h3><i class="ph" [class.ph-telegram-logo]="canal === 'telegram'" [class.ph-lightning]="canal === 'buzz'" [class.ph-plugs-connected]="canal === 'api'"></i> {{ etiqueta[canal] }}</h3>
                <p class="card-sub">{{ descripcion[canal] }}</p>
              </div>
              <span class="spacer"></span>
              <span class="badge dim">{{ seleccion()[canal].length }} / {{ config()!.catalogo.length }}</span>
            </div>

            <div class="chips">
              @for (tool of config()!.catalogo; track tool) {
                <span class="chip" [class.on]="seleccion()[canal].includes(tool)" (click)="toggle(canal, tool)">
                  @if (seleccion()[canal].includes(tool)) { <i class="ph ph-check"></i> }
                  {{ tool }}
                </span>
              }
            </div>

            <div class="row" style="margin-top:16px">
              <button class="btn-secondary" (click)="todo(canal)">Marcar todo</button>
              <button class="btn-secondary" (click)="nada(canal)">Desmarcar todo</button>
              <span class="spacer"></span>
              @if (sucio(canal)) { <span class="badge warn">Sin guardar</span> }
              <button class="btn-primary" [disabled]="!sucio(canal) || guardando()" (click)="guardar(canal)">Guardar</button>
            </div>
          </div>
        }

        <div class="card">
          <h3>Grupos disponibles</h3>
          <p class="card-sub">Atajos que puedes usar al editar el archivo a mano: expanden a varias herramientas.</p>
          <table>
            <tr><th>Grupo</th><th>Incluye</th></tr>
            @for (g of grupos(); track g.nombre) {
              <tr><td><code>{{ g.nombre }}</code></td><td class="mono" style="color:var(--text-dim)">{{ g.tools.join(', ') }}</td></tr>
            }
          </table>
        </div>

        <div class="card">
          <h3>A2A</h3>
          <p class="card-sub">
            El canal entre agentes no se configura acá: cada token trae su propio alcance,
            para que dos integraciones distintas nunca compartan superficie.
          </p>
          <a class="btn-secondary" href="#/tokens" style="text-decoration:none;display:inline-block">Ir a Tokens A2A</a>
        </div>
      }
    </div>
  `,
})
export class ChannelsComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  canales: Canal[] = ['telegram', 'buzz', 'api'];
  etiqueta: Record<Canal, string> = { telegram: 'Telegram', buzz: 'Buzz (Nostr)', api: 'API REST' };
  descripcion: Record<Canal, string> = {
    telegram: 'Tu canal privado. Es el único donde tiene sentido el acceso completo a la cuenta de Google.',
    buzz: 'El canal de la comunidad. Todo lo que habilites acá queda al alcance de quien te escriba en el canal.',
    api: 'Los endpoints /run y /run_sse. Úsalos con la misma prudencia que un canal externo.',
  };

  config = signal<ChannelsConfig | null>(null);
  seleccion = signal<Record<Canal, string[]>>({ telegram: [], buzz: [], api: [] });
  original = signal<Record<Canal, string[]>>({ telegram: [], buzz: [], api: [] });
  loading = signal(true);
  guardando = signal(false);

  constructor() { this.load(); }

  load() {
    this.loading.set(true);
    this.api.getChannels().subscribe({
      next: (c) => {
        this.config.set(c);
        const sel = {
          telegram: [...c.canales.telegram],
          buzz: [...c.canales.buzz],
          api: [...c.canales.api],
        };
        this.seleccion.set(sel);
        this.original.set(JSON.parse(JSON.stringify(sel)));
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.toast.error('No se pudo cargar la configuración de canales'); },
    });
  }

  grupos() {
    const g = this.config()?.grupos || {};
    return Object.entries(g).map(([nombre, tools]) => ({ nombre, tools }));
  }

  toggle(canal: Canal, tool: string) {
    this.seleccion.update((s) => {
      const actual = s[canal];
      const next = actual.includes(tool) ? actual.filter((t) => t !== tool) : [...actual, tool];
      return { ...s, [canal]: next };
    });
  }

  todo(canal: Canal) {
    this.seleccion.update((s) => ({ ...s, [canal]: [...(this.config()?.catalogo || [])] }));
  }
  nada(canal: Canal) {
    this.seleccion.update((s) => ({ ...s, [canal]: [] }));
  }

  sucio(canal: Canal): boolean {
    const a = [...this.seleccion()[canal]].sort().join(',');
    const b = [...this.original()[canal]].sort().join(',');
    return a !== b;
  }

  guardar(canal: Canal) {
    this.guardando.set(true);
    this.api.saveChannelTools(canal, this.seleccion()[canal]).subscribe({
      next: () => {
        this.original.update((o) => ({ ...o, [canal]: [...this.seleccion()[canal]] }));
        this.guardando.set(false);
        this.toast.ok(`${this.etiqueta[canal]} guardado. Aplica al reiniciar el servicio.`);
      },
      error: (e) => { this.guardando.set(false); this.toast.error(e?.error?.error || 'No se pudo guardar'); },
    });
  }
}
