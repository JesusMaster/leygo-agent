import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import matter from 'gray-matter';
import dotenv from 'dotenv';
import { qdrantService, QdrantKnowledgeService, KnowledgePayload } from '../src/services/qdrant.service.js';

dotenv.config();

// Genera un UUID v4 determinista a partir de una cadena (namespace UUID v5/hash)
function generateDeterministicUuid(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  // Formato UUID: 8-4-4-4-12
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16), // version 4-like
    'a' + hash.substring(17, 20), // variant
    hash.substring(20, 32),
  ].join('-');
}

// Extrae wikilinks: [[Nombre de Nota]] o [[Nombre de Nota|Texto]]
function extractWikilinks(text: string): string[] {
  const matches = text.match(/\[\[(.*?)\]\]/g) || [];
  return matches.map((m) => m.replace(/\[\[|\]\]/g, '').split('|')[0].trim());
}

// Divide el contenido Markdown en chunks lógicos basados en encabezados (# , ## , ### )
interface MarkdownSection {
  title: string;
  section: string;
  content: string;
}

function splitLargeContent(title: string, section: string, content: string, maxChars: number = 3500): MarkdownSection[] {
  if (content.length <= maxChars) {
    return [{ title, section, content }];
  }

  const result: MarkdownSection[] = [];
  let startIndex = 0;
  let part = 1;

  while (startIndex < content.length) {
    let endIndex = startIndex + maxChars;
    if (endIndex < content.length) {
      const lastNewline = content.lastIndexOf('\n', endIndex);
      if (lastNewline > startIndex + 1000) {
        endIndex = lastNewline;
      }
    }

    const chunkText = content.substring(startIndex, endIndex).trim();
    if (chunkText.length > 0) {
      result.push({
        title,
        section: `${section} (Parte ${part})`,
        content: chunkText,
      });
      part++;
    }

    startIndex = endIndex;
  }

  return result;
}

function chunkMarkdown(title: string, rawContent: string): MarkdownSection[] {
  const lines = rawContent.split('\n');
  const rawSections: MarkdownSection[] = [];

  let currentHeading = 'Introducción / General';
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      if (currentLines.join('\n').trim().length > 0) {
        rawSections.push({
          title,
          section: currentHeading,
          content: currentLines.join('\n').trim(),
        });
      }
      currentHeading = headingMatch[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.join('\n').trim().length > 0) {
    rawSections.push({
      title,
      section: currentHeading,
      content: currentLines.join('\n').trim(),
    });
  }

  // Si no había encabezados, usa el documento completo
  if (rawSections.length === 0 && rawContent.trim().length > 0) {
    rawSections.push({
      title,
      section: 'Documento completo',
      content: rawContent.trim(),
    });
  }

  // Desglosar cualquier sección que supere los 3500 caracteres
  const finalSections: MarkdownSection[] = [];
  for (const s of rawSections) {
    finalSections.push(...splitLargeContent(s.title, s.section, s.content, 3500));
  }

  return finalSections;
}

// Recorrido recursivo de archivos .md
function getMarkdownFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    // Ignorar carpetas internas de Obsidian y git
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      files.push(...getMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function main() {
  const vaultPathArg = process.argv[2] || process.env.OBSIDIAN_VAULT_PATH;

  if (!vaultPathArg) {
    console.error('❌ Error: Debes especificar la ruta de tu vault de Obsidian.');
    console.log('Uso: npx tsx scripts/sync_obsidian.ts /ruta/a/tu/vault/obsidian');
    console.log('O configura OBSIDIAN_VAULT_PATH en tu archivo .env');
    process.exit(1);
  }

  const resolvedVaultPath = path.resolve(vaultPathArg);
  if (!fs.existsSync(resolvedVaultPath)) {
    console.error(`❌ Error: La ruta no existe: ${resolvedVaultPath}`);
    process.exit(1);
  }

  console.log(`\n🧠 Sincronizando Cerebro Digital desde Obsidian:`);
  console.log(`📁 Directorio: ${resolvedVaultPath}`);

  // 1. Asegurar colecciones en Qdrant
  await qdrantService.ensureCollections();

  // 2. Obtener lista de archivos
  const files = getMarkdownFiles(resolvedVaultPath);
  console.log(`📄 Archivos Markdown encontrados: ${files.length}\n`);

  let totalChunks = 0;
  let processedFiles = 0;

  for (const filePath of files) {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(resolvedVaultPath, filePath);
      const defaultTitle = path.basename(filePath, '.md');

      // Parsear frontmatter
      const { data: frontmatter, content: markdownBody } = matter(fileContent);
      const title = frontmatter.title || defaultTitle;
      const tags = Array.isArray(frontmatter.tags)
        ? frontmatter.tags
        : typeof frontmatter.tags === 'string'
        ? frontmatter.tags.split(',').map((t: string) => t.trim())
        : [];

      const wikilinks = extractWikilinks(fileContent);
      const sections = chunkMarkdown(title, markdownBody);

      for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        if (sec.content.length < 20) continue; // Ignorar secciones vacías o mínimas

        const pointId = generateDeterministicUuid(`${relativePath}#${sec.section}#${i}`);

        const payload: KnowledgePayload = {
          source: 'obsidian',
          title,
          filePath: relativePath,
          section: sec.section,
          tags,
          links: wikilinks,
          content: sec.content,
        };

        await qdrantService.upsertKnowledge(
          QdrantKnowledgeService.CORE_COLLECTION,
          pointId,
          payload
        );

        totalChunks++;
      }

      processedFiles++;
      process.stdout.write(`\r[${processedFiles}/${files.length}] Procesando: ${relativePath.substring(0, 50).padEnd(50)}`);
    } catch (err: any) {
      console.warn(`\n⚠️ Error procesando ${filePath}:`, err.message);
    }
  }

  console.log(`\n\n✅ ¡Sincronización completada con éxito!`);
  console.log(`📊 Archivos procesados: ${processedFiles}`);
  console.log(`🧩 Chunks indexados en Qdrant ("${QdrantKnowledgeService.CORE_COLLECTION}"): ${totalChunks}\n`);
}

main().catch((err) => {
  console.error('\n❌ Error durante la sincronización:', err);
  process.exit(1);
});
