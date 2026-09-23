/**
 * Higiene de contexto: lo que se le manda al modelo en cada llamada.
 *
 * El costo del agente es casi todo tokens de ENTRADA, y cada vuelta del loop de
 * herramientas reenvía el contexto completo. Dos fugas concretas:
 *
 *  1. Las herramientas devolvían `result` (texto) Y `data` (el mismo contenido
 *     como JSON): el modelo lo recibía dos veces. Acá se quita `data` y se
 *     acota `result` a un largo razonable por herramienta.
 *  2. Los subagentes comparten el id de sesión del Coordinator, así que su
 *     historial (correos enteros, chats…) crecía sin límite entre turnos.
 *     Acá se recorta el historial a una ventana por agente, cortando siempre
 *     en el inicio de un turno para no separar llamadas de sus respuestas.
 *
 * Nada de esto toca la sesión guardada: se trabaja sobre copias.
 */

/** Máximo de caracteres del `result` de cada herramienta (por defecto 12k ≈ 3,5k tokens). */
const TOPE_RESULT_POR_TOOL: Record<string, number> = {
  drive_read_file: 30_000,
  gmail_read_email: 15_000,
  chat_read_messages: 20_000,
  knowledge_search: 12_000,
  episodic_search: 12_000,
};
const TOPE_RESULT_DEFAULT = 12_000;

/** Ventana de historial por agente, en caracteres del JSON de `contents`. */
export const VENTANA_POR_AGENTE: Record<string, number> = {
  Coordinator: 90_000,         // ≈ 25k tokens: lo demás vive en la memoria episódica; cada turno paga este historial completo
  public_coordinator: 100_000,
  account_agent: 60_000,       // ≈ 17k tokens: correos y chats recientes
  knowledge_agent: 40_000,
  knowledge_public: 40_000,
  faq_agent: 30_000,
  triage_agent: 30_000,
};
const VENTANA_DEFAULT = 60_000;

function recortarTexto(texto: string, tope: number): string {
  if (texto.length <= tope) return texto;
  const sobra = texto.length - tope;
  return `${texto.slice(0, tope)}\n\n… [recortado: ${sobra.toLocaleString('es-CL')} caracteres más. Si necesitas ese tramo, pide algo más específico (otro rango, otro filtro o menos resultados).]`;
}

/** Deja las respuestas de herramientas livianas: sin `data`, con `result` acotado. */
export function limpiarRespuestasDeTools(contents: any[]): any[] {
  return contents.map((c) => {
    if (!Array.isArray(c?.parts)) return c;
    let cambio = false;
    const parts = c.parts.map((p: any) => {
      const fr = p?.functionResponse;
      if (!fr || !fr.response || typeof fr.response !== 'object') return p;
      const resp = { ...fr.response };
      let tocado = false;
      if ('data' in resp) { delete resp.data; tocado = true; }
      // El ADK envuelve respuestas no-objeto en { result }; las nuestras ya vienen con result.
      const tope = TOPE_RESULT_POR_TOOL[fr.name] ?? TOPE_RESULT_DEFAULT;
      for (const k of ['result', 'message']) {
        if (typeof resp[k] === 'string' && resp[k].length > tope) { resp[k] = recortarTexto(resp[k], tope); tocado = true; }
      }
      if (!tocado) return p;
      cambio = true;
      return { ...p, functionResponse: { ...fr, response: resp } };
    });
    return cambio ? { ...c, parts } : c;
  });
}

function esInicioDeTurno(c: any): boolean {
  return c?.role === 'user' && Array.isArray(c.parts) && c.parts.some((p: any) => typeof p?.text === 'string') && !c.parts.some((p: any) => p?.functionResponse);
}

/**
 * Recorta el historial a `maxChars`, manteniendo siempre el turno actual completo.
 * El corte se hace en un mensaje de usuario con texto, así ninguna functionCall
 * queda sin su functionResponse (Gemini lo rechaza).
 */
/** Ancla de recorte por conversación: el primer mensaje que se conservó la última vez. */
const anclas = new Map<string, string>();
const huella = (c: any): string => { try { const s = JSON.stringify(c); return `${s.length}:${s.slice(0, 400)}`; } catch { return ''; } };

/**
 * Con `clave` (agente + hilo) el corte es ESTABLE: una vez recortado, el historial
 * empieza siempre en el mismo mensaje hasta que vuelva a desbordar; entonces se
 * recorta de golpe hasta el 60 % del tope. Si el corte se moviera en cada turno,
 * el prefijo cambiaría y Gemini no reutilizaría el caché de prompt.
 */
