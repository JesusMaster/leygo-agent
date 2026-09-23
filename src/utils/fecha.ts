/**
 * Fecha y hora actual (America/Santiago) al inicio de la instrucción: sin esto el
 * Coordinator no sabe qué hora es y se pone a buscarla en Calendar/Gmail (un
 * "¿qué hora es?" llegó a costar 260k tokens).
 */
export function fechaHoraActual(): string {
  const ahora = new Date();
  const fecha = ahora.toLocaleDateString('es-CL', { timeZone: 'America/Santiago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const hora = ahora.toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' });
  return `FECHA Y HORA ACTUAL: ${fecha}, ${hora} (America/Santiago). Úsala directamente para cualquier pregunta de fecha u hora; no la busques en herramientas.\n`;
}

