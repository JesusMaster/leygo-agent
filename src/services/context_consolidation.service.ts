import crypto from 'crypto';
import dotenv from 'dotenv';
import { googleService } from './google.service.js';
import { qdrantService, QdrantKnowledgeService } from './qdrant.service.js';
import { sqliteReminderService } from '../database/sqlite.service.js';
import { generarTexto } from '../agents/llm/model_factory.js';
import { beginUsageScope, flushUsageScope } from '../utils/usage_collector.js';
import { commitmentsService, parsearTareas, linkGmail, linkChat } from './commitments.service.js';

dotenv.config();

export interface ConsolidatedDecision {
  has_value: boolean;
  title?: string;
  date?: string;
  participants?: string[];
  decisions?: string[];
  tasks?: any[];
  summary?: string;
}

export interface ConsolidationResult {
  source: 'gmail' | 'google_chat';
  threadsProcessed: number;
  decisionsIndexed: number;
  threadsSkipped: number;
  processed: number;
  indexed: number;
  items: Array<{
    threadId: string;
    title: string;
    decisionsCount: number;
    tasksCount: number;
  }>;
}

function generateDeterministicUuid(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    'a' + hash.substring(17, 20),
    hash.substring(20, 32), // 12 chars exactos: con 13 Qdrant rechaza el ID y aborta el lote
  ].join('-');
}

export class ContextConsolidationService {

  constructor() {
  }

  /**
   * Analiza un hilo de conversación y extrae decisiones de valor con Gemini Flash
   */
  private async extractDecisionsFromThread(
    sourceType: 'Gmail' | 'Google Chat',
    contextTitle: string,
    conversationText: string
  ): Promise<ConsolidatedDecision | null> {
    const prompt = `
Eres un asistente ejecutivo experto en minutas y análisis de acuerdos para Jesús Leiva (CTO de Apprecio).

Tu tarea es evaluar la siguiente conversación de ${sourceType} titulada/referenciada como: "${contextTitle}".
Determina si contiene decisiones técnicas, acuerdos de negocio, compromisos, fechas límite o aprobaciones reales.

REGLAS ESTRICTAS DE FILTRADO:
1. Si la conversación es solo charla casual, confirmaciones triviales ("ok", "gracias", "nos vemos mañana", "listo recibido"), dudas no resueltas o notificaciones automáticas:
   DEBES responder ÚNICAMENTE con:
   {"has_value": false}

2. Si SÍ contiene decisiones técnicas, acuerdos, arquitecturas aprobadas, plazos comprometidos o tareas asignadas:
   DEBES responder con un JSON válido con la siguiente estructura:
   {
     "has_value": true,
     "title": "Título conciso y descriptivo del acuerdo o decisión (ej: Postergación deploy core-api-wallet)",
     "date": "YYYY-MM-DD (fecha del acuerdo si se menciona o aproxima)",
     "participants": ["Nombre 1", "Nombre 2"],
     "decisions": [
       "Decisión concreta 1...",
       "Decisión concreta 2..."
     ],
     "tasks": [
       {"owner": "Nombre del responsable (Jesús si es él)", "task": "Compromiso concreto y accionable", "context": "1-2 frases: de qué se trata y por qué surgió (el problema, el proyecto, qué se espera)", "counterpart": "Con quién o para quién (o null)", "due": "YYYY-MM-DD si se comprometió una fecha, si no null", "priority": "alta|media|baja"}
     ],
     "summary": "Resumen ejecutivo de 2 a 4 oraciones sobre el contexto y la conclusión alcanzada."
   }

CONVERSACIÓN A ANALIZAR:
"""
${conversationText.substring(0, 15000)}
"""

Responde ÚNICAMENTE con el objeto JSON, sin formato markdown ni código alrededor.
`;

    try {
      beginUsageScope('system', 'context_consolidation', `Consolidación de contexto: ${contextTitle}`);
      let textoIA = '';
      try {
        textoIA = await generarTexto('context_consolidation', 'gemini-3.5-flash', prompt);
      } finally {
        flushUsageScope().catch(() => {});
      }

      let raw = textoIA || '{}';
      // Limpiar backticks si los devuelve
      raw = raw.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

      const parsed: ConsolidatedDecision = JSON.parse(raw);
      return parsed;
    } catch (err: any) {
      console.warn(`⚠️ [ContextConsolidation] Error extrayendo decisiones de "${contextTitle}":`, err.message);
      return null;
    }
  }

