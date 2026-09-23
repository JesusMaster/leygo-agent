import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { commitmentsService } from '../../services/commitments.service.js';
import type { Commitment, CommitmentStatus } from '../../database/sqlite.service.js';
import { currentUsageScope } from '../../utils/usage_collector.js';

function hoy(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: process.env.SCHEDULER_TZ || 'America/Santiago' });
}

function fmt(c: Commitment): string {
  const estado = { propuesto: '🟣 propuesto', pendiente: '⚪ pendiente', en_curso: '🔵 en curso', hecho: '✅ hecho', cancelado: '⛔ cancelado', descartado: '🗑️ descartado' }[c.status] || c.status;
  const fecha = c.due_date ? `📅 ${c.due_date}${c.due_date < hoy() && ['pendiente', 'en_curso'].includes(c.status) ? ' (VENCIDO)' : ''}` : c.proposed_due ? `📅 sugerida ${c.proposed_due} (sin visto bueno)` : '📅 sin fecha';
  const quien = c.mine ? 'lo debe Jesús' : `lo debe ${c.owner}`;
  return `[${c.id}] ${c.title}\n   ${estado} · ${quien}${c.counterpart ? ` · con ${c.counterpart}` : ''} · ${fecha} · prioridad ${c.priority}${c.source_title ? `\n   origen: ${c.source_type} — ${c.source_title}` : ''}${c.detail ? `\n   ${c.detail}` : ''}`;
}

/** Buzz y A2A son terceros: pueden consultar lo suyo, no cambiar la lista de Jesús. */
function externo(): boolean {
  const ch = currentUsageScope()?.channel;
  return ch === 'buzz' || ch === 'a2a';
}
const cabecera = () => `Hoy es ${hoy()}.${externo() ? ' (Canal externo: el interlocutor NO es Jesús; muestra solo lo que le concierne y no cambies nada.)' : ''}`;
const SOLO_JESUS = { status: 'sin_permiso', result: 'Solo Jesús puede crear o cambiar compromisos. Registra el pedido como nota con commitment_note y dile que Jesús lo confirma.' };

export const commitmentsList = new FunctionTool({
  name: 'commitments_list',
  description: 'Lista los compromisos (lo que Jesús debe y lo que le deben) con filtros: abiertos, propuestos (detectados por la IA y aún sin aceptar), vencidos, hoy, sin_fecha, hechos o todos. Úsala para "¿qué tengo pendiente?", "¿qué le debo a X?", "¿qué venció?".',
  parameters: z.object({
    filtro: z.enum(['abiertos', 'propuestos', 'vencidos', 'hoy', 'sin_fecha', 'hechos', 'todos']).optional().describe('Por defecto "abiertos" (pendiente + en curso).'),
    mine: z.boolean().optional().describe('true = solo los que debe Jesús; false = solo los que le deben a Jesús; omitir = ambos.'),
    q: z.string().optional().describe('Texto para filtrar por título, detalle, contraparte o responsable.'),
    limit: z.number().optional(),
  }) as any,
  execute: async (args: any) => {
    const { filtro = 'abiertos', mine, q, limit = 30 } = args;
    const h = hoy();
    let items: Commitment[];
    switch (filtro) {
      case 'propuestos': items = commitmentsService.listar({ status: ['propuesto'], mine, q, limit }); break;
      case 'vencidos':   items = commitmentsService.listar({ vencidos: true, mine, q, limit }); break;
      case 'hoy':        items = commitmentsService.listar({ status: ['pendiente', 'en_curso'], mine, q, limit: 200 }).filter((c) => c.due_date === h); break;
      case 'sin_fecha':  items = commitmentsService.listar({ status: ['pendiente', 'en_curso'], sinFecha: true, mine, q, limit }); break;
      case 'hechos':     items = commitmentsService.listar({ status: ['hecho'], mine, q, limit }); break;
      case 'todos':      items = commitmentsService.listar({ mine, q, limit }); break;
      default:           items = commitmentsService.listar({ status: ['pendiente', 'en_curso'], mine, q, limit });
    }
    const stats = commitmentsService.stats();
    if (!items.length) return { status: 'success', result: `${cabecera()} No hay compromisos para el filtro "${filtro}". Totales: ${stats.pendiente} pendientes, ${stats.en_curso} en curso, ${stats.propuesto} propuestos, ${stats.vencidos} vencidos.` };
    return { status: 'success', result: `${cabecera()} ${items.length} compromiso(s) [${filtro}]:\n\n${items.map(fmt).join('\n\n')}\n\nTotales: ${stats.pendiente} pendientes · ${stats.en_curso} en curso · ${stats.propuesto} propuestos · ${stats.vencidos} vencidos.` };
  },
});