export function recortarHistorial(contents: any[], maxChars: number, clave?: string): { contents: any[]; recortados: number } {
  if (!Array.isArray(contents) || contents.length === 0) return { contents, recortados: 0 };
  const tam = contents.map((c) => { try { return JSON.stringify(c).length; } catch { return 0; } });
  const total = tam.reduce((a, b) => a + b, 0);

  // Índice del turno actual (último mensaje de usuario con texto): nunca se corta.
  let turnoActual = 0;
  for (let i = contents.length - 1; i >= 0; i--) if (esInicioDeTurno(contents[i])) { turnoActual = i; break; }

  // ¿Sigue valiendo el ancla anterior?
  const ancla = clave ? anclas.get(clave) : undefined;
  if (ancla) {
    const i = contents.findIndex((c) => huella(c) === ancla);
    if (i > 0 && i <= turnoActual) {
      const desdeAncla = tam.slice(i).reduce((a, b) => a + b, 0);
      if (desdeAncla <= maxChars) return { contents: contents.slice(i), recortados: i };
    }
  }
  if (total <= maxChars) return { contents, recortados: 0 };

  // Desbordó: desde el final, acumula hasta el objetivo (60 % del tope, para no recortar en cada turno).
  const objetivo = clave ? Math.floor(maxChars * 0.6) : maxChars;
  let acumulado = 0;
  let desde = contents.length;
  for (let i = contents.length - 1; i >= 0; i--) {
    if (acumulado + tam[i] > objetivo && i < turnoActual) break;
    acumulado += tam[i];
    desde = i;
  }
  // Avanza hasta un inicio de turno (sin pasar del actual).
  while (desde < turnoActual && !esInicioDeTurno(contents[desde])) desde++;
  if (desde === 0) return { contents, recortados: 0 };
  if (clave) anclas.set(clave, huella(contents[desde]));
  return { contents: contents.slice(desde), recortados: desde };
}

/** Aplica ambas limpiezas a un LlmRequest (sobre copias). Devuelve un resumen para log. */
const MARCADOR_ADJUNTO = /\[\[\s*adjunto\s*:\s*[a-f0-9-]{16,72}\s*\]\]/gi;

/**
 * Los marcadores [[adjunto:ID]] de turnos ANTERIORES se neutralizan: si quedan en el
 * historial, el modelo los copia en respuestas posteriores ("Excelente gracias" →
 * el canal volvía a mandar la foto). Solo el turno actual conserva los suyos.
 */
export function neutralizarAdjuntosPrevios(contents: any[]): any[] {
  if (!Array.isArray(contents) || !contents.length) return contents;
  let inicioTurno = 0;
  for (let i = contents.length - 1; i >= 0; i--) if (esInicioDeTurno(contents[i])) { inicioTurno = i; break; }
  return contents.map((c, i) => {
    if (i >= inicioTurno || !Array.isArray(c?.parts)) return c;
    let cambio = false;
    const parts = c.parts.map((p: any) => {
      if (typeof p?.text === 'string' && MARCADOR_ADJUNTO.test(p.text)) {
        MARCADOR_ADJUNTO.lastIndex = 0; cambio = true;
        // Se borra sin dejar rastro: cualquier texto sustituto termina copiado por el modelo ("[imagen ya entregada]")
        return { ...p, text: p.text.replace(MARCADOR_ADJUNTO, '').replace(/\n{3,}/g, '\n\n').trim() || '(imagen enviada)' };
      }
      MARCADOR_ADJUNTO.lastIndex = 0;
      const fr = p?.functionResponse;
      if (fr?.response && typeof fr.response === 'object') {
        const json = JSON.stringify(fr.response);
        if (MARCADOR_ADJUNTO.test(json)) {
          MARCADOR_ADJUNTO.lastIndex = 0; cambio = true;
          return { ...p, functionResponse: { ...fr, response: JSON.parse(json.replace(MARCADOR_ADJUNTO, '')) } };
        }
        MARCADOR_ADJUNTO.lastIndex = 0;
      }
      return p;
    });
    return cambio ? { ...c, parts } : c;
  });
}

export function aplicarPresupuesto(llmRequest: any, agentName: string, hilo?: string): { antes: number; despues: number; recortados: number } {
  const original: any[] = Array.isArray(llmRequest?.contents) ? llmRequest.contents : [];
  const antes = original.reduce((a, c) => { try { return a + JSON.stringify(c).length; } catch { return a; } }, 0);
  const limpios = neutralizarAdjuntosPrevios(limpiarRespuestasDeTools(original));
  const { contents, recortados } = recortarHistorial(limpios, VENTANA_POR_AGENTE[agentName] ?? VENTANA_DEFAULT, hilo ? `${agentName}::${hilo}` : undefined);
  llmRequest.contents = contents;
  const despues = contents.reduce((a, c) => { try { return a + JSON.stringify(c).length; } catch { return a; } }, 0);
  return { antes, despues, recortados };
}
