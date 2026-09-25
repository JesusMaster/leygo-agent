/**
 * Cron legible y próximas ejecuciones, sin dependencias.
 * Soporta los 5 campos estándar con *, listas (1,3), rangos (1-5) y pasos (*\/15, 8-18/2).
 */

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIAS_CORTO = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Valores que acepta un campo, o null si es "*" (cualquiera). */
const NOMBRES: Record<string, string> = { sun: '0', mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6', jan: '1', feb: '2', mar: '3', apr: '4', may: '5', jun: '6', jul: '7', aug: '8', sep: '9', oct: '10', nov: '11', dec: '12' };

function expandir(campo: string, min: number, max: number): number[] | null {
  campo = campo.toLowerCase().replace(/[a-z]{3}/g, (n) => NOMBRES[n] ?? n);
  if (campo === '*' || campo === '?') return null;
  const out = new Set<number>();
  for (const parte of campo.split(',')) {
    const [rango, pasoStr] = parte.split('/');
    const paso = pasoStr ? parseInt(pasoStr, 10) : 1;
    let [a, b] = rango === '*' ? [min, max] : rango.split('-').map((x) => parseInt(x, 10));
    if (b === undefined || isNaN(b)) b = pasoStr ? max : a;
    if (isNaN(a) || isNaN(b) || paso < 1) throw new Error(`Campo cron inválido: ${campo}`);
    for (let v = a; v <= b; v += paso) out.add(max === 7 && v === 7 ? 0 : v); // 7 = domingo
  }
  return [...out].sort((x, y) => x - y);
}

function listaDias(d: number[]): string {
  const k = d.join(',');
  if (k === '1,2,3,4,5') return 'de lunes a viernes';
  if (k === '0,6') return 'los fines de semana';
  if (k === '0,1,2,3,4,5,6') return 'todos los días';
  // rango consecutivo
  if (d.length > 2 && d.every((v, i) => i === 0 || v === d[i - 1] + 1)) return `de ${DIAS[d[0]]} a ${DIAS[d[d.length - 1]]}`;
  if (d.length === 1) return `los ${DIAS[d[0]].endsWith('s') ? DIAS[d[0]] : DIAS[d[0]] + 's'}`;
  const n = d.map((x) => DIAS_CORTO[x]);
  return `los ${n.length > 1 ? n.slice(0, -1).join(', ') + ' y ' + n[n.length - 1] : n[0]}`;
}

const hh = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/** "0 9 * * 1-5" → "De lunes a viernes a las 09:00". Si no sabe describirla, devuelve la expresión. */
export function describirCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return `Cron: ${expr}`;
  try {
    const [mi, ho, dm, me, dw] = f;
    const mins = expandir(mi, 0, 59), horas = expandir(ho, 0, 23), dMes = expandir(dm, 1, 31), meses = expandir(me, 1, 12), dSem = expandir(dw, 0, 7);
    let dias = '';
    if (dSem && !dMes) dias = listaDias(dSem);
    else if (dMes && !dSem) dias = dMes.length === 1 ? `el día ${dMes[0]} de cada mes` : `los días ${dMes.join(', ')} de cada mes`;
    else if (!dMes && !dSem) dias = 'todos los días';
    else return `Cron: ${expr}`;
    if (meses) dias += ` de ${meses.map((m) => MESES[m - 1]).join(', ')}`;

    let cuando: string;
    if (mins && horas && mins.length === 1 && horas.length <= 4) cuando = `a las ${horas.map((h) => hh(h, mins[0])).join(', ')}`;
    else if (mins && mins.length === 1 && !horas) cuando = mins[0] === 0 ? 'cada hora en punto' : `cada hora al minuto ${mins[0]}`;
    else if (mins && mins.length === 1 && horas && /\//.test(ho) && !/-/.test(ho.split('/')[0]) ) cuando = `cada ${ho.split('/')[1]} horas`;
    else if (mins && mins.length === 1 && horas) cuando = `cada hora de ${hh(horas[0], mins[0])} a ${hh(horas[horas.length - 1], mins[0])}`;
    else if (/^\*\/\d+$/.test(mi) && !horas) cuando = `cada ${mi.slice(2)} minutos`;
    else if (/^\*\/\d+$/.test(mi) && horas) cuando = `cada ${mi.slice(2)} minutos entre ${hh(horas[0], 0)} y ${hh(horas[horas.length - 1], 59)}`;
    else return `Cron: ${expr}`;
    const s = `${dias} ${cuando}`;
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch {
    return `Cron: ${expr}`;
  }
}

/** Partes de fecha en una zona horaria (para comparar contra el cron en hora local). */
function partes(ms: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { min: +p.minute, hora: +p.hour % 24, dia: +p.day, mes: +p.month, dow };
}

/** Próximas `n` ejecuciones de una expresión cron (busca hasta ~60 días). */
export function proximasCron(expr: string, n = 3, tz = 'America/Santiago', desde = Date.now()): number[] {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return [];
  try { return buscar(f, n, tz, desde); } catch { return []; }
}

function buscar(f: string[], n: number, tz: string, desde: number): number[] {
  const [mins, horas, dMes, meses, dSem] = [expandir(f[0], 0, 59), expandir(f[1], 0, 23), expandir(f[2], 1, 31), expandir(f[3], 1, 12), expandir(f[4], 0, 7)];
  const out: number[] = [];
  let t = Math.floor(desde / 60000) * 60000 + 60000;
  const limite = desde + 60 * 86400000;
  while (t < limite && out.length < n) {
    const p = partes(t, tz);
    // Semántica cron: si ambos (día del mes y de la semana) están restringidos, basta uno.
    const okDia = dMes && dSem ? (dMes.includes(p.dia) || dSem.includes(p.dow)) : (!dMes || dMes.includes(p.dia)) && (!dSem || dSem.includes(p.dow));
    if ((!meses || meses.includes(p.mes)) && okDia && (!horas || horas.includes(p.hora)) && (!mins || mins.includes(p.min))) out.push(t);
    // saltos para no iterar minuto a minuto cuando la hora o el día no calzan
    if (horas && !horas.includes(p.hora)) t += (60 - p.min) * 60000;
    else t += 60000;
  }
  return out;
}
