import dotenv from 'dotenv';
import crypto from 'crypto';
import { googleService } from '../src/services/google.service.js';
import { qdrantService, QdrantKnowledgeService, KnowledgePayload } from '../src/services/qdrant.service.js';

dotenv.config();

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

interface ParsedMeeting {
  title: string;
  date: string;
  attendees: string[];
  summary: string;
  agreements: string;
  details: string;
  rawText: string;
}

function parseMeetingDoc(fileName: string, content: string): ParsedMeeting {
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  let date = '';
  let title = fileName.replace(/\s*-\s*Notas de Gemini/i, '').replace(/application\/vnd\.google-apps\.document/i, '').trim();
  let attendees: string[] = [];
  let summary = '';
  let agreements = '';
  let details = '';

  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i];
    if (line.includes('📝 Las notas')) continue;
    if (/^\d{1,2}\s+[a-z]{3}\s+\d{4}/i.test(line) && !date) {
      date = line;
      continue;
    }
    if (line.startsWith('Invitados')) {
      const attendeesRaw = line.replace('Invitados', '').trim();
      attendees = attendeesRaw.split(/\s{2,}|\t/).filter((a) => a.trim().length > 0);
      if (attendees.length <= 1 && attendeesRaw.length > 0) {
        attendees = [attendeesRaw];
      }
      continue;
    }
    if (!title && !line.startsWith('Archivos') && !line.startsWith('Registros') && line.length > 3) {
      title = line;
    }
  }

  // Extraer bloque de Resumen y Acuerdos
  const resumenIdx = content.indexOf('Resumen');
  const detallesIdx = content.indexOf('Detalles');
  const transcripcionIdx = content.indexOf('Transcripción');

  if (resumenIdx !== -1) {
    const endSummary = detallesIdx !== -1 ? detallesIdx : (transcripcionIdx !== -1 ? transcripcionIdx : content.length);
    summary = content.substring(resumenIdx, endSummary).trim();
  }

  if (detallesIdx !== -1) {
    const endDetails = transcripcionIdx !== -1 ? transcripcionIdx : content.length;
    details = content.substring(detallesIdx, endDetails).trim();
  }

  return {
    title,
    date,
    attendees,
    summary: summary || content.substring(0, 1500),
    agreements,
    details: details || '',
    rawText: content,
  };
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

async function main() {
  console.log(`\n🎙️ Sincronizando Reuniones de Google Meet a Qdrant ("${QdrantKnowledgeService.EPISODIC_COLLECTION}")`);

  // Asegurar colecciones en Qdrant
  await qdrantService.ensureCollections();

  // Buscar archivos de Google Docs creados por Notas de Gemini
  console.log('🔍 Buscando notas y transcripciones de Google Meet en Google Drive...');
  const files = await googleService.searchDriveFiles('Notas de Gemini', 100);

  if (!files || files.length === 0) {
    console.log('No se encontraron documentos con "Notas de Gemini" en Google Drive.');
    return;
  }

  console.log(`📄 Documentos de reunión encontrados: ${files.length}\n`);

  let processedCount = 0;
  let totalChunks = 0;

  for (const f of files) {
    try {
      // Leer contenido exportado a texto plano
      const fileData = await googleService.readDriveFileContent(f.id as any, f.mimeType as any);
      const text = fileData.content;

      if (!text || text.length < 50) {
        continue;
      }

      const parsed = parseMeetingDoc(f.name as any, text);
      const meetingDate = parsed.date || (f.modifiedTime ? f.modifiedTime.split('T')[0] : '');

      // 1. Chunk Principal: Resumen Ejecutivo y Ficha de Reunión
      const headerText = `Reunión: ${parsed.title}\nFecha: ${meetingDate}\nParticipantes: ${parsed.attendees.join(', ') || 'N/A'}\n\n${parsed.summary}`;
      const headerPointId = generateDeterministicUuid(`meet_${f.id}_summary`);

      const summaryPayload: KnowledgePayload = {
        source: 'google_meet',
        title: parsed.title,
        fileId: f.id,
        date: meetingDate,
        participants: parsed.attendees,
        section: 'Resumen Ejecutivo y Acuerdos',
        content: headerText,
        link: f.link,
      };

      await qdrantService.upsertKnowledge(
        QdrantKnowledgeService.EPISODIC_COLLECTION,
        headerPointId,
        summaryPayload
      );
      totalChunks++;

      // 2. Chunks de Detalles / Transcripción (divididos si son extensos)
      const detailSource = parsed.details || text;
      const detailChunks = splitIntoChunks(detailSource, 3500);

      for (let i = 0; i < detailChunks.length; i++) {
        const chunkText = `Reunión: ${parsed.title} (Detalle/Transcripción - Parte ${i + 1})\nFecha: ${meetingDate}\n\n${detailChunks[i]}`;
        const detailPointId = generateDeterministicUuid(`meet_${f.id}_detail_${i}`);

        const detailPayload: KnowledgePayload = {
          source: 'google_meet',
          title: parsed.title,
          fileId: f.id,
          date: meetingDate,
          participants: parsed.attendees,
          section: `Detalles y Transcripción (Parte ${i + 1})`,
          content: chunkText,
          link: f.link,
        };

        await qdrantService.upsertKnowledge(
          QdrantKnowledgeService.EPISODIC_COLLECTION,
          detailPointId,
          detailPayload
        );
        totalChunks++;
      }

      processedCount++;
      process.stdout.write(`\r[${processedCount}/${files.length}] Sincronizada: ${parsed.title.substring(0, 45).padEnd(45)}`);
    } catch (err: any) {
      console.warn(`\n⚠️ Error procesando documento ${f.name} (${f.id}):`, err.message);
    }
  }

  console.log(`\n\n✅ ¡Sincronización de reuniones completada con éxito!`);
  console.log(`📊 Reuniones procesadas: ${processedCount}`);
  console.log(`🧩 Chunks indexados en Qdrant ("${QdrantKnowledgeService.EPISODIC_COLLECTION}"): ${totalChunks}\n`);
}

main().catch((err) => {
  console.error('\n❌ Error durante la sincronización de reuniones:', err);
  process.exit(1);
});
