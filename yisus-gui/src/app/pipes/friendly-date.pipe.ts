import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'friendlyDate' })
export class FriendlyDatePipe implements PipeTransform {
  transform(value: number | string | undefined | null): string {
    if (!value) return '—';
    const d = typeof value === 'number' ? new Date(value) : new Date(value);
    if (isNaN(d.getTime())) return '—';

    const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return 'recién';
    if (diffMin < 60) return `hace ${diffMin} min`;
    if (diffMin < 60 * 24) return `hace ${Math.round(diffMin / 60)} h`;
    return d.toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}
