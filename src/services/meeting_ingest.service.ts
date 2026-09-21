import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { googleService } from './google.service.js';
import { qdrantService, QdrantKnowledgeService, KnowledgePayload } from './qdrant.service.js';
import { sqliteReminderService } from '../database/sqlite.service.js';

dotenv.config();

export interface IngestMeetingResult {
  status: 'success' | 'error';
  title: string;
  date: string;
  participants: string[];
  summary: string;
  agreements: string[];
  chunksCount: number;
  source: string;
  link?: string;
  message?: string;
}

function generateDeterministicUuid(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    'a' + hash.substring(17, 20),
    hash.substring(20, 32),
  ].join('-');
}

function splitIntoChunks(text: string, maxChars: number = 3500): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChars;
    if (end < text.length) {
      const lastNl = text.lastIndexOf('\n', end);
      if (lastNl > start + 1000) end = lastNl;
    }
    const chunk = text.substring(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

export class MeetingIngestService {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  }

  /**
   * Extrae el ID de Google Drive si el input es una URL
   */
  private extractDriveFileId(input: string): string | null {
    const trimmed = input.trim();
    // Formatos típicos de Google Drive / Docs:
    // https://docs.google.com/document/d/1SINqglClO7vWsy7fqlMxjDGG9CV8FW6yT-vr29PV4Uw/edit
    // https://drive.google.com/file/d/1SINqglClO7vWsy7fqlMxjDGG9CV8FW6yT-vr29PV4Uw/view
    const docMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (docMatch) {
      return docMatch[1];
    }
    const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idParamMatch) {
      return idParamMatch[1];
    }
    // Si parece ser un ID puro de Google Drive (25+ caracteres alfanuméricos con _ o -)
    if (/^[a-zA-Z0-9_-]{25,}$/.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  /**
   * Procesa y sintetiza el contenido de la reunión con Gemini Flash si no viene estructurado
   */
  private async analyzeAndStructureMeeting(fileName: string, content: string): Promise<{
    title: string;
    date: string;
    participants: string[];
    summary: string;
    agreements: string[];
    details: string;
  }> {
    // Si viene con formato estándar de Google Meet ("Notas de Gemini") y tiene campos explícitos
    let detectedDate = '';
    let detectedAttendees: string[] = [];
    let detectedTitle = fileName.replace(/\s*-\s*Notas de Gemini/i, '').replace(/application\/vnd\.google-apps\.document/i, '').trim();

    if (content.includes('📝 Las notas') || content.includes('Registros de la reunión')) {
      const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      for (let i = 0; i < Math.min(lines.length, 15); i++) {
        const line = lines[i];
        if (/^\d{1,2}\s+[a-z]{3}\s+\d{4}/i.test(line) && !detectedDate) {
          detectedDate = line;
        }
        if (line.startsWith('Invitados') || line.startsWith('Asistentes')) {
          const rawAttendees = line.replace(/^(Invitados|Asistentes):?/i, '').trim();
          const splitAttendees = rawAttendees.split(/[\t,;]|\s{2,}/).map(a => a.trim()).filter(a => a.length > 0);
          if (splitAttendees.length > 0) {
            detectedAttendees = splitAttendees;
          }
        }
      }
    }

    // Si es una transcripción libre o nota sin formato, Gemini Flash extrae la metadata
    const prompt = `Analiza la siguiente minuta o transcripción de reunión y extrae un JSON con la siguiente estructura exacta:
{
  "title": "Título conciso y descriptivo de la reunión",
  "date": "Fecha de la reunión en formato YYYY-MM-DD o texto aproximado si se menciona",
  "participants": ["Nombre de persona 1", "Nombre de persona 2"],
  "summary": "Resumen ejecutivo de los temas tratados (2 a 4 oraciones)",
  "agreements": ["Acuerdo o decisión 1", "Acuerdo o compromiso 2"]
}

Nombre de archivo o referencia: ${fileName}

Contenido de la reunión:
${content.substring(0, 25000)}`;

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      return {
        title: detectedTitle || parsed.title || fileName,
        date: detectedDate || parsed.date || new Date().toISOString().split('T')[0],
        participants: detectedAttendees.length > 0 ? detectedAttendees : (parsed.participants || []),
        summary: parsed.summary || content.substring(0, 1000),
        agreements: parsed.agreements || [],
        details: content,
      };
    } catch {
      return {
        title: detectedTitle || fileName,
        date: detectedDate || new Date().toISOString().split('T')[0],
        participants: detectedAttendees,
        summary: content.substring(0, 1000),
        agreements: [],
        details: content,
      };
    }
  }

  /**
   * Ingesta y vectoriza una reunión a partir de un enlace de Google Drive, ID de archivo, nombre o ruta local
   */
  async ingestMeeting(input: string, customTitle?: string): Promise<IngestMeetingResult> {
    await qdrantService.ensureCollections();

    let textContent = '';
    let fileName = customTitle || '';
    let link: string | undefined = undefined;
    let sourceId = '';
    let sourceType = 'google_drive';

    // 1. ¿Es un archivo local existente en el disco?
    const resolvedPath = path.resolve(input.trim());
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      sourceType = 'local_file';
      sourceId = path.basename(resolvedPath);
      fileName = fileName || path.basename(resolvedPath, path.extname(resolvedPath));
      textContent = fs.readFileSync(resolvedPath, 'utf-8');
    } else {
      // 2. ¿Es un ID o URL de Google Drive?
      let driveFileId = this.extractDriveFileId(input);

      // 3. Si no es URL ni ID directo, buscar en Drive por nombre
      if (!driveFileId) {
        const searchResults = await googleService.searchDriveFiles(input, 3);
        if (searchResults && searchResults.length > 0) {
          const match = searchResults[0];
          driveFileId = match.id || null;
          fileName = fileName || match.name || '';
          link = match.link || undefined;
        } else {
          throw new Error(`No se pudo encontrar ningún archivo o reunión que coincida con "${input}" (ni en Drive ni en la ruta local).`);
        }
      }

      if (!driveFileId) {
        throw new Error(`No se pudo determinar el ID del archivo en Google Drive para "${input}".`);
      }

      sourceId = driveFileId;
      link = link || `https://docs.google.com/document/d/${driveFileId}/edit`;

      const driveFile = await googleService.readDriveFileContent(driveFileId, 'application/vnd.google-apps.document');
      textContent = driveFile.content;
      fileName = fileName || `Reunión_${driveFileId}`;
    }

    if (!textContent || textContent.trim().length < 20) {
      throw new Error(`El archivo o documento "${input}" no contiene suficiente texto para ser indexado.`);
    }

    // 4. Analizar y estructurar la reunión
    const structured = await this.analyzeAndStructureMeeting(fileName, textContent);
    const finalTitle = customTitle || structured.title;
    const meetingDate = structured.date;
    const attendees = structured.participants;

    let totalChunks = 0;

    // 5. Chunk 1: Resumen Ejecutivo y Acuerdos Clave
    const agreementsBlock = structured.agreements.length > 0
      ? `\n\nAcuerdos y Decisiones Clave:\n${structured.agreements.map((a) => `- ${a}`).join('\n')}`
      : '';
    const headerText = `Reunión: ${finalTitle}\nFecha: ${meetingDate}\nParticipantes: ${attendees.join(', ') || 'N/A'}\n\n${structured.summary}${agreementsBlock}`;
    const headerPointId = generateDeterministicUuid(`meet_${sourceId}_summary`);

    const summaryPayload: KnowledgePayload = {
      source: 'google_meet',
      title: finalTitle,
      fileId: sourceId,
      date: meetingDate,
      participants: attendees,
      section: 'Resumen Ejecutivo y Acuerdos',
      content: headerText,
      link,
    };

    await qdrantService.upsertKnowledge(
      QdrantKnowledgeService.EPISODIC_COLLECTION,
      headerPointId,
      summaryPayload
    );
    totalChunks++;

    // 6. Chunks de Detalle / Transcripción
    const detailChunks = splitIntoChunks(structured.details, 3500);
    for (let i = 0; i < detailChunks.length; i++) {
      const chunkText = `Reunión: ${finalTitle} (Detalle/Transcripción - Parte ${i + 1})\nFecha: ${meetingDate}\n\n${detailChunks[i]}`;
      const detailPointId = generateDeterministicUuid(`meet_${sourceId}_detail_${i}`);

      const detailPayload: KnowledgePayload = {
        source: 'google_meet',
        title: finalTitle,
        fileId: sourceId,
        date: meetingDate,
        participants: attendees,
        section: `Detalles y Transcripción (Parte ${i + 1})`,
        content: chunkText,
        link,
      };

      await qdrantService.upsertKnowledge(
        QdrantKnowledgeService.EPISODIC_COLLECTION,
        detailPointId,
        detailPayload
      );
      totalChunks++;
    }

    return {
      status: 'success',
      title: finalTitle,
      date: meetingDate,
      participants: attendees,
      summary: structured.summary,
      agreements: structured.agreements,
      chunksCount: totalChunks,
      source: sourceType,
      link,
    };
  }

  /**
   * Sincroniza en batch las minutas y transcripciones de Google Meet desde Drive.
   *
   * - La query cubre los nombres en español E inglés: si el Meet estuvo en inglés,
   *   el documento se llama "Notes by Gemini" y antes quedaba invisible.
   * - Checkpoint incremental por fileId + modifiedTime en SQLite: sin esto se
   *   reprocesaban y re-embebían los mismos archivos cada noche.
   */
  public async syncMeetRecordings(maxFiles: number = 20, force: boolean = false): Promise<IngestMeetingResult[]> {
    await qdrantService.ensureCollections();

    const patrones = [
      'Notas de Gemini',
      'Notes by Gemini',
      'Notas de la reunión',
      'Meeting notes',
      'Transcripción',
      'Transcript',
    ];
    const rawQuery = patrones
      .map((p) => `name contains '${p.replace(/'/g, "\\'")}'`)
      .join(' or ');

    const files = await googleService.searchDriveFiles('', maxFiles, rawQuery);
    if (!files || files.length === 0) {
      return [];
    }

    const results: IngestMeetingResult[] = [];
    let omitidos = 0;

    for (const f of files) {
      if (!f.id) continue;

      // Ya indexado y sin cambios desde la última vez
      if (!force && sqliteReminderService.isSynced('google_meet', f.id, f.modifiedTime || undefined)) {
        omitidos++;
        continue;
      }

      try {
        const res = await this.ingestMeeting(f.id);
        if (res.status === 'success') {
          sqliteReminderService.markSynced('google_meet', f.id, f.modifiedTime || undefined);
          results.push(res);
        }
      } catch (err: any) {
        console.warn(`[syncMeetRecordings] Error procesando archivo ${f.name} (${f.id}):`, err.message);
      }
    }

    if (omitidos > 0) {
      console.log(`ℹ️ [syncMeetRecordings] ${omitidos} archivo(s) omitido(s) por no tener cambios desde la última sincronización.`);
    }

    return results;
  }
}

export const meetingIngestService = new MeetingIngestService();
