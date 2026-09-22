/**
 * Verificación del control de permisos por token en A2A.
 *
 * Simula el alcance de un token (lo que hace a2aAuth al validar el Bearer) y
 * ejecuta las herramientas envueltas para comprobar que las no concedidas
 * devuelven `sin_permiso` en vez de correr.
 *
 *   npx tsx scripts/verificar_permisos_a2a.ts
 */
import 'dotenv/config';
import { TOOL_CATALOG } from '../src/agents/tool_catalog.js';
import { envolverConPermisoA2A } from '../src/agents/a2a_guard.js';
import { setCurrentA2AScope, getToolsDisponiblesA2A } from '../src/config/channels.js';

const CONCEDIDAS = ['knowledge_agent', 'faq_agent', 'knowledge_public'];
const A_PROBAR = ['get_token_usage', 'account_agent', 'knowledge_public'];

async function main() {
  console.log('Herramientas publicadas en A2A:', getToolsDisponiblesA2A().length);
  console.log('Alcance simulado del token   :', CONCEDIDAS.join(', '));
  console.log('');

  setCurrentA2AScope({ name: 'A2A openclaw (simulado)', tools: CONCEDIDAS } as any);

  let fallos = 0;

  for (const nombre of A_PROBAR) {
    const original = TOOL_CATALOG[nombre];
    if (!original) {
      console.log(`  ?  ${nombre}: no está en el catálogo`);
      continue;
    }
    const envuelta = envolverConPermisoA2A(original);
    const permitida = CONCEDIDAS.includes(nombre);

    let resultado: any;
    try {
      resultado = await envuelta.runAsync({ args: {}, toolContext: {} as any });
    } catch (e: any) {
      resultado = { status: 'excepcion', message: e?.message };
    }

    const bloqueada = resultado?.status === 'sin_permiso';

    if (permitida && bloqueada) {
      console.log(`  x  ${nombre}: CONCEDIDA pero fue bloqueada`);
      fallos++;
    } else if (!permitida && !bloqueada) {
      console.log(`  x  ${nombre}: NO concedida y el guard la dejo correr`);
      console.log(`     respuesta: ${String(JSON.stringify(resultado)).slice(0, 200)}`);
      fallos++;
    } else if (!permitida && bloqueada) {
      console.log(`  ok ${nombre}: bloqueada correctamente`);
    } else {
      console.log(`  ok ${nombre}: concedida y ejecutada`);
    }
  }

  console.log('');
  console.log(fallos === 0 ? 'OK El guard de A2A funciona.' : `FALLO ${fallos} en el guard de A2A.`);
  process.exit(fallos === 0 ? 0 : 1);
}

main();
