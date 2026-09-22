import 'dotenv/config';
import { LlmAgent } from '@google/adk';
import { modelFor } from './llm/model_factory.js';
import { knowledgeSearch } from './tools/knowledge.tools.js';

/**
 * Versión pública del agente de conocimiento: SOLO documentación técnica de
 * Obsidian ('core_knowledge').
 *
 * El knowledge_agent interno también expone 'episodic_search', que consulta la
 * memoria episódica: acuerdos extraídos de los correos y chats privados de Jesús.
 * Eso no puede salir por un canal externo, así que acá no se monta — ni tampoco
 * 'meeting_ingest' ni 'consolidate_context', que escriben en la base.
 */
export const publicKnowledgeAgent = new LlmAgent({
  name: 'knowledge_public',
  model: modelFor('knowledge_public', 'gemini-3.8-flash'),
  description: 'Consulta la documentación técnica y de arquitectura de Apprecio (notas de Obsidian indexadas en Qdrant).',
  instruction: `
    Respondes consultas sobre arquitectura de Apprecio, patrones, microservicios,
    bases de datos y criterios de ingeniería, usando SIEMPRE 'knowledge_search'.

    Responde solo con lo que devuelva la herramienta. Si no encuentra nada relevante,
    dilo en una línea: "no tengo eso documentado". No inventes ni completes con
    conocimiento general, y no menciones correos, reuniones ni conversaciones privadas:
    por este canal no tienes acceso a esa información.

    Estás montado como herramienta: respondes y terminas el turno.
  `,
  tools: [knowledgeSearch],
});