  /**
   * Consolida hilos recientes de Gmail en Qdrant
   */
  public async consolidateGmail(sinceHours: number = 48, maxThreads: number = 10): Promise<ConsolidationResult> {
    const result: ConsolidationResult = {
      source: 'gmail',
      threadsProcessed: 0,
      decisionsIndexed: 0,
      threadsSkipped: 0,
      processed: 0,
      indexed: 0,
      items: [],
    };

    try {
      console.log(`📬 [ContextConsolidation] Buscando hilos recientes de Gmail (últimas ${sinceHours}h)...`);
      const threadSummaries = await googleService.searchRecentGmailThreads('', maxThreads, sinceHours);

      for (const tSummary of threadSummaries) {
       try {
        // Verificar idempotencia en SQLite
        if (sqliteReminderService.isThreadConsolidated(tSummary.id)) {
          result.threadsSkipped++;
          continue;
        }

        result.threadsProcessed++;
        result.processed = result.threadsProcessed;
        const threadDetail = await googleService.getGmailThread(tSummary.id);

        if (!threadDetail.messages || threadDetail.messages.length === 0) {
          sqliteReminderService.markThreadConsolidated(tSummary.id, 'gmail', '(Vacío)', 0);
          continue;
        }

        // Armar el texto cronológico de la conversación
        const conversationText = threadDetail.messages.map((m) => {
          return `De: ${m.from}\nFecha: ${m.date}\nMensaje:\n${m.bodyText}\n---`;
        }).join('\n\n');

        const analysis = await this.extractDecisionsFromThread('Gmail', threadDetail.subject, conversationText);

        if (!analysis || !analysis.has_value || !analysis.decisions || analysis.decisions.length === 0) {
          // Descartado por no contener acuerdos de valor
          sqliteReminderService.markThreadConsolidated(tSummary.id, 'gmail', threadDetail.subject, threadDetail.messageCount);
          continue;
        }

        // Indexar en Qdrant (episodic_memory)
        const dateStr = analysis.date || new Date().toISOString().substring(0, 10);
        const titleStr = analysis.title || threadDetail.subject;
        const participants = analysis.participants || [];

        const tareas = parsearTareas(analysis.tasks);
        const structuredContent = `
Título: ${titleStr}
Fecha: ${dateStr}
Tipo: Correo Electrónico (Gmail)
Asunto Original: ${threadDetail.subject}
Participantes: ${participants.join(', ') || 'Equipo'}

Resumen Ejecutivo:
${analysis.summary || 'Sin resumen'}

Decisiones Clave:
${(analysis.decisions || []).map((d) => `• ${d}`).join('\n')}

${tareas.strings.length > 0 ? `Compromisos y Tareas:\n${tareas.strings.map((t) => `• ${t}`).join('\n')}` : ''}
`.trim();

        const pointId = generateDeterministicUuid(`gmail_${tSummary.id}`);

        await qdrantService.upsertKnowledge(
          QdrantKnowledgeService.EPISODIC_COLLECTION,
          pointId,
          {
            title: titleStr,
            date: dateStr,
            participants,
            summary: analysis.summary,
            decisions: analysis.decisions,
            tasks: tareas.strings,
            source: 'gmail',
            threadId: tSummary.id,
            subject: threadDetail.subject,
            content: structuredContent,
            section: 'Acuerdos de Correo',
          }
        );

        sqliteReminderService.markThreadConsolidated(tSummary.id, 'gmail', titleStr, threadDetail.messageCount);
        await commitmentsService.ingestarDetectados(tareas.detectados, { type: 'gmail', ref: tSummary.id, title: titleStr, link: linkGmail(tSummary.id) }).catch(() => {});

        result.decisionsIndexed++;
        result.indexed = result.decisionsIndexed;
        result.items.push({
          threadId: tSummary.id,
          title: titleStr,
          decisionsCount: analysis.decisions.length,
          tasksCount: analysis.tasks?.length || 0,
        });

        console.log(`✅ [ContextConsolidation] Gmail indexado: "${titleStr}" (${analysis.decisions.length} decisiones)`);
       } catch (threadErr: any) {
        // Un hilo que falla no puede tumbar el lote entero
        console.warn(`⚠️ [ContextConsolidation] Error en hilo de Gmail ${tSummary.id}: ${threadErr.message}`);
       }
      }
    } catch (err: any) {
      console.error('❌ [ContextConsolidation] Error consolidando Gmail:', err.message);
    }

    return result;
  }

  /**
   * Consolida hilos y discusiones recientes de Google Chat en Qdrant
   */
  public async consolidateGoogleChat(sinceHours: number = 24): Promise<ConsolidationResult> {
    const result: ConsolidationResult = {
      source: 'google_chat',
      threadsProcessed: 0,
      decisionsIndexed: 0,
      threadsSkipped: 0,
      processed: 0,
      indexed: 0,
      items: [],
    };

    try {
      console.log(`💬 [ContextConsolidation] Buscando discusiones recientes en Google Chat (últimas ${sinceHours}h)...`);
      const chatThreads = await googleService.getRecentChatThreads(sinceHours);

      for (const cThread of chatThreads) {
       try {
        // Idempotencia: threadName único
        if (sqliteReminderService.isThreadConsolidated(cThread.threadName)) {
          result.threadsSkipped++;
          continue;
        }

        // Si tiene menos de 2 mensajes probablemente no hay discusión sustancial
        if (cThread.messages.length < 2) {
          sqliteReminderService.markThreadConsolidated(cThread.threadName, 'google_chat', '(Mensaje suelto)', cThread.messages.length);
          continue;
        }

        result.threadsProcessed++;
        result.processed = result.threadsProcessed;
        const conversationText = cThread.messages.map((m) => {
          return `[${m.createTime}] ${m.sender}: ${m.text}`;
        }).join('\n');

        const analysis = await this.extractDecisionsFromThread(
          'Google Chat',
          `Sala: ${cThread.spaceDisplayName}`,
          conversationText
        );

        if (!analysis || !analysis.has_value || !analysis.decisions || analysis.decisions.length === 0) {
          sqliteReminderService.markThreadConsolidated(cThread.threadName, 'google_chat', `Sala: ${cThread.spaceDisplayName}`, cThread.messages.length);
          continue;
        }

        const dateStr = analysis.date || new Date().toISOString().substring(0, 10);
        const titleStr = analysis.title || `Discusión en ${cThread.spaceDisplayName}`;
        const participants = analysis.participants || [];

        const tareas = parsearTareas(analysis.tasks);
        const structuredContent = `
Título: ${titleStr}
Fecha: ${dateStr}
Tipo: Google Chat (Mensajería)
Espacio / Sala: ${cThread.spaceDisplayName}
Participantes: ${participants.join(', ') || 'Equipo'}

Resumen Ejecutivo:
${analysis.summary || 'Sin resumen'}

Decisiones Clave:
${(analysis.decisions || []).map((d) => `• ${d}`).join('\n')}

${tareas.strings.length > 0 ? `Compromisos y Tareas:\n${tareas.strings.map((t) => `• ${t}`).join('\n')}` : ''}
`.trim();

        const pointId = generateDeterministicUuid(`chat_${cThread.threadName}`);

        await qdrantService.upsertKnowledge(
          QdrantKnowledgeService.EPISODIC_COLLECTION,
          pointId,
          {
            title: titleStr,
            date: dateStr,
            participants,
            summary: analysis.summary,
            decisions: analysis.decisions,
            tasks: tareas.strings,
            source: 'google_chat',
            threadId: cThread.threadName,
            spaceDisplayName: cThread.spaceDisplayName,
            content: structuredContent,
            section: 'Acuerdos de Google Chat',
          }
        );

        sqliteReminderService.markThreadConsolidated(cThread.threadName, 'google_chat', titleStr, cThread.messages.length);
        await commitmentsService.ingestarDetectados(tareas.detectados, { type: 'google_chat', ref: cThread.threadName, title: titleStr, link: linkChat(cThread.threadName) }).catch(() => {});

        result.decisionsIndexed++;
        result.indexed = result.decisionsIndexed;
        result.items.push({
          threadId: cThread.threadName,
          title: titleStr,
          decisionsCount: analysis.decisions.length,
          tasksCount: analysis.tasks?.length || 0,
        });

        console.log(`✅ [ContextConsolidation] Chat indexado: "${titleStr}" (${analysis.decisions.length} decisiones)`);
       } catch (threadErr: any) {
        console.warn(`⚠️ [ContextConsolidation] Error en hilo de Chat ${cThread.threadName}: ${threadErr.message}`);
       }
      }
    } catch (err: any) {
      console.error('❌ [ContextConsolidation] Error consolidando Google Chat:', err.message);
    }

    return result;
  }

  /**
   * Consolida ambas fuentes (Gmail + Google Chat)
   */
  public async consolidateAll(sinceHours: number = 24): Promise<{
    gmail: ConsolidationResult;
    chat: ConsolidationResult;
    totalIndexed: number;
  }> {
    const gmailRes = await this.consolidateGmail(sinceHours);
    const chatRes = await this.consolidateGoogleChat(sinceHours);

    return {
      gmail: gmailRes,
      chat: chatRes,
      totalIndexed: gmailRes.decisionsIndexed + chatRes.decisionsIndexed,
    };
  }
}

export const contextConsolidationService = new ContextConsolidationService();