export const commitmentSearch = new FunctionTool({
  name: 'commitment_search',
  description: 'Busca compromisos por significado (no solo por palabras exactas): "algo del deploy de España", "lo que le prometí a Sebastián". Devuelve los más parecidos, abiertos primero.',
  parameters: z.object({ query: z.string(), soloAbiertos: z.boolean().optional() }) as any,
  execute: async (args: any) => {
    const items = await commitmentsService.buscar(args.query, { soloAbiertos: args.soloAbiertos ?? true, limit: 8 });
    if (!items.length) return { status: 'success', result: `${cabecera()} Nada parecido a "${args.query}".` };
    return { status: 'success', result: `${cabecera()} Coincidencias para "${args.query}":\n\n${items.map(fmt).join('\n\n')}` };
  },
});

export const commitmentCreate = new FunctionTool({
  name: 'commitment_create',
  description: 'Registra un compromiso nuevo a mano ("anota que le debo el informe a Sebastián el viernes", "recuérdame que Pablo me debe la cotización"). Entra directo como pendiente. Si no hay fecha, se guarda con una fecha SUGERIDA que Jesús debe confirmar.',
  parameters: z.object({
    title: z.string().describe('El compromiso, concreto y accionable.'),
    detail: z.string().optional(),
    owner: z.string().optional().describe('Responsable. Omitir o "Jesús" si lo debe él; el nombre de la otra persona si se lo deben a Jesús.'),
    counterpart: z.string().optional().describe('Con quién o para quién.'),
    due: z.string().optional().describe('Fecha comprometida YYYY-MM-DD. Convierte expresiones como "el viernes" usando la fecha de hoy.'),
    priority: z.enum(['alta', 'media', 'baja']).optional(),
  }) as any,
  execute: async (args: any) => {
    if (externo()) return SOLO_JESUS;
    try {
      const c = await commitmentsService.crear(args, { type: 'manual' }, 'jesus');
      const fecha = c.due_date ? `con fecha ${c.due_date}` : `sin fecha; te sugiero ${c.proposed_due} — confírmala o dime otra`;
      return { status: 'success', result: `${cabecera()} Registrado [${c.id}] "${c.title}" ${fecha}.` };
    } catch (err: any) { return { status: 'error', message: err.message }; }
  },
});

export const commitmentAccept = new FunctionTool({
  name: 'commitment_accept',
  description: 'Acepta un compromiso propuesto (pasa a pendiente) y/o confirma su fecha. Si Jesús dice "acepta el abc123" sin fecha, se usa la sugerida. También sirve para fijar la fecha de uno pendiente sin fecha.',
  parameters: z.object({ id: z.string(), due: z.string().optional().describe('YYYY-MM-DD; omitir para usar la fecha sugerida.') }) as any,
  execute: async (args: any) => {
    if (externo()) return SOLO_JESUS;
    const c = await commitmentsService.aceptar(args.id, args.due || null, 'jesus');
    if (!c) return { status: 'error', message: `No existe el compromiso ${args.id}` };
    return { status: 'success', result: `${cabecera()} [${c.id}] "${c.title}" queda ${c.status} para el ${c.due_date}.` };
  },
});

export const commitmentUpdate = new FunctionTool({
  name: 'commitment_update',
  description: 'Cambia un compromiso: estado (en_curso, hecho, cancelado, descartado, pendiente), fecha, responsable, contraparte, prioridad o título. Úsala cuando Jesús dé feedback: "ya lo hice", "se corre al lunes", "cancélalo", "esto lo va a hacer Pablo". Incluye la nota con el contexto que dio.',
  parameters: z.object({
    id: z.string(),
    status: z.enum(['propuesto', 'pendiente', 'en_curso', 'hecho', 'cancelado', 'descartado']).optional(),
    due: z.string().optional().describe('YYYY-MM-DD'),
    owner: z.string().optional(),
    counterpart: z.string().optional(),
    priority: z.enum(['alta', 'media', 'baja']).optional(),
    title: z.string().optional(),
    note: z.string().optional().describe('Feedback o contexto textual de Jesús, tal como lo dijo (resumido).'),
  }) as any,
  execute: async (args: any) => {
    if (externo()) return SOLO_JESUS;
    const { id, status, due, owner, counterpart, priority, title, note } = args;
    const cambios: any = {};
    if (status) cambios.status = status as CommitmentStatus;
    if (due) cambios.due_date = due;
    if (owner) cambios.owner = owner;
    if (counterpart) cambios.counterpart = counterpart;
    if (priority) cambios.priority = priority;
    if (title) cambios.title = title;
    const c = await commitmentsService.actualizar(id, cambios, 'jesus', note);
    if (!c) return { status: 'error', message: `No existe el compromiso ${id}` };
    return { status: 'success', result: `${cabecera()} Actualizado:\n${fmt(c)}` };
  },
});

