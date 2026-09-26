import { resolveTools } from './tool_catalog.js';
import { envolverConPermisoA2A } from './a2a_guard.js';
import { customAgentsService, reemplazarToolsVivas } from './custom/custom_agents.service.js';
import { getChannelTools, getToolsDisponiblesA2A } from '../config/channels.js';

type Canal = 'telegram' | 'buzz' | 'api' | 'a2a';

/**
 * Aplica config/channels.json a los agentes que ya están corriendo, sin reiniciar.
 * Los coordinadores se construyen al arrancar; acá solo se les cambia la lista de
 * herramientas (incluidos los agentes personalizados de ese canal).
 */
export function aplicarHerramientasEnCaliente(canal: Canal): number {
  const nombres = canal === 'a2a' ? getToolsDisponiblesA2A() : getChannelTools(canal);
  const n = reemplazarToolsVivas(canal, (wrap) => {
    const tools = customAgentsService.unirSinDuplicar(resolveTools(nombres), customAgentsService.toolsParaCanal(canal));
    // En A2A el guard de permisos por token es obligatorio aunque el registro no traiga wrap.
    const envolver = wrap ?? (canal === 'a2a' ? envolverConPermisoA2A : undefined);
    return envolver ? tools.map(envolver) : tools;
  });
  console.log(`🔁 [Canales] "${canal}" actualizado en caliente: ${nombres.length} herramienta(s) en ${n} agente(s)`);
  return n;
}

export function aplicarTodosLosCanales(): void {
  for (const c of ['telegram', 'buzz', 'api', 'a2a'] as const) aplicarHerramientasEnCaliente(c);
}
