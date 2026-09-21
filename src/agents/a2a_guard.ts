import { currentA2AScope } from '../config/channels.js';

/**
 * Envoltorio de permisos para el canal A2A.
 *
 * El agente público monta TODAS las herramientas que estén marcadas como
 * disponibles para A2A, y el permiso se verifica al invocarlas, contra el alcance
 * del token que presentó el cliente. Antes se filtraba al construir el agente:
 * el modelo no veía la herramienta y respondía cualquier cosa; ahora la ve, la
 * intenta, y recibe una negativa explícita que puede transmitir con precisión.
 *
 * La herramienta original no se toca: se crea un objeto que hereda de ella y solo
 * intercepta la ejecución, de modo que el ADK la sigue reconociendo (los símbolos
 * de identificación del framework viajan por la cadena de prototipos).
 */
export function envolverConPermisoA2A(tool: any): any {
  const envuelta = Object.create(tool);

  envuelta.runAsync = async (params: any) => {
    const scope = currentA2AScope();

    // Sin alcance en contexto no estamos en A2A: la herramienta corre normal.
    if (!scope) return tool.runAsync(params);

    if (!scope.tools.includes(tool.name)) {
      console.warn(`🔒 [A2A] El token "${scope.name}" intentó usar "${tool.name}" y no lo tiene concedido.`);
      return {
        status: 'sin_permiso',
        message:
          `La herramienta "${tool.name}" existe pero este token no la tiene habilitada. ` +
          `Dile al interlocutor, sin rodeos, que por este canal no tienes acceso a eso y que ` +
          `si lo necesita se lo pida directamente a Jesús. No intentes rodearlo con otra herramienta.`,
      };
    }

    return tool.runAsync(params);
  };

  return envuelta;
}