export const commitmentNote = new FunctionTool({
  name: 'commitment_note',
  description: 'Agrega una nota de seguimiento a un compromiso sin cambiar su estado ("hablé con X, está en revisión").',
  parameters: z.object({ id: z.string(), text: z.string() }) as any,
  execute: async (args: any) => {
    const ok = commitmentsService.nota(args.id, args.text, 'jesus');
    return ok ? { status: 'success', result: `Nota agregada a [${args.id}].` } : { status: 'error', message: `No existe el compromiso ${args.id}` };
  },
});

export const commitmentHistory = new FunctionTool({
  name: 'commitment_history',
  description: 'Historial de un compromiso: cuándo se detectó, cambios de estado y fecha, notas de seguimiento.',
  parameters: z.object({ id: z.string() }) as any,
  execute: async (args: any) => {
    const c = commitmentsService.obtener(args.id);
    if (!c) return { status: 'error', message: `No existe el compromiso ${args.id}` };
    const h = commitmentsService.historial(args.id, 30);
    return { status: 'success', result: `${fmt(c)}\n\nHistorial:\n${h.map((u) => `• ${new Date(u.at).toLocaleString('es-CL', { timeZone: process.env.SCHEDULER_TZ || 'America/Santiago' })} (${u.by}) ${u.kind}: ${u.text}`).join('\n') || '(sin movimientos)'}` };
  },
});

export const commitmentNotify = new FunctionTool({
  name: 'commitment_notify',
  description: 'Avisa a la contraparte de un compromiso por un canal: email (correo de la persona), chat (spaceName de Google Chat, p. ej. spaces/AAAA), buzz (canal por defecto), a2a (nombre del agente remoto) o telegram (Jesús). Úsala cuando Jesús diga "avísale a X que ya está", "notifícalo por correo" o, con tipo=recordatorio, "mándale un friendly reminder a X" (para lo que le deben a Jesús). Si no hay mensaje, se redacta uno en tono de Jesús.',
  parameters: z.object({
    id: z.string(),
    tipo: z.enum(['aviso', 'recordatorio']).optional().describe('recordatorio = friendly reminder a quien le debe algo a Jesús. Por defecto aviso.'),
    channel: z.enum(['email', 'chat', 'buzz', 'a2a', 'telegram']),
    target: z.string().optional().describe('Correo, spaceName de Chat, canal de Buzz o nombre del agente A2A. No aplica a telegram.'),
    message: z.string().optional().describe('Texto a enviar. Omitir para usar el mensaje por defecto.'),
  }) as any,
  execute: async (args: any) => {
    if (externo()) return SOLO_JESUS;
    try {
      const c = commitmentsService.obtener(args.id);
      if (!c) return { status: 'error', message: `No existe el compromiso ${args.id}` };
      const mensaje = args.message || (args.tipo === 'recordatorio' ? commitmentsService.mensajeRecordatorio(c) : undefined);
      const r = await commitmentsService.notificar(args.id, [{ channel: args.channel, target: args.target || null }], mensaje, 'agente');
      return { status: 'success', result: `${args.tipo === 'recordatorio' ? 'Friendly reminder enviado' : 'Avisado'} por ${r.enviados.join(' + ')}${r.fallos.length ? ` (fallos: ${r.fallos.join(' · ')})` : ''}.` };
    } catch (err: any) { return { status: 'error', message: err.message }; }
  },
});

export const commitmentsOverview = new FunctionTool({
  name: 'commitments_overview',
  description: 'Panorama rápido: vencidos, para hoy, próximos 7 días y propuestos sin revisar. Ideal para "¿cómo voy con mis compromisos?".',
  parameters: z.object({}) as any,
  execute: async () => {
    const t = commitmentsService.textoDigest();
    return { status: 'success', result: `${cabecera()}\n\n${t || 'Sin vencidos, nada para hoy, nada en los próximos 7 días y nada propuesto por revisar.'}` };
  },
});
