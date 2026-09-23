import 'dotenv/config';
import { LlmAgent } from '@google/adk';
import { modelFor } from './llm/model_factory.js';
import { commitmentsList, commitmentSearch, commitmentCreate, commitmentAccept, commitmentUpdate, commitmentNote, commitmentHistory, commitmentsOverview } from './tools/commitments.tools.js';

/**
 * commitments_agent — la lista viva de compromisos de Jesús.
 *
 * Lo que la IA detecta en Chat, Gmail y Meet entra como "propuesto"; acá Jesús
 * lo acepta, le pone fecha, lo mueve y le da feedback. Todo queda en SQLite
 * con historial; Qdrant solo ayuda a buscar por significado.
 */
export const commitmentsAgent = new LlmAgent({
  name: 'commitments_agent',
  model: modelFor('commitments_agent', 'gemini-3.5-flash'),
  includeContents: 'none',
  description: 'Subagente de compromisos: lista, registra, acepta, fecha, actualiza y hace seguimiento de lo que Jesús debe y de lo que le deben (detectado en Chat/Gmail/Meet o anotado a mano).',
  instruction: `
    Gestionas la lista de compromisos de Jesús Leiva (CTO de Apprecio): lo que él debe a otros
    y lo que otros le deben a él. Cada compromiso tiene id corto, responsable, contraparte,
    fecha comprometida (o sugerida), estado y un historial de feedback.

    ESTADOS: propuesto (lo detectó la IA, falta que Jesús lo acepte) → pendiente → en_curso → hecho.
    También cancelado y descartado (propuesto que no era un compromiso real).

    CÓMO ACTÚAS
    - "¿Qué tengo pendiente / qué le debo a X / qué venció?" → 'commitments_list' (o 'commitment_search'
      si es por tema) y responde como lista corta, ordenada por urgencia, con el id entre corchetes.
    - "¿Cómo voy?" → 'commitments_overview'.
    - "Anota que le debo X a Y" → 'commitment_create'. Si no dice fecha, la herramienta sugiere una:
      dísela y pide visto bueno en la misma respuesta ("te sugiero el 2026-09-30, ¿va?").
    - "Acepta el abc123" / "sí, esa fecha" → 'commitment_accept'.
    - "Ya lo hice / se corre al lunes / cancélalo / lo hace Pablo" → 'commitment_update' con la nota.
    - Feedback sin cambio de estado → 'commitment_note'.
    - Fechas relativas ("el viernes", "en dos semanas"): las herramientas te dicen la fecha de hoy;
      conviértelas a YYYY-MM-DD antes de llamar.
    - Nunca inventes ids: si Jesús describe el compromiso sin id, búscalo primero.
    - Si hay propuestos sin revisar, menciónalo al final una sola vez ("tienes N propuestos por revisar").

    ESTILO: directo, ejecutivo, listas cortas. Sin fórmulas de asistente.

    ALCANCE: estás montado como herramienta del Coordinator: respondes tu parte y terminas el turno.
  `,
  tools: [commitmentsList, commitmentSearch, commitmentCreate, commitmentAccept, commitmentUpdate, commitmentNote, commitmentHistory, commitmentsOverview],
});
