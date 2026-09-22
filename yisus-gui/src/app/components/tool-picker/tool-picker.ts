import { Component, computed, input, output } from '@angular/core';

export interface ToolDetalle {
  name: string;
  titulo: string;
  descripcion: string;
  grupo: string;
  etiqueta: string;
}

/**
 * Selector de herramientas en forma de tabla: checkbox, nombre técnico y
 * descripción, agrupadas por categoría. Reemplaza a los chips, que con 18
 * herramientas ya no se podían leer ni comparar.
 *
 * Es un control puro: recibe el catálogo y la selección, emite la selección
 * nueva. Quien lo usa decide si es para crear un token o para editarlo.
 */
@Component({
  selector: 'app-tool-picker',
  template: `
    <div class="picker">
      <div class="picker-head">
        <span class="picker-count">
          <strong>{{ seleccion().length }}</strong> de {{ catalogo().length }} habilitadas
        </span>
        <span class="spacer"></span>
        <button type="button" class="btn-link" (click)="todas()" [disabled]="seleccion().length === catalogo().length">Seleccionar todas</button>
        <span class="sep">·</span>
        <button type="button" class="btn-link" (click)="ninguna()" [disabled]="seleccion().length === 0">Ninguna</button>
      </div>

      <table class="picker-table">
        @for (g of grupos(); track g.grupo) {
          <tr class="group-row">
            <td class="check">
              <input type="checkbox"
                     [checked]="estadoGrupo(g) === 'todas'"
                     [indeterminate]="estadoGrupo(g) === 'algunas'"
                     (change)="toggleGrupo(g)"
                     [title]="'Todo el grupo ' + g.etiqueta" />
            </td>
            <td colspan="2">
              <span class="group-label">{{ g.etiqueta }}</span>
              <span class="group-count">{{ marcadasEn(g) }}/{{ g.tools.length }}</span>
            </td>
          </tr>
          @for (t of g.tools; track t.name) {
            <tr class="tool-row" [class.on]="seleccion().includes(t.name)" (click)="toggle(t.name)">
              <td class="check">
                <input type="checkbox" [checked]="seleccion().includes(t.name)" (click)="$event.stopPropagation()" (change)="toggle(t.name)" />
              </td>
              <td class="name">
                <div class="tool-title">{{ t.titulo }}</div>
                <code class="tool-id">{{ t.name }}</code>
              </td>
              <td class="desc">{{ t.descripcion }}</td>
            </tr>
          }
        }
      </table>
    </div>
  `,
  styles: [`
    .picker { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--bg-input); }
    .picker-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-dim); }
    .picker-count strong { color: var(--text-main); }
    .sep { opacity: .5; }
    .btn-link { background: none; border: 0; padding: 0; color: var(--accent-primary); cursor: pointer; font: inherit; font-size: 12px; }
    .btn-link:hover { text-decoration: underline; }
    .btn-link[disabled] { color: var(--text-dim); cursor: default; text-decoration: none; opacity: .6; }

    .picker-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .picker-table td { padding: 9px 12px; border-bottom: 1px solid var(--border-light); vertical-align: top; }
    .picker-table tr:last-child td { border-bottom: none; }

    .group-row td { background: var(--bg-main); padding-top: 8px; padding-bottom: 8px; }
    .group-label { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-dim); }
    .group-count { margin-left: 8px; font-size: 11px; color: var(--text-dim); opacity: .8; }

    .tool-row { cursor: pointer; transition: background .12s; }
    .tool-row:hover td { background: rgba(255,255,255,.025); }
    .tool-row.on td { background: rgba(129,140,248,.08); }
    .tool-row.on .tool-title { color: var(--text-main); }

    td.check { width: 36px; text-align: center; padding-right: 0; }
    td.check input { width: 15px; height: 15px; accent-color: var(--accent-primary); cursor: pointer; margin-top: 2px; }
    td.name { width: 260px; white-space: nowrap; }
    .tool-title { font-weight: 500; color: var(--text-main); }
    .tool-id { display: inline-block; margin-top: 3px; font-size: 11.5px; color: var(--text-dim); background: transparent; padding: 0; }
    td.desc { color: var(--text-dim); line-height: 1.45; }

    @media (max-width: 900px) {
      td.name { width: auto; white-space: normal; }
      td.desc { display: none; }
    }
  `],
})
export class ToolPickerComponent {
  /** Catálogo con descripciones (de /api/a2a/disponibles → detalle). */
  catalogo = input.required<ToolDetalle[]>();
  /** Nombres seleccionados. */
  seleccion = input.required<string[]>();
  seleccionChange = output<string[]>();

  grupos = computed(() => {
    const mapa = new Map<string, { grupo: string; etiqueta: string; tools: ToolDetalle[] }>();
    for (const t of this.catalogo()) {
      if (!mapa.has(t.grupo)) mapa.set(t.grupo, { grupo: t.grupo, etiqueta: t.etiqueta, tools: [] });
      mapa.get(t.grupo)!.tools.push(t);
    }
    return [...mapa.values()];
  });

  toggle(name: string) {
    const s = this.seleccion();
    this.seleccionChange.emit(s.includes(name) ? s.filter((x) => x !== name) : [...s, name]);
  }

  marcadasEn(g: { tools: ToolDetalle[] }): number {
    const s = this.seleccion();
    return g.tools.filter((t) => s.includes(t.name)).length;
  }

  estadoGrupo(g: { tools: ToolDetalle[] }): 'todas' | 'algunas' | 'ninguna' {
    const n = this.marcadasEn(g);
    return n === 0 ? 'ninguna' : n === g.tools.length ? 'todas' : 'algunas';
  }

  toggleGrupo(g: { tools: ToolDetalle[] }) {
    const nombres = g.tools.map((t) => t.name);
    const s = this.seleccion();
    const todasMarcadas = this.estadoGrupo(g) === 'todas';
    this.seleccionChange.emit(
      todasMarcadas ? s.filter((x) => !nombres.includes(x)) : [...new Set([...s, ...nombres])],
    );
  }

  todas() { this.seleccionChange.emit(this.catalogo().map((t) => t.name)); }
  ninguna() { this.seleccionChange.emit([]); }
}
