import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, UsageSummary, BudgetStatus, UsageHistoryPage, PriceRow, CatalogoInfo, UsageDaily, UsageRecord } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

type Tab = 'desglose' | 'turnos' | 'presupuestos' | 'precios';
interface Barra { key: string; nombre: string; sub: string; costo: number; pct: number; ancho: number; }

/**
 * Consumo de tokens: KPIs del mes (gasto, proyección, hoy, costo por turno), gasto diario
 * con el ritmo del presupuesto, y pestañas para desglose, turnos, presupuestos y precios.
 */
@Component({
  selector: 'app-usage',
  imports: [FormsModule],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Consumo de tokens</h2>
          <p class="sub">{{ mesNombre() }} · mes en curso. El output incluye los tokens de razonamiento, que se facturan como salida.</p>
        </div>
        <button class="btn-secondary" (click)="load()" [disabled]="cargando()"><i class="ph ph-arrows-clockwise" [class.spin]="cargando()"></i> Actualizar</button>
      </div>

      @if (!data() || !diario()) {
        <div class="card"><div class="empty">Cargando consumo…</div></div>
      } @else {
        @let m = diario()!.mes;
        <!-- ─── KPIs ───────────────────────────────────────────── -->
        <div class="kpis">
          <div class="kpi">
            <div class="k-lbl">Gasto del mes</div>
            <div class="k-val">{{ usd(m.costo) }}</div>
            @if (m.presupuesto > 0) {
              <div class="bar" [class.warn]="pctMes() >= 80" [class.danger]="pctMes() >= 100"><i [style.width.%]="min100(pctMes())"></i></div>
              <div class="k-hint">{{ pctMes() }}% de {{ usd(m.presupuesto) }}</div>
            } @else { <div class="k-hint">sin presupuesto global</div> }
          </div>
          <div class="kpi" [class.alerta]="m.presupuesto > 0 && m.proyeccion > m.presupuesto">
            <div class="k-lbl">Proyección a fin de mes</div>
            <div class="k-val">{{ usd(m.proyeccion) }}</div>
            @if (m.presupuesto > 0 && m.proyeccion > m.presupuesto) {
              <div class="k-hint warn"><i class="ph ph-warning"></i> Excede el presupuesto en {{ usd(m.proyeccion - m.presupuesto) }}</div>
            } @else if (m.presupuesto > 0) {
              <div class="k-hint ok"><i class="ph ph-check-circle"></i> Dentro del presupuesto</div>
            }
            <div class="k-hint">{{ usd(m.promedioDiario) }}/día en promedio@if (m.ritmoPresupuesto) { · el presupuesto da {{ usd(m.ritmoPresupuesto) }}/día }</div>
          </div>
          <div class="kpi">
            <div class="k-lbl">Hoy</div>
            <div class="k-val">{{ usd(diario()!.hoy.costo) }}</div>
            <div class="k-hint">{{ diario()!.hoy.turnos }} turno{{ diario()!.hoy.turnos === 1 ? '' : 's' }}@if (m.promedioDiario > 0) { · {{ comparaHoy() }} }</div>
          </div>
          <div class="kpi">
            <div class="k-lbl">Costo por turno</div>
            <div class="k-val">{{ usd(m.costoPorTurno) }}</div>
            <div class="k-hint">{{ m.turnos.toLocaleString('es-CL') }} turnos este mes</div>
            <div class="k-hint" title="Parte de los tokens de entrada que se cobró a la tarifa de caché">Caché {{ pct(m.cacheRatio) }} de la entrada @if (m.ahorroCache > 0.001) { · ahorró {{ usd(m.ahorroCache) }} }</div>
          </div>
        </div>

        <!-- ─── Gasto diario ───────────────────────────────────── -->
        <div class="card chart-card">
          <div class="chart-head">
            <div>
              <h3>Gasto diario</h3>
              <p class="card-sub">Últimos 30 días. @if (m.ritmoPresupuesto) { La línea punteada es el ritmo que permite el presupuesto ({{ usd(m.ritmoPresupuesto) }}/día). }</p>
            </div>
            <div class="chart-total"><small>30 días</small><b>{{ usd(total30()) }}</b></div>
          </div>
          <div class="chart" (mouseleave)="hover.set(null)">
            <div class="y">
              @for (t of ticks(); track t) { <span [style.bottom.%]="(t / escala()) * 100">{{ usdCorto(t) }}</span> }
            </div>
            <div class="plot">
              @for (t of ticks(); track t) { <div class="grid-line" [style.bottom.%]="(t / escala()) * 100"></div> }
              @if (m.ritmoPresupuesto) { <div class="ritmo" [style.bottom.%]="min100((m.ritmoPresupuesto / escala()) * 100)"></div> }
              <div class="bars">
                @for (d of diario()!.dias; track d.dia; let i = $index) {
                  <div class="col" (mouseenter)="hover.set(i)" [class.hoy]="d.dia === diario()!.hoy.dia">
                    <div class="bar-v" [style.height.%]="(d.costo / escala()) * 100" [class.cero]="d.costo === 0"></div>
                  </div>
                }
              </div>
              @if (hover() !== null) {
                @let d = diario()!.dias[hover()!];
                <div class="tip" [style.left.%]="((hover()! + 0.5) / diario()!.dias.length) * 100" [class.der]="hover()! > diario()!.dias.length * 0.7">
                  <b>{{ fechaLarga(d.dia) }}</b>
                  <span>{{ usd(d.costo) }}</span>
                  <small>{{ d.turnos }} turnos · {{ tokensCorto(d.tokens) }} tokens</small>
                </div>
              }
            </div>
          </div>
          <div class="x">
            @for (d of diario()!.dias; track d.dia; let i = $index) {
              <span [class.sec]="i % 10 !== 0 && i !== diario()!.dias.length - 1">{{ i % 5 === 0 || i === diario()!.dias.length - 1 ? etiquetaDia(d.dia, i === diario()!.dias.length - 1) : '' }}</span>
            }
          </div>
        </div>

        <!-- ─── Pestañas ───────────────────────────────────────── -->
        <div class="tabs">
          <button class="tab" [class.on]="tab() === 'desglose'" (click)="ir('desglose')">Desglose</button>
          <button class="tab" [class.on]="tab() === 'turnos'" (click)="ir('turnos')">Turnos</button>
          <button class="tab" [class.on]="tab() === 'presupuestos'" (click)="ir('presupuestos')">Presupuestos @if (alertasPresupuesto()) { <span class="cnt warn">{{ alertasPresupuesto() }}</span> }</button>
          <button class="tab" [class.on]="tab() === 'precios'" (click)="ir('precios')">Precios @if (aproximados()) { <span class="cnt warn" title="Modelos con precio aproximado">{{ aproximados() }}</span> }</button>
        </div>

        @switch (tab()) {
          @case ('desglose') {
            <div class="desglose">
              @for (bloque of bloques(); track bloque.titulo) {
                <div class="card">
                  <h3>{{ bloque.titulo }}</h3>
                  <p class="card-sub">{{ bloque.sub }}</p>
                  @for (b of bloque.items; track b.key) {
                    <div class="bl">
                      <div class="bl-top"><span class="bl-nom" [title]="b.nombre">{{ b.nombre }}</span><span class="bl-val">{{ usd(b.costo) }}</span></div>
                      <div class="bl-bar"><i [style.width.%]="b.ancho"></i></div>
                      <div class="bl-sub"><span>{{ b.sub }}</span><span>{{ b.pct }}%</span></div>
                    </div>
                  } @empty { <div class="empty">Sin registros este mes</div> }
                </div>
              }
            </div>
          }

          @case ('turnos') {
            <div class="card">
              <div class="filtros">
                <select [ngModel]="orden()" (ngModelChange)="cambiarOrden($event)" title="Orden">
                  <option value="recientes">Más recientes</option>
                  <option value="costo">Más caros</option>
                </select>
                <select [ngModel]="filtroCanal()" (ngModelChange)="cambiarFiltro('canal', $event)" title="Canal">
                  <option value="">Todos los canales</option>
                  @for (c of facets().channels; track c) { <option [value]="c">{{ c }}</option> }
                </select>
                <select [ngModel]="filtroAgente()" (ngModelChange)="cambiarFiltro('agente', $event)" title="Agente">
                  <option value="">Todos los agentes</option>
                  @for (a of facets().agents; track a) { <option [value]="a">{{ a }}</option> }
                </select>
              </div>

              @if (!pagina()) { <div class="empty">Cargando…</div> }
              @else if (pagina()!.total === 0) { <div class="empty">Sin registros{{ hayFiltro() ? ' con esos filtros' : '' }}</div> }
              @else {
                <div class="turnos">
                  @for (r of pagina()!.rows; track r.id) {
                    <div class="tr" [class.open]="abierto() === r.id" (click)="abierto.set(abierto() === r.id ? null : (r.id ?? null))">
                      <div class="tr-main">
                        <div class="tr-q" [title]="r.user_input">{{ r.user_input || '(sin texto)' }}</div>
                        <div class="tr-meta">
                          <span>{{ hace(r.timestamp) }}</span>
                          <span class="chip">{{ r.channel || '—' }}</span>
                          <span>{{ r.agent || '—' }}</span>
                          <span class="dim">{{ modeloCorto(r.model) }}</span>
                          @if ((r.calls || 1) > 1) { <span class="chip" title="Llamadas al modelo en este turno: cada vuelta del loop de herramientas reenvía el contexto">×{{ r.calls }}</span> }
                          @if (r.price_source === 'familia' || r.price_source === 'default') { <span class="chip warn" title="Precio estimado">≈</span> }
                        </div>
                      </div>
                      <div class="tr-tok">{{ tokensCorto(r.input_tokens) }} <span class="dim">in</span> · {{ tokensCorto(r.output_tokens) }} <span class="dim">out</span></div>
                      <div class="tr-cost" [class.caro]="r.cost_usd >= caro()">{{ usd(r.cost_usd) }}</div>
                    </div>
                    @if (abierto() === r.id) {
                      <div class="tr-det">
                        @for (x of detalle(r); track x) { <span class="chip">{{ x }}</span> }
                        <span class="dim">{{ fechaHora(r.timestamp) }} · {{ r.model }}</span>
                      </div>
                    }
                  }
                </div>

                <div class="pager">
                  <span class="pager-info">{{ desde() }}–{{ hasta() }} de {{ pagina()!.total.toLocaleString('es-CL') }}</span>
                  <div class="row">
                    <select [ngModel]="tamano()" (ngModelChange)="cambiarTamano($event)" title="Filas por página">
                      @for (n of tamanos; track n) { <option [value]="n">{{ n }} por página</option> }
                    </select>
                    <button class="btn-icon" title="Anterior" [disabled]="pag() === 1" (click)="irPag(pag() - 1)"><i class="ph ph-caret-left"></i></button>
                    <span class="pager-info">{{ pag() }} / {{ totalPaginas() }}</span>
                    <button class="btn-icon" title="Siguiente" [disabled]="pag() >= totalPaginas()" (click)="irPag(pag() + 1)"><i class="ph ph-caret-right"></i></button>
                  </div>
                </div>
              }
            </div>
          }

          @case ('presupuestos') {
            <div class="card">
              <p class="card-sub">El global corta primero; los topes por canal son sublímites dentro de él. Al superarse, el canal deja de responder hasta el mes siguiente o hasta que subas el tope.</p>
              @for (b of todosLosPresupuestos(); track b.channel) {
                <div class="pres">
                  <div class="pres-nom">
                    <b>{{ b.channel === 'global' ? 'Global' : b.channel }}</b>
                    @if (b.isExceeded) { <span class="chip danger">superado</span> } @else if (b.isNearLimit) { <span class="chip warn">cerca del tope</span> }
                  </div>
                  <div class="pres-bar">
                    @if (b.budget > 0) {
                      <div class="bar" [class.warn]="b.isNearLimit" [class.danger]="b.isExceeded"><i [style.width.%]="min100(b.percentUsed)"></i></div>
                      <small>{{ usd(b.currentCost) }} de {{ usd(b.budget) }} · {{ b.percentUsed }}%</small>
                    } @else { <small class="dim">{{ usd(b.currentCost) }} gastado · sin tope propio</small> }
                  </div>
                  <div class="pres-edit">
                    @if (editTope() === b.channel) {
                      <input type="number" step="0.5" min="0" [(ngModel)]="nuevoTope" placeholder="USD" (keydown.enter)="guardarTope(b)" (keydown.escape)="editTope.set(null)" />
                      <button class="btn-primary sm" (click)="guardarTope(b)">Guardar</button>
                      <button class="btn-icon" title="Cancelar" (click)="editTope.set(null)"><i class="ph ph-x"></i></button>
                    } @else {
                      <button class="btn-secondary sm" (click)="editarTope(b)"><i class="ph ph-pencil-simple"></i> {{ b.budget > 0 ? 'Cambiar tope' : 'Poner tope' }}</button>
                    }
                  </div>
                </div>
              }
            </div>
          }

          @case ('precios') {
            <div class="card">
              <div class="chart-head">
                <p class="card-sub" style="margin:0">USD por millón de tokens. Orden: precio manual → catálogo LiteLLM (se refresca a diario) → familia (≈ aproximado). Catálogo: {{ catalogo()?.modelos ?? '—' }} modelos@if (catalogo()?.actualizado) { · actualizado {{ hace(catalogo()!.actualizado!) }} }.</p>
                <div class="row">
                  <button class="btn-secondary sm" (click)="refrescarPrecios()"><i class="ph ph-tag"></i> Actualizar catálogo</button>
                  <button class="btn-secondary sm" title="Recalcula el costo del mes con los precios de esta tabla" (click)="retarifar()"><i class="ph ph-calculator"></i> Retarifar mes</button>
                </div>
              </div>
              @if (precios().length === 0) { <div class="empty">Aún no hay modelos usados</div> }
              @else {
                <div class="tabla-scroll">
                  <table>
                    <tr><th>Modelo</th><th>Fuente</th><th class="num">Entrada</th><th class="num">Caché</th><th class="num">Salida</th><th class="num">Imagen</th><th class="num">Este mes</th><th></th></tr>
                    @for (p of preciosOrdenados(); track p.model) {
                      <tr>
                        <td><code>{{ p.model }}</code></td>
                        <td>
                          @switch (p.source) {
                            @case ('override') { <span class="chip ok" title="Precio fijado a mano">manual</span> }
                            @case ('catalogo') { <span class="chip" [title]="'LiteLLM: ' + p.key">catálogo</span> }
                            @case ('local') { <span class="chip">local $0</span> }
                            @default { <span class="chip warn" title="No está en el catálogo: precio estimado por familia. Fíjalo a mano si lo conoces.">≈ aproximado</span> }
                          }
                        </td>
                        @if (editPrecio() === p.model) {
                          <td class="num"><input type="number" step="0.01" min="0" class="pin" [(ngModel)]="edicion.in" /></td>
                          <td class="num"><input type="number" step="0.01" min="0" class="pin" [(ngModel)]="edicion.cached" placeholder="—" /></td>
                          <td class="num"><input type="number" step="0.01" min="0" class="pin" [(ngModel)]="edicion.out" /></td>
                          <td class="num dim">{{ p.imagen != null ? ('$' + p.imagen.toFixed(3)) : '—' }}</td>
                          <td class="num">{{ gastoModelo(p.model) }}</td>
                          <td class="acc">
                            <button class="btn-primary sm" (click)="guardarPrecio(p)">Guardar</button>
                            <button class="btn-icon" title="Cancelar" (click)="editPrecio.set(null)"><i class="ph ph-x"></i></button>
                          </td>
                        } @else {
                          <td class="num">{{ '$' + p.input.toFixed(3) }}</td>
                          <td class="num">{{ p.cached != null ? ('$' + p.cached.toFixed(3)) : '—' }}</td>
                          <td class="num">{{ '$' + p.output.toFixed(3) }}</td>
                          <td class="num">{{ p.imagen != null ? ('$' + p.imagen.toFixed(3) + ' c/u') : '—' }}</td>
                          <td class="num">{{ gastoModelo(p.model) }}</td>
                          <td class="acc">
                            <button class="btn-icon" title="Fijar precio a mano" (click)="editarPrecio(p)"><i class="ph ph-pencil-simple"></i></button>
                            @if (p.override) { <button class="btn-icon" title="Volver al catálogo" (click)="quitarPrecio(p)"><i class="ph ph-arrow-counter-clockwise"></i></button> }
                          </td>
                        }
                      </tr>
                    }
                  </table>
                </div>
              }
            </div>
          }
        }
      }
    </div>
  `,
  styles: [`
    .spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 14px; }
    .kpi { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 5px; }
    .kpi.alerta { border-color: rgba(245,158,11,.55); }
    .k-lbl { font-size: 12px; color: var(--text-dim); }
    .k-val { font-size: 26px; font-weight: 600; font-family: var(--font-title); line-height: 1.15; }
    .k-hint { font-size: 12px; color: var(--text-dim); display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
    .k-hint.warn { color: var(--warn); } .k-hint.ok { color: var(--ok); }
    .kpi .bar { margin-top: 2px; }

    .chart-card { padding-bottom: 12px; }
    .chart-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .chart-head h3 { margin: 0 0 2px; }
    .chart-total { text-align: right; display: flex; flex-direction: column; }
    .chart-total small { font-size: 11px; color: var(--text-dim); } .chart-total b { font-size: 18px; }
    .chart { display: grid; grid-template-columns: 48px 1fr; height: 190px; }
    .y { position: relative; }
    .y span { position: absolute; right: 8px; transform: translateY(50%); font-size: 11px; color: var(--text-dim); }
    .plot { position: relative; border-left: 1px solid var(--border-light); border-bottom: 1px solid var(--border-light); }
    .grid-line { position: absolute; left: 0; right: 0; border-top: 1px solid var(--border-light); opacity: .5; }
    .ritmo { position: absolute; left: 0; right: 0; border-top: 2px dashed var(--warn); opacity: .7; z-index: 1; pointer-events: none; }
    .bars { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 2px; padding: 0 2px; }
    .col { flex: 1; height: 100%; display: flex; align-items: flex-end; cursor: default; }
    .col:hover { background: rgba(129,140,248,.08); }
    .bar-v { width: 100%; background: var(--accent-primary); border-radius: 4px 4px 0 0; min-height: 2px; transition: opacity .15s; }
    .bar-v.cero { background: var(--border-light); }
    .col.hoy .bar-v { opacity: .6; }
    .tip { position: absolute; top: 4px; transform: translateX(-50%); background: var(--bg-main); border: 1px solid var(--border-light); border-radius: 8px; padding: 7px 10px; font-size: 12px; display: flex; flex-direction: column; gap: 1px; pointer-events: none; z-index: 5; white-space: nowrap; box-shadow: 0 8px 20px rgba(0,0,0,.3); }
    .tip.der { transform: translateX(-100%); }
    .tip span { font-size: 15px; font-weight: 600; }
    .tip small { color: var(--text-dim); }
    .x { display: grid; grid-template-columns: repeat(30, 1fr); margin-left: 48px; margin-top: 4px; }
    .x span { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: visible; }

    .tabs { display: flex; gap: 4px; margin: 18px 0 12px; border-bottom: 1px solid var(--border-light); overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
    .tabs::-webkit-scrollbar { display: none; }
    .tab { display: inline-flex; align-items: center; gap: 7px; padding: 10px 12px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--text-dim); font-size: 14px; cursor: pointer; white-space: nowrap; margin-bottom: -1px; }
    .tab:hover { color: var(--text-main); }
    .tab.on { color: var(--accent-primary); border-bottom-color: var(--accent-primary); }
    .cnt { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--bg-main); }
    .cnt.warn { background: rgba(245,158,11,.16); color: var(--warn); }

    .desglose { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .desglose .card { margin: 0; }
    .bl { padding: 8px 0; border-bottom: 1px solid var(--border-light); }
    .bl:last-child { border-bottom: 0; }
    .bl-top, .bl-sub { display: flex; justify-content: space-between; gap: 10px; }
    .bl-nom { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bl-val { font-size: 13.5px; font-variant-numeric: tabular-nums; }
    .bl-bar { height: 6px; border-radius: 999px; background: var(--bg-main); margin: 6px 0 4px; overflow: hidden; }
    .bl-bar i { display: block; height: 100%; background: var(--accent-primary); border-radius: 999px; }
    .bl-sub { font-size: 11.5px; color: var(--text-dim); }

    .filtros { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    .filtros select { width: auto; padding: 7px 10px; font-size: 13px; }
    .turnos { border-top: 1px solid var(--border-light); }
    .tr { display: grid; grid-template-columns: minmax(0, 1fr) 150px 90px; gap: 12px; align-items: center; padding: 10px 4px; border-bottom: 1px solid var(--border-light); cursor: pointer; }
    .tr:hover, .tr.open { background: rgba(129,140,248,.05); }
    .tr-q { font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tr-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); margin-top: 3px; }
    .tr-tok { font-size: 12.5px; text-align: right; font-variant-numeric: tabular-nums; }
    .tr-cost { font-size: 14px; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
    .tr-cost.caro { color: var(--warn); }
    .tr-det { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 8px 4px 12px; border-bottom: 1px solid var(--border-light); font-size: 12px; }
    .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; background: var(--bg-main); border: 1px solid var(--border-light); font-size: 11.5px; color: var(--text-dim); }
    .chip.warn { color: var(--warn); border-color: rgba(245,158,11,.4); }
    .chip.danger { color: var(--danger); border-color: rgba(239,68,68,.4); }
    .chip.ok { color: var(--ok); border-color: rgba(16,185,129,.4); }
    .dim { color: var(--text-dim); }
    .pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; flex-wrap: wrap; }
    .pager-info { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
    .pager select { padding: 6px 8px; font-size: 12px; width: auto; }
    .btn-icon[disabled] { opacity: .35; cursor: default; pointer-events: none; }
    .btn-primary.sm, .btn-secondary.sm { padding: 6px 11px; font-size: 12.5px; }

    .pres { display: grid; grid-template-columns: 180px minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border-light); }
    .pres:last-child { border-bottom: 0; }
    .pres-nom { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .pres-nom b { text-transform: capitalize; }
    .pres-bar { display: flex; flex-direction: column; gap: 5px; }
    .pres-bar small { font-size: 12px; color: var(--text-dim); }
    .pres-edit { display: flex; gap: 6px; align-items: center; }
    .pres-edit input { width: 100px; padding: 6px 9px; }

    .tabla-scroll { overflow-x: auto; }
    .pin { width: 80px; padding: 5px 7px; text-align: right; }
    td.acc { white-space: nowrap; text-align: right; }

    @media (max-width: 720px) {
      .chart { height: 160px; grid-template-columns: 40px 1fr; }
      .x { margin-left: 40px; }
      .x span.sec { visibility: hidden; }
      .tr { grid-template-columns: minmax(0, 1fr) auto; }
      .tr-tok { display: none; }
      .pres { grid-template-columns: 1fr; gap: 8px; }
    }
  `],
})
export class UsageComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  data = signal<UsageSummary | null>(null);
  diario = signal<UsageDaily | null>(null);
  budgets = signal<{ global: BudgetStatus; canales: BudgetStatus[] } | null>(null);
  cargando = signal(false);
  hover = signal<number | null>(null);
  tab = signal<Tab>(((): Tab => { try { return (localStorage.getItem('yisus_usage_tab') as Tab) || 'desglose'; } catch { return 'desglose'; } })());

  // Turnos
  pagina = signal<UsageHistoryPage | null>(null);
  pag = signal(1);
  tamano = signal(this.leerTamano());
  orden = signal<'recientes' | 'costo'>('recientes');
  filtroCanal = signal('');
  filtroAgente = signal('');
  abierto = signal<number | null>(null);
  facets = signal<{ channels: string[]; agents: string[] }>({ channels: [], agents: [] });
  readonly tamanos = [10, 25, 50, 100];

  // Presupuestos y precios
  editTope = signal<string | null>(null);
  nuevoTope: number | null = null;
  precios = signal<PriceRow[]>([]);
  catalogo = signal<CatalogoInfo | null>(null);
  editPrecio = signal<string | null>(null);
  edicion: { in: number | null; cached: number | null; out: number | null } = { in: null, cached: null, out: null };

  constructor() { this.load(); this.cargarPrecios(); }

  // ─── Derivados ─────────────────────────────────────────────────────────
  totalPaginas = computed(() => Math.max(1, Math.ceil((this.pagina()?.total || 0) / this.tamano())));
  desde = computed(() => (this.pagina()?.total ? (this.pag() - 1) * this.tamano() + 1 : 0));
  hasta = computed(() => Math.min(this.pag() * this.tamano(), this.pagina()?.total || 0));
  hayFiltro = computed(() => !!(this.filtroCanal() || this.filtroAgente()));
  pctMes = computed(() => { const m = this.diario()?.mes; return m && m.presupuesto > 0 ? Math.round((m.costo / m.presupuesto) * 100) : 0; });
  total30 = computed(() => (this.diario()?.dias || []).reduce((a, d) => a + d.costo, 0));
  /** Tope del eje: el máximo entre el día más caro y el ritmo del presupuesto, redondeado a un valor "limpio". */
  escala = computed(() => {
    const d = this.diario();
    const max = Math.max(...(d?.dias || []).map((x) => x.costo), d?.mes.ritmoPresupuesto || 0, 0.01);
    const pot = Math.pow(10, Math.floor(Math.log10(max)));
    const paso = [1, 2, 2.5, 5, 10].find((k) => k * pot >= max)! * pot;
    return paso;
  });
  ticks = computed(() => { const e = this.escala(); return [0, e / 2, e]; });
  /** Umbral para resaltar turnos caros: 5× el costo medio por turno (mín. $0,05). */
  caro = computed(() => Math.max(0.05, (this.diario()?.mes.costoPorTurno || 0) * 5));
  alertasPresupuesto = computed(() => this.todosLosPresupuestos().filter((b) => b.isNearLimit || b.isExceeded).length);
  aproximados = computed(() => this.precios().filter((p) => p.source === 'familia' || p.source === 'default').length);
  preciosOrdenados = computed(() => {
    const gasto = (m: string) => this.data()?.byModel.find((x) => x.model === m)?.total_cost || 0;
    return [...this.precios()].sort((a, b) => gasto(b.model) - gasto(a.model));
  });

  bloques = computed(() => {
    const d = this.data();
    if (!d) return [];
    const total = d.totalCost || 1;
    const barras = (items: Array<{ key: string; nombre: string; sub: string; costo: number }>): Barra[] => {
      const orden = [...items].sort((a, b) => b.costo - a.costo);
      const max = orden[0]?.costo || 1;
      return orden.map((x) => ({ ...x, pct: Math.round((x.costo / total) * 100), ancho: Math.max(1, (x.costo / max) * 100) }));
    };
    const porAgente = new Map<string, { costo: number; tokens: number; modelos: Set<string> }>();
    for (const a of d.byAgent) {
      const e = porAgente.get(a.agent) || { costo: 0, tokens: 0, modelos: new Set<string>() };
      e.costo += a.total_cost; e.tokens += a.input_tokens + a.output_tokens; e.modelos.add(this.modeloCorto(a.model));
      porAgente.set(a.agent, e);
    }
    return [
      { titulo: 'Por canal', sub: 'De dónde viene el consumo.', items: barras(d.byChannel.map((c) => ({ key: c.channel, nombre: c.channel, sub: `${c.count.toLocaleString('es-CL')} registros · ${this.tokensCorto(c.input_tokens + c.output_tokens)} tokens`, costo: c.total_cost }))) },
      { titulo: 'Por agente', sub: 'Quién se come el presupuesto dentro de cada turno.', items: barras([...porAgente.entries()].map(([k, v]) => ({ key: k, nombre: k, sub: `${[...v.modelos].join(', ')} · ${this.tokensCorto(v.tokens)} tokens`, costo: v.costo }))) },
      { titulo: 'Por modelo', sub: 'Qué modelos pesan más en la cuenta.', items: barras(d.byModel.map((m) => ({ key: m.model, nombre: this.modeloCorto(m.model), sub: `${this.tokensCorto(m.input_tokens + m.output_tokens)} tokens${m.aproximados ? ' · ≈ precio aproximado' : ''}`, costo: m.total_cost }))) },
    ];
  });

  // ─── Formatos ─────────────────────────────────────────────────────────
  usd(n: number) {
    const d = n === 0 ? 2 : Math.abs(n) >= 1 ? 2 : Math.abs(n) >= 0.01 ? 3 : 4;
    return '$' + n.toLocaleString('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  usdCorto(n: number) { return n === 0 ? '$0' : '$' + n.toLocaleString('es-CL', { maximumFractionDigits: n >= 1 ? 1 : 2 }); }
  tokensCorto(n: number) { return n >= 1e6 ? `${(n / 1e6).toLocaleString('es-CL', { maximumFractionDigits: 1 })} M` : n >= 1e3 ? `${Math.round(n / 1e3).toLocaleString('es-CL')} k` : String(n); }
  pct(r: number) { return `${Math.round(r * 100)}%`; }
  min100(v: number) { return Math.min(100, Math.max(0, v)); }
  modeloCorto(m: string) { const i = (m || '').indexOf('/'); return i > 0 ? m.slice(i + 1) : m; }
  mesNombre() { const s = new Date().toLocaleDateString('es-CL', { month: 'long', year: 'numeric' }); return s.charAt(0).toUpperCase() + s.slice(1); }
  private dia(iso: string) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
  fechaLarga(iso: string) { const s = this.dia(iso).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' }); return s.charAt(0).toUpperCase() + s.slice(1); }
  etiquetaDia(iso: string, esHoy: boolean) { return esHoy ? 'hoy' : this.dia(iso).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' }); }
  fechaHora(ts: string) { return new Date(ts).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' } as any); }
  hace(ts: string | number) {
    const t = new Date(ts).getTime(), diff = Date.now() - t, d = new Date(t);
    const hora = d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const dias = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
    if (diff < 60_000) return 'recién';
    if (diff < 3600_000) return `hace ${Math.round(diff / 60_000)} min`;
    if (dias === 0) return `hoy ${hora}`;
    if (dias === -1) return `ayer ${hora}`;
    if (dias > -7) return `${d.toLocaleDateString('es-CL', { weekday: 'short' })} ${hora}`;
    return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
  }
  comparaHoy() {
    const d = this.diario()!;
    const r = d.hoy.costo / (d.mes.promedioDiario || 1);
    if (r < 0.9) return `${Math.round((1 - r) * 100)}% bajo el promedio`;
    if (r > 1.1) return `${Math.round((r - 1) * 100)}% sobre el promedio`;
    return 'en el promedio';
  }
  detalle(r: UsageRecord): string[] {
    const out = [`${r.calls || 1} llamada${(r.calls || 1) === 1 ? '' : 's'} al modelo`];
    try { const pasos: string[] = r.steps ? JSON.parse(r.steps) : []; if (pasos.length) out.push(`herramientas: ${pasos.join(', ')}`); } catch {}
    if (r.images) out.push(`${r.images} imagen${r.images === 1 ? '' : 'es'}`);
    if (r.cached_tokens) out.push(`${this.tokensCorto(r.cached_tokens)} en caché`);
    if (r.thoughts_tokens) out.push(`${this.tokensCorto(r.thoughts_tokens)} de razonamiento`);
    if (r.price_source === 'familia' || r.price_source === 'default') out.push('precio aproximado');
    return out;
  }

  // ─── Carga ────────────────────────────────────────────────────────────
  load() {
    this.cargando.set(true);
    let pend = 3;
    const fin = () => { if (--pend === 0) this.cargando.set(false); };
    this.api.getUsage(1).subscribe({ next: (d) => { this.data.set(d); fin(); }, error: () => { fin(); this.toast.error('No se pudo cargar el consumo'); } });
    this.api.getUsageDaily(30).subscribe({ next: (d) => { this.diario.set(d); fin(); }, error: () => { fin(); this.toast.error('No se pudo cargar la serie diaria'); } });
    this.api.getBudgets().subscribe({ next: (b) => { this.budgets.set(b); fin(); }, error: () => fin() });
    this.cargarHistorial();
  }
  ir(t: Tab) { this.tab.set(t); try { localStorage.setItem('yisus_usage_tab', t); } catch {} }

  cargarHistorial() {
    this.api.getUsageHistory({ page: this.pag(), pageSize: this.tamano(), channel: this.filtroCanal() || undefined, agent: this.filtroAgente() || undefined, orden: this.orden() }).subscribe({
      next: (p) => {
        const ultima = Math.max(1, Math.ceil(p.total / p.pageSize));
        if (p.page > ultima && p.total > 0) { this.pag.set(ultima); this.cargarHistorial(); return; }
        this.pagina.set(p);
        if (p.facets) this.facets.set(p.facets);
      },
      error: () => this.toast.error('No se pudo cargar el historial'),
    });
  }
  irPag(p: number) { const d = Math.min(Math.max(1, p), this.totalPaginas()); if (d === this.pag()) return; this.pag.set(d); this.cargarHistorial(); }
  cambiarTamano(n: number | string) { const v = Number(n) || 25; this.tamano.set(v); try { localStorage.setItem('yisus_usage_page_size', String(v)); } catch {} this.pag.set(1); this.cargarHistorial(); }
  cambiarOrden(o: 'recientes' | 'costo') { this.orden.set(o); this.pag.set(1); this.cargarHistorial(); }
  cambiarFiltro(cual: 'canal' | 'agente', valor: string) { (cual === 'canal' ? this.filtroCanal : this.filtroAgente).set(valor || ''); this.pag.set(1); this.cargarHistorial(); }
  private leerTamano(): number { try { const v = Number(localStorage.getItem('yisus_usage_page_size')); return [10, 25, 50, 100].includes(v) ? v : 25; } catch { return 25; } }

  // ─── Presupuestos ─────────────────────────────────────────────────────
  todosLosPresupuestos(): BudgetStatus[] { const b = this.budgets(); return b ? [b.global, ...b.canales] : []; }
  editarTope(b: BudgetStatus) { this.nuevoTope = b.budget > 0 ? b.budget : null; this.editTope.set(b.channel); }
  guardarTope(b: BudgetStatus) {
    const v = this.nuevoTope;
    if (v === null || v === undefined || isNaN(Number(v)) || Number(v) < 0) { this.toast.error('Escribe un monto en USD'); return; }
    this.api.setBudget(Number(v), b.channel === 'global' ? undefined : b.channel).subscribe({
      next: () => { this.editTope.set(null); this.load(); this.toast.ok('Presupuesto actualizado'); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo actualizar'),
    });
  }

  // ─── Precios ──────────────────────────────────────────────────────────
  cargarPrecios() { this.api.getPrices().subscribe({ next: (r) => { this.catalogo.set(r.catalogo); this.precios.set(r.prices); }, error: () => {} }); }
  gastoModelo(model: string): string { const m = this.data()?.byModel.find((x) => x.model === model); return m ? `${this.usd(m.total_cost)}${m.aproximados ? ' ≈' : ''}` : '—'; }
  editarPrecio(p: PriceRow) {
    this.edicion = { in: p.override?.inputPricePer1M ?? p.input, cached: p.override?.cachedPricePer1M ?? p.cached ?? null, out: p.override?.outputPricePer1M ?? p.output };
    this.editPrecio.set(p.model);
  }
  guardarPrecio(p: PriceRow) {
    const e = this.edicion;
    if (e.in == null || e.out == null) { this.toast.error('Indica al menos entrada y salida'); return; }
    this.api.setPrice(p.model, { inputPricePer1M: Number(e.in), outputPricePer1M: Number(e.out), cachedPricePer1M: e.cached == null || e.cached === ('' as any) ? null : Number(e.cached) }).subscribe({
      next: (r) => { this.precios.set(r.prices); this.editPrecio.set(null); this.toast.ok(`Precio manual fijado para ${p.model}. Usa "Retarifar mes" para aplicarlo a lo ya consumido.`); },
      error: (err) => this.toast.error(err?.error?.error || 'No se pudo guardar'),
    });
  }
  quitarPrecio(p: PriceRow) {
    this.api.setPrice(p.model, null).subscribe({
      next: (r) => { this.precios.set(r.prices); this.toast.ok(`${p.model} vuelve al catálogo`); },
      error: (err) => this.toast.error(err?.error?.error || 'No se pudo quitar'),
    });
  }
  refrescarPrecios() {
    this.api.refreshPricing().subscribe({
      next: (r) => { this.toast.ok(r?.updated ? 'Catálogo de precios actualizado' : 'El catálogo ya estaba al día'); if (r?.catalogo) this.catalogo.set(r.catalogo); this.cargarPrecios(); this.load(); },
      error: () => this.toast.error('No se pudo actualizar el catálogo'),
    });
  }
  retarifar() {
    this.api.repriceUsage().subscribe({
      next: (r) => { this.toast.ok(`${r.filas} registros: ${this.usd(r.antes)} → ${this.usd(r.despues)}`); this.load(); },
      error: (err) => this.toast.error(err?.error?.error || 'No se pudo retarifar'),
    });
  }
}
