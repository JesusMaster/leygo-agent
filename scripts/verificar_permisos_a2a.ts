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
import { construirSkills } from '../src/a2a/card.js';
import { allToolNames } from '../src/agents/tool_catalog.js';

const CONCEDIDAS = ['knowledge_agent', 'faq_agent', 'knowledge_public'];
const A_PROBAR = ['get_token_usage', 'account_agent', 'knowledge_public'];

/**
 * La GUI concede permisos por nombre de herramienta y a2a_guard verifica por ese
 * mismo nombre. Si el id de la skill en la card no coincide, el cliente ve una
 * cosa en /.well-known/agent-card.json y hay que habilitarle otra.
 */
function verificarCard(): number {
  const catalogo = allToolNames();
  const disponibles = getToolsDisponiblesA2A();
  const skills = construirSkills();
  const ids = skills.map((s: any) => s.id);
  let fallos = 0;

  const sinSkill = disponibles.filter((t) => !ids.includes(t));
  const sobrantes = ids.filter((id) => !disponibles.includes(id));
  const fueraDelCatalogo = disponibles.filter((t) => !catalogo.includes(t));

  console.log(`Catalogo: ${catalogo.length} | disponibles en A2A: ${disponibles.length} | skills en la card: ${skills.length}`);

  if (sinSkill.length) { console.log('  x disponibles sin skill en la card:', sinSkill.join(', ')); fallos++; }
  if (sobrantes.length) { console.log('  x skills con id que no es una herramienta:', sobrantes.join(', ')); fallos++; }
  if (fueraDelCatalogo.length) { console.log('  x disponibles que no estan en el catalogo:', fueraDelCatalogo.join(', ')); fallos++; }
  if (!fallos) console.log('  ok cada herramienta disponible tiene una skill con su mismo nombre');

  return fallos;
}

async function main() {
  let fallosCard = verificarCard();
  console.log('');
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

  const total = fallos + fallosCard;
  console.log('');
  console.log(total === 0 ? 'OK card y permisos alineados.' : `FALLO ${total} problema(s).`);
  process.exit(total === 0 ? 0 : 1);
}

main();
