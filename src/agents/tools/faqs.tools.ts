import { FunctionTool } from "@google/adk";
import { z } from "zod";

const faqs = new FunctionTool({
  name: 'faqs',
  description: 'Consulta las preguntas frecuentes (FAQs) de la plataforma Apprecio.',
  parameters: z.object({
    query: z.string(),
    pais: z.string().describe('Código del país (ej. es_cl, es_pe). Por defecto es_cl.').optional()
  }) as any,
  execute: async (args: any) => {
    const { query, pais = 'es_cl' } = args;
    try {
      const { faqService } = await import('../../features/faq/service.js');
      const faqsList = await faqService.search(query, pais);

      if (!faqsList || faqsList.length === 0) {
        return { status: 'success', result: `No se encontraron respuestas específicas para "${query}" en las FAQs.` };
      }

      const formattedFaqs = faqsList.map(faq => `Pregunta: ${faq.pregunta}\nRespuesta: ${faq.respuesta}`).join('\n\n');
      return { status: 'success', result: formattedFaqs };
    } catch (error: any) {
      return { status: 'error', message: `Error al consultar las FAQs: ${error.message}` };
    }
  },
});



export { faqs };
