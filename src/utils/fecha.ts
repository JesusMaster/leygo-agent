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


/**
 * Sufijo que se agrega al mensaje del usuario al guardarlo en la sesión. Va en el
 * mensaje (y no en la instrucción del sistema) para que instrucción + herramientas +
 * historial sean un prefijo ESTABLE entre llamadas: así Gemini reutiliza el caché
 * de prompt (≈90 % de descuento en esos tokens). Un reloj en la instrucción lo
 * invalidaba cada minuto.
 */
export function sufijoFechaMensaje(): string {
  const ahora = new Date();
  const fecha = ahora.toLocaleDateString('es-CL', { timeZone: 'America/Santiago', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
  const hora = ahora.toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' });
  return `\n\n[enviado: ${fecha} ${hora} America/Santiago]`;
}

/** Nota estática para la instrucción del Coordinator (no cambia entre llamadas). */
export const NOTA_FECHA = `FECHA Y HORA: cada mensaje del usuario termina con "[enviado: <fecha> <hora> America/Santiago]". Esa es la fecha y hora actual: úsala directamente para cualquier pregunta de fecha u hora y no la busques en herramientas. No repitas ese sufijo en tus respuestas.\n`;
