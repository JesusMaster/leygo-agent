import { ChangeDetectorRef, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, TaskChannel, TaskDelivery, TaskDestinos } from '../../services/api.service';

/**
 * Selector de canales de entrega: cada canal es un checkbox y, si lo requiere,
 * su destino (espacio de Chat, correo, canal de Buzz). Se pueden marcar varios:
 * la tarea entrega por todos.
 */
@Component({
  selector: 'app-delivery-picker',
  imports: [FormsModule],
  template: `
    <div class="dp">
      @for (c of canales; track c.id) {
        <div class="dp-row" [class.on]="activo(c.id)">
          <label class="dp-check">
            <input type="checkbox" [checked]="activo(c.id)" (change)="toggle(c.id)" />
            <i class="ph" [class]="'ph ' + c.icono"></i>
            <span>{{ c.nombre }}</span>
          </label>

          @if (activo(c.id) && c.id !== 'telegram') {
            <div class="dp-target">
              @if (c.id === 'chat' && destinos()?.chat?.length) {
                <select [ngModel]="target(c.id)" (ngModelChange)="setTarget(c.id, $event)">
                  <option value="">Elige un espacio…</option>
                  @for (e of destinos()!.chat; track e.name) { <option [value]="e.name">{{ e.displayName }}</option> }
                </select>
              } @else if (c.id === 'a2a' && destinos()?.peers?.length) {
                <select [ngModel]="target(c.id)" (ngModelChange)="setTarget(c.id, $event)">
                  <option value="">Elige un agente…</option>
                  @for (p of destinos()!.peers; track p) { <option [value]="p">{{ p }}</option> }
                </select>
              } @else if (c.id === 'buzz' && destinos()?.buzz?.length) {
                <select [ngModel]="target(c.id)" (ngModelChange)="setTarget(c.id, $event)">
                  <option value="">Canal por defecto del bridge</option>
                  @for (ch of destinos()!.buzz; track ch) { <option [value]="ch">{{ ch }}</option> }
                </select>
              } @else if (cargando() && c.id !== 'email') {
                <span class="dp-hint">Cargando…</span>
              } @else {
                <input [type]="c.id === 'email' ? 'email' : 'text'" [ngModel]="target(c.id)" (ngModelChange)="setTarget(c.id, $event)" [placeholder]="c.placeholder" />
              }
            </div>
          }
        </div>
      }
      @if (destinos()?.errores?.length) { <small class="dp-warn">{{ destinos()!.errores.join(' · ') }}</small> }
    </div>
  `,
  styles: [`
    .dp { border: 1px solid var(--border-light); border-radius: 10px; background: var(--bg-input); overflow: hidden; }
    .dp-row { display: grid; grid-template-columns: 180px 1fr; align-items: center; gap: 12px; padding: 9px 12px; border-bottom: 1px solid var(--border-light); }
    .dp-row:last-of-type { border-bottom: 0; }
    .dp-row.on { background: rgba(129,140,248,.06); }
    .dp-check { display: flex; align-items: center; gap: 9px; cursor: pointer; font-size: 14px; }
    .dp-check input { width: 15px; height: 15px; accent-color: var(--accent-primary); cursor: pointer; }
    .dp-check i { color: var(--accent-primary); font-size: 17px; }
    .dp-target select, .dp-target input { width: 100%; box-sizing: border-box; padding: 7px 10px; font-size: 13px; }
    .dp-hint { font-size: 12px; color: var(--text-dim); }
    .dp-warn { display: block; padding: 8px 12px; font-size: 12px; color: var(--warn); border-top: 1px solid var(--border-light); }
    @media (max-width: 560px) { .dp-row { grid-template-columns: 1fr; } }
  `],
})
export class DeliveryPickerComponent {
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);

  value = input.required<TaskDelivery[]>();
  valueChange = output<TaskDelivery[]>();

  destinos = signal<TaskDestinos | null>(null);
  cargando = signal(false);

  readonly canales: Array<{ id: TaskChannel; nombre: string; icono: string; placeholder: string }> = [
    { id: 'telegram', nombre: 'Telegram',    icono: 'ph-telegram-logo',   placeholder: '' },
    { id: 'chat',     nombre: 'Google Chat', icono: 'ph-chats-circle',    placeholder: 'spaces/AAAA…' },
    { id: 'buzz',     nombre: 'Buzz (Nostr)',icono: 'ph-broadcast',       placeholder: 'id del canal, o vacío para el configurado' },
    { id: 'email',    nombre: 'Email',       icono: 'ph-envelope-simple', placeholder: 'alguien@dcanje.com' },
    { id: 'a2a',      nombre: 'Agente A2A',  icono: 'ph-robot',           placeholder: 'nombre del agente remoto' },
  ];

  activo(c: TaskChannel) { return this.value().some((d) => d.channel === c); }
  target(c: TaskChannel) { return this.value().find((d) => d.channel === c)?.target || ''; }

  toggle(c: TaskChannel) {
    if (this.activo(c)) {
      this.valueChange.emit(this.value().filter((d) => d.channel !== c));
      return;
    }
    const nuevo: TaskDelivery = { channel: c, target: c === 'email' ? (this.destinos()?.email || '') : '' };
    this.valueChange.emit([...this.value(), nuevo]);
    if (c !== 'telegram') this.cargarDestinos(() => {
      if (c === 'email' && !this.target('email') && this.destinos()?.email) this.setTarget('email', this.destinos()!.email!);
    });
  }

  setTarget(c: TaskChannel, t: string) {
    this.valueChange.emit(this.value().map((d) => (d.channel === c ? { ...d, target: t } : d)));
  }

  private cargarDestinos(despues?: () => void) {
    if (this.destinos()) { despues?.(); return; }
    if (this.cargando()) return;
    this.cargando.set(true);
    this.api.getTaskDestinos().subscribe({
      next: (d) => { this.destinos.set(d); this.cargando.set(false); despues?.(); this.cdr.markForCheck(); },
      error: () => { this.cargando.set(false); this.destinos.set({ chat: [], buzz: [], email: null, peers: [], errores: ['No se pudieron cargar los destinos'] }); },
    });
  }

  /** Validación reutilizable por quien lo use. */
  static valida(delivery: TaskDelivery[]): boolean {
    if (!delivery.length) return false;
    return delivery.every((d) => {
      const t = (d.target || '').trim();
      switch (d.channel) {
        case 'chat': return /^spaces\/[A-Za-z0-9_-]+$/.test(t);
        case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
        case 'a2a': return t.length > 0;
        default: return true;
      }
    });
  }
}
