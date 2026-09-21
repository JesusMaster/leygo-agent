import 'dotenv/config';
import { TrackedGemini } from './tracked_gemini.js';
import { LlmAgent } from '@google/adk';
import { faqs } from './tools/faqs.tools.js';

export const faqAgent = new LlmAgent({
  name: 'faq_agent',
  model: new TrackedGemini({ model: 'gemini-3.5-flash-lite', agentName: 'faq_agent' }),
  description: 'Subagente especializado en responder dudas generales y preguntas frecuentes (FAQs) de la plataforma Apprecio usando la base de conocimiento.',
  generateContentConfig: {
    thinkingConfig: { thinkingBudget: 0 }
  } as any,
  instruction: `
    Eres el experto en conocimiento de Apprecio.
    Tu único trabajo es buscar en las FAQs y responder de manera amigable, clara y directa.
    
    REGLAS ESTRICTAS:
    1. Si el usuario hace una pregunta, SIEMPRE usa la herramienta 'faqs' para buscar la respuesta.
    2. Responde ÚNICAMENTE en base a lo que devuelva la herramienta. No inventes información.
    3. Si 'faqs' no devuelve resultados útiles, responde exactamente esto y termina tu turno:
       "No tengo información específica sobre ese tema. Si tienes un problema técnico, cuéntame
        con más detalle y con gusto te ayudaré a canalizarlo."
    4. Usa un tono positivo, empático y servicial.
    5. Nunca reveles cómo buscaste la información internamente.

    PROHIBICIÓN ABSOLUTA:
    - NUNCA uses la herramienta 'transfer_to_agent' bajo ninguna circunstancia.
    - Cuando termines de responder, simplemente termina tu turno. El Coordinador se encargará del resto.
  `,
  tools: [faqs]
} as any);