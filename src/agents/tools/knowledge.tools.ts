import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { qdrantService, QdrantKnowledgeService } from '../../services/qdrant.service.js';

/**
 * Herramienta para consultar la base de conocimientos de Arquitectura y Decisiones de Apprecio (Obsidian)
 */
export const knowledgeSearch = new FunctionTool({
  name: 'knowledge_search',
  description: 'Busca en el cerebro digital de Jesús (arquitectura de Apprecio, documentación técnica, notas de Obsidian, decisiones de ingeniería y diseño de sistemas). Retorna los fragmentos más relevantes ordenados por similitud semántica.',
  parameters: z.object({
    query: z.string().describe('Pregunta técnica o término de búsqueda sobre arquitectura, microservicios, bases de datos o decisiones de Apprecio.'),
    limit: z.number().optional().describe('Cantidad máxima de resultados a retornar (por defecto 4).'),
  }) as any,
  execute: async (args: any) => {
    const { query, limit = 4 } = args;
    try {
      const results = await qdrantService.searchKnowledge(
        QdrantKnowledgeService.CORE_COLLECTION,
        query,
        limit
      );

      if (!results || results.length === 0) {
        return {
          status: 'success',
          result: 'No se encontraron notas o documentos relevantes en la base de conocimientos para esa consulta.',
        };
      }

      const formatted = results
        .map((r: any, idx: number) => {
          const tagsStr = r.tags && r.tags.length > 0 ? ` [Tags: ${r.tags.join(', ')}]` : '';
          return `### Resultado #${idx + 1}: ${r.title} > ${r.section} (Archivo: ${r.filePath})${tagsStr}\nSimilitud: ${(r.score * 100).toFixed(1)}%\n\n${r.content}`;
        })
        .join('\n\n---\n\n');

      return {
        status: 'success',
        result: formatted,
        data: results,
      };
    } catch (error: any) {
      return {
        status: 'error',
        message: `Error al consultar la base de conocimientos Qdrant: ${error.message}. Asegúrate de que Qdrant esté corriendo en Docker.`,
      };
    }
  },
});

/**
 * Helper para obtener el badge del origen en memoria episódica
 */
const getEpisodicSourceBadge = (source?: string) => {
  if (source === 'google_chat') return '💬 [GOOGLE CHAT]';
  if (source === 'gmail') return '📧 [CORREO GMAIL]';
  return '🎙️ [REUNIÓN MEET]';
};

/**
 * Herramienta unificada para consultar la memoria episódica (Reuniones de Meet, Chats y Correos)
 */
export const episodicSearch = new FunctionTool({
  name: 'episodic_search',
  description: 'Busca en la memoria episódica unificada de Jesús (acuerdos en reuniones de Google Meet, decisiones y compromisos en Google Chat, y confirmaciones o tareas acordadas por Gmail). Retorna los fragmentos más relevantes ordenados por similitud semántica con indicación de su fuente.',
  parameters: z.object({
    query: z.string().describe('Término de búsqueda, tema tratado, persona participante, acuerdo o decisión a consultar (ej: "bloqueo IPs Cloudflare", "acuerdos con Ignacio", "despliegue España", "credenciales producción").'),
    limit: z.number().optional().describe('Cantidad de resultados a retornar (por defecto 4).'),
  }) as any,
  execute: async (args: any) => {
    const { query, limit = 4 } = args;
    try {
      const results = await qdrantService.searchKnowledge(
        QdrantKnowledgeService.EPISODIC_COLLECTION,
        query,
        limit
      );

      if (!results || results.length === 0) {
        return {
          status: 'success',
          result: 'No se encontraron registros o acuerdos en la memoria episódica para esa consulta.',
        };
      }

      const listaStr = (label: string, arr?: string[]) =>
        arr && arr.length > 0 ? `\n${label}:\n${arr.map((a) => `• ${a}`).join('\n')}\n` : '';

      const formatted = results
        .map((r: any, idx: number) => {
          const badge = getEpisodicSourceBadge(r.source);
          const dateStr = r.date ? `Fecha: ${r.date}\n` : '';
          const partsStr = r.participants && r.participants.length > 0 ? `Participantes: ${r.participants.join(', ')}\n` : '';
          const salaStr = r.spaceDisplayName ? `Sala: ${r.spaceDisplayName}\n` : '';
          const asuntoStr = r.subject ? `Asunto original: ${r.subject}\n` : '';
          const linkStr = r.link ? `Fuente: ${r.link}\n` : '';
          const seccionStr = r.section ? `Sección: ${r.section}\n` : '';

          // 'decisions'/'tasks' vienen de Gmail y Chat; 'agreements' de las minutas de Meet
          const detalles =
            listaStr('Decisiones clave', r.decisions) +
            listaStr('Compromisos y tareas', r.tasks) +
            listaStr('Acuerdos/Compromisos', r.agreements);

          return `### ${badge} #${idx + 1}: ${r.title}\n${dateStr}${partsStr}${salaStr}${asuntoStr}${seccionStr}${linkStr}Similitud: ${(r.score * 100).toFixed(1)}%\n\n${r.content}${detalles}`;
        })
        .join('\n\n---\n\n');

      return {
        status: 'success',
        result: formatted,
        data: results,
      };
    } catch (error: any) {
      return {
        status: 'error',
        message: `Error al consultar la memoria episódica en Qdrant: ${error.message}.`,
      };
    }
  },
});

/**
 * Alias retrocompatible para meeting_search
 */
export const meetingSearch = episodicSearch;

/**
 * Herramienta para consolidar manualmente chats y correos recientes en la memoria episódica
 */
export const consolidateContextTool = new FunctionTool({
  name: 'consolidate_context',
  description: 'Ejecuta la consolidación manual de la memoria episódica a partir de hilos recientes de Google Chat y correos de Gmail. Extrae acuerdos, decisiones técnicas, compromisos y tareas, indexándolos en Qdrant ("episodic_memory").',
  parameters: z.object({
    hours: z.number().optional().describe('Horas hacia atrás a revisar para chats y correos (por defecto 24 horas).')
  }) as any,
  execute: async (args: any) => {
    const { hours = 24 } = args;
    try {
      const { contextConsolidationService } = await import('../../services/context_consolidation.service.js');
      const result = await contextConsolidationService.consolidateAll(hours);
      return {
        status: 'success',
        result: `✅ Consolidación de contexto completada:\n` +
                `- **Hilos de Chat procesados:** ${result.chat.processed} (Nuevas decisiones indexadas: ${result.chat.indexed})\n` +
                `- **Hilos de Gmail procesados:** ${result.gmail.processed} (Nuevas decisiones indexadas: ${result.gmail.indexed})\n` +
                `- **Total de decisiones/acuerdos agregados a la memoria episódica:** ${result.totalIndexed}`,
        data: result
      };
    } catch (error: any) {
      return {
        status: 'error',
        message: `Error al consolidar contexto de chats y correos: ${error.message}`
      };
    }
  }
});

/**
 * Herramienta para procesar e indexar una reunión en la memoria episódica a partir de una URL de Google Drive, ID de archivo o ruta local.
 */
export const meetingIngest = new FunctionTool({
  name: 'meeting_ingest',
  description: 'Procesa y vectoriza una reunión específica (minuta, notas de Gemini o transcripción) para guardarla en la memoria episódica de Qdrant. Admite un enlace de Google Drive / Docs (ej: https://docs.google.com/document/d/...), un ID de archivo de Drive, el nombre de la reunión en Drive, o la ruta de un archivo local en disco.',
  parameters: z.object({
    sourceInput: z.string().describe('URL de Google Drive/Docs, ID de archivo en Drive, nombre de la reunión en Drive, o ruta absoluta/relativa a un archivo local con la minuta o transcripción.'),
    customTitle: z.string().optional().describe('Título personalizado opcional para la reunión si se desea sobreescribir el detectado automáticamente.')
  }) as any,
  execute: async (args: any) => {
    const { sourceInput, customTitle } = args;
    try {
      const { meetingIngestService } = await import('../../services/meeting_ingest.service.js');
      const result = await meetingIngestService.ingestMeeting(sourceInput, customTitle);

      const attendeesStr = result.participants.length > 0 ? result.participants.join(', ') : 'No identificados';
      const agreementsStr = result.agreements.length > 0 
        ? `\n\n**Acuerdos principales:**\n${result.agreements.map(a => `- ${a}`).join('\n')}` 
        : '';

      return {
        status: 'success',
        result: `✅ Reunión indexada con éxito en la memoria episódica ("episodic_memory") de Qdrant:\n\n` +
                `- **Título:** ${result.title}\n` +
                `- **Fecha:** ${result.date}\n` +
                `- **Participantes:** ${attendeesStr}\n` +
                `- **Fragmentos generados:** ${result.chunksCount} chunks\n` +
                `- **Origen:** ${result.source}${result.link ? ` (${result.link})` : ''}\n\n` +
                `**Resumen:**\n${result.summary}${agreementsStr}`,
        data: result
      };
    } catch (error: any) {
      return {
        status: 'error',
        message: `Error al procesar e indexar la reunión: ${error.message}`
      };
    }
  }
});
