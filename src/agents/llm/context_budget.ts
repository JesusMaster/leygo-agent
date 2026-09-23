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
  Coordinator: 160_000,        // ≈ 45k tokens: conversación larga pero acotada
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
export function recortarHistorial(contents: any[], maxChars: number): { contents: any[]; recortados: number } {
  if (!Array.isArray(contents) || contents.length === 0) return { contents, recortados: 0 };
  const tam = contents.map((c) => { try { return JSON.stringify(c).length; } catch { return 0; } });
  const total = tam.reduce((a, b) => a + b, 0);
  if (total <= maxChars) return { contents, recortados: 0 };

  // Índice del turno actual (último mensaje de usuario con texto): nunca se corta.
  let turnoActual = 0;
  for (let i = contents.length - 1; i >= 0; i--) if (esInicioDeTurno(contents[i])) { turnoActual = i; break; }

  // Desde el final, acumula hasta llenar el presupuesto.
  let acumulado = 0;
  let desde = contents.length;
  for (let i = contents.length - 1; i >= 0; i--) {
    if (acumulado + tam[i] > maxChars && i < turnoActual) break;
    acumulado += tam[i];
    desde = i;
  }
  // Avanza hasta un inicio de turno (sin pasar del actual).
  while (desde < turnoActual && !esInicioDeTurno(contents[desde])) desde++;
  if (desde === 0) return { contents, recortados: 0 };
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
        return { ...p, text: p.text.replace(MARCADOR_ADJUNTO, '[imagen/archivo ya entregado en ese turno]') };
      }
      MARCADOR_ADJUNTO.lastIndex = 0;
      const fr = p?.functionResponse;
      if (fr?.response && typeof fr.response === 'object') {
        const json = JSON.stringify(fr.response);
        if (MARCADOR_ADJUNTO.test(json)) {
          MARCADOR_ADJUNTO.lastIndex = 0; cambio = true;
          return { ...p, functionResponse: { ...fr, response: JSON.parse(json.replace(MARCADOR_ADJUNTO, '[ya entregado]')) } };
        }
        MARCADOR_ADJUNTO.lastIndex = 0;
      }
      return p;
    });
    return cambio ? { ...c, parts } : c;
  });
}

export function aplicarPresupuesto(llmRequest: any, agentName: string): { antes: number; despues: number; recortados: number } {
  const original: any[] = Array.isArray(llmRequest?.contents) ? llmRequest.contents : [];
  const antes = original.reduce((a, c) => { try { return a + JSON.stringify(c).length; } catch { return a; } }, 0);
  const limpios = neutralizarAdjuntosPrevios(limpiarRespuestasDeTools(original));
  const { contents, recortados } = recortarHistorial(limpios, VENTANA_POR_AGENTE[agentName] ?? VENTANA_DEFAULT);
  llmRequest.contents = contents;
  const despues = contents.reduce((a, c) => { try { return a + JSON.stringify(c).length; } catch { return a; } }, 0);
  return { antes, despues, recortados };
}
