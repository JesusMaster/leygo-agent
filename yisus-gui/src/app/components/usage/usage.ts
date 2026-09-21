import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, UsageSummary, BudgetStatus } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { FriendlyDatePipe } from '../../pipes/friendly-date.pipe';

@Component({
  selector: 'app-usage',
  imports: [FormsModule, FriendlyDatePipe],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Consumo de tokens</h2>
          <p class="sub">
            Mes en curso. El output incluye los tokens de razonamiento, que Google factura como salida
            y antes no se contaban.
          </p>
        </div>
        <div class="row">
          <button class="btn-secondary" (click)="load()"><i class="ph ph-arrows-clockwise"></i> Actualizar</button>
          <button class="btn-secondary" (click)="refrescarPrecios()"><i class="ph ph-tag"></i> Actualizar precios</button>
        </div>
      </div>

      @if (!data()) {
        <div class="empty">Cargando consumo…</div>
      } @else {
        <div class="grid cols-4" style="margin-bottom:20px">
          <div class="stat">
            <div class="label">Gasto del mes</div>
            <div class="value">{{ '$' + data()!.totalCost.toFixed(4) }}</div>
            <div class="hint">de {{ '$' + data()!.monthlyBudget.toFixed(2) }} presupuestados</div>
          </div>
          <div class="stat">
            <div class="label">Tokens totales</div>
            <div class="value">{{ data()!.totalTokens.toLocaleString('es-CL') }}</div>
            <div class="hint">{{ data()!.inputTokens.toLocaleString('es-CL') }} in · {{ data()!.outputTokens.toLocaleString('es-CL') }} out</div>
          </div>
          <div class="stat">
            <div class="label">Proporción in/out</div>
            <div class="value">{{ ratio() }}</div>
            <div class="hint">un ratio muy alto delata output sin contabilizar</div>
          </div>
          <div class="stat">
            <div class="label">Presupuesto usado</div>
            <div class="value">{{ data()!.percentUsed }}%</div>
            <div class="bar" [class.warn]="data()!.percentUsed >= 80" [class.danger]="data()!.isExceeded" style="margin-top:8px">
              <i [style.width.%]="min100(data()!.percentUsed)"></i>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>Presupuestos</h3>
          <p class="card-sub">El global corta primero: los topes por canal actúan como sublímites dentro de él, no como cuotas garantizadas.</p>
          <table>
            <tr><th>Alcance</th><th class="num">Gastado</th><th class="num">Tope</th><th style="width:220px">Uso</th><th style="width:170px">Nuevo tope</th></tr>
            @for (b of todosLosPresupuestos(); track b.channel) {
              <tr>
                <td><strong>{{ b.channel === 'global' ? 'GLOBAL' : b.channel }}</strong></td>
                <td class="num">{{ '$' + b.currentCost.toFixed(4) }}</td>
                <td class="num">{{ b.budget > 0 ? ('$' + b.budget.toFixed(2)) : '—' }}</td>
                <td>
                  @if (b.budget > 0) {
                    <div class="bar" [class.warn]="b.isNearLimit" [class.danger]="b.isExceeded"><i [style.width.%]="min100(b.percentUsed)"></i></div>
                    <span style="font-size:12px;color:var(--text-dim)">{{ b.percentUsed }}%</span>
                  } @else {
                    <span class="badge dim">sin tope propio</span>
                  }
                </td>
                <td>
                  <div class="row">
                    <input type="number" step="0.5" min="0" [(ngModel)]="nuevoTope[b.channel]" placeholder="USD" />
                    <button class="btn-icon" title="Guardar" (click)="guardarTope(b)"><i class="ph ph-floppy-disk"></i></button>
                  </div>
                </td>
              </tr>
            }
          </table>
        </div>

        <div class="grid cols-2">
          <div class="card">
            <h3>Por canal</h3>
            <p class="card-sub">De dónde viene el consumo.</p>
            @if (data()!.byChannel.length === 0) { <div class="empty">Sin registros este mes</div> }
            @else {
              <table>
                <tr><th>Canal</th><th class="num">Llamadas</th><th class="num">Tokens</th><th class="num">Costo</th></tr>
                @for (c of data()!.byChannel; track c.channel) {
                  <tr>
                    <td>{{ c.channel }}</td>
                    <td class="num">{{ c.count }}</td>
                    <td class="num">{{ (c.input_tokens + c.output_tokens).toLocaleString('es-CL') }}</td>
                    <td class="num">{{ '$' + c.total_cost.toFixed(4) }}</td>
                  </tr>
                }
              </table>
            }
          </div>

          <div class="card">
            <h3>Por agente</h3>
            <p class="card-sub">Quién se está comiendo el presupuesto dentro de cada turno.</p>
            @if (data()!.byAgent.length === 0) { <div class="empty">Sin registros este mes</div> }
            @else {
              <table>
                <tr><th>Agente</th><th>Modelo</th><th class="num">Tokens</th><th class="num">Costo</th></tr>
                @for (a of data()!.byAgent; track a.agent + a.model) {
                  <tr>
                    <td><strong>{{ a.agent }}</strong></td>
                    <td style="color:var(--text-dim)">{{ a.model }}</td>
                    <td class="num">{{ (a.input_tokens + a.output_tokens).toLocaleString('es-CL') }}</td>
                    <td class="num">{{ '$' + a.total_cost.toFixed(4) }}</td>
                  </tr>
                }
              </table>
            }
          </div>
        </div>

        <div class="card">
          <h3>Últimos turnos</h3>
          <p class="card-sub">Un registro por combinación de agente y modelo en cada turno.</p>
          @if (historial().length === 0) { <div class="empty">Sin registros</div> }
          @else {
            <table>
              <tr><th>Cuándo</th><th>Canal</th><th>Agente</th><th>Modelo</th><th>Entrada</th><th class="num">in / out</th><th class="num">Costo</th></tr>
              @for (r of historial(); track r.id) {
                <tr>
                  <td style="color:var(--text-dim);white-space:nowrap">{{ r.timestamp | friendlyDate }}</td>
                  <td><span class="badge dim">{{ r.channel || '—' }}</span></td>
                  <td>{{ r.agent || '—' }}</td>
                  <td style="color:var(--text-dim)">{{ r.model }}</td>
                  <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis">{{ r.user_input }}</td>
                  <td class="num">{{ r.input_tokens.toLocaleString('es-CL') }} / {{ r.output_tokens.toLocaleString('es-CL') }}</td>
                  <td class="num">{{ '$' + r.cost_usd.toFixed(4) }}</td>
                </tr>
              }
            </table>
          }
        </div>
      }
    </div>
  `,
})
export class UsageComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  data = signal<UsageSummary | null>(null);
  budgets = signal<{ global: BudgetStatus; canales: BudgetStatus[] } | null>(null);
  nuevoTope: Record<string, number | null> = {};

  constructor() { this.load(); }

  load() {
    this.api.getUsage(200).subscribe({
      next: (d) => this.data.set(d),
      error: () => this.toast.error('No se pudo cargar el consumo'),
    });
    this.api.getBudgets().subscribe({
      next: (b) => this.budgets.set(b),
      error: () => {},
    });
  }

  historial() {
    return [...(this.data()?.allHistory || [])].reverse().slice(0, 50);
  }

  todosLosPresupuestos(): BudgetStatus[] {
    const b = this.budgets();
    if (!b) return [];
    return [b.global, ...b.canales];
  }

  ratio(): string {
    const d = this.data();
    if (!d || d.outputTokens === 0) return '—';
    return `${Math.round(d.inputTokens / d.outputTokens)} : 1`;
  }

  min100(v: number) { return Math.min(100, Math.max(0, v)); }

  guardarTope(b: BudgetStatus) {
    const valor = this.nuevoTope[b.channel];
    if (valor === null || valor === undefined || isNaN(Number(valor))) {
      this.toast.error('Escribe un monto en USD');
      return;
    }
    const channel = b.channel === 'global' ? undefined : b.channel;
    this.api.setBudget(Number(valor), channel).subscribe({
      next: () => { this.nuevoTope[b.channel] = null; this.load(); this.toast.ok('Presupuesto actualizado'); },
      error: (e) => this.toast.error(e?.error?.error || 'No se pudo actualizar'),
    });
  }

  refrescarPrecios() {
    this.api.refreshPricing().subscribe({
      next: (r: any) => this.toast.ok(r?.updated ? 'Catálogo de precios actualizado' : 'El catálogo ya estaba al día'),
      error: () => this.toast.error('No se pudo actualizar el catálogo'),
    });
  }
}
