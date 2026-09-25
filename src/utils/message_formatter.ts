/**
 * Utilidad unificada de formateo de mensajes para diferentes canales:
 * - Telegram (HTML estricto compatible con Telegram Bot API)
 * - Google Chat (Markdown simplificado propio de Google Chat)
 * - Email (HTML completo con estilos inline modernos)
 * - Plain Text (Texto plano limpio sin marcas)
 */

export type ChannelType = 'telegram' | 'google_chat' | 'email' | 'plain_text';

export class MessageFormatter {
  /**
   * Detecta automáticamente el canal objetivo a partir de un texto o instrucción
   */
  public detectChannel(hint: string = ''): ChannelType {
    const text = (hint || '').toLowerCase();
    if (text.includes('telegram') || text.includes('tg')) return 'telegram';
    if (text.includes('google chat') || text.includes('gchat') || text.includes('spaces/')) return 'google_chat';
    if (text.includes('correo') || text.includes('email') || text.includes('gmail') || text.includes('mail')) return 'email';
    return 'telegram'; // Por defecto Telegram para este agente
  }

  /**
   * Formatea un texto en markdown según el canal especificado
   */
  public format(markdown: string, channel: ChannelType = 'telegram'): string {
    if (!markdown) return '';
    switch (channel) {
      case 'telegram':
        return this.formatForTelegram(markdown);
      case 'google_chat':
        return this.formatForGoogleChat(markdown);
      case 'email':
        return this.formatForEmail(markdown);
      case 'plain_text':
      default:
        return this.formatForPlainText(markdown);
    }
  }

  /**
   * Escapa caracteres especiales de HTML básico (&, <, >)
   */
  public escapeHtml(text: string): string {
    return (text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Convierte Markdown a HTML 100% válido y compatible con Telegram Bot API:
   * - Soporta tags: <b>, <i>, <code>, <pre>, <s>, <u>, <a>, <blockquote>
   * - Respeta inline code (`...`) y bloques (```...```) sin alterar su contenido
   * - NO confunde guiones bajos dentro de variables (wf_8921) con cursivas
   * - Transforma listas con viñetas (* o -) en bonitos bullets (•) en vez de romper etiquetas
   * - Cierra y valida etiquetas para evitar el error "can't parse entities" de Telegram
   */
  public formatForTelegram(markdown: string): string {
    if (!markdown) return '';

    let text = markdown.replace(/\r\n/g, '\n');

    // 1. Extraer y proteger bloques de código multilinea ```lang ... ```
    const codeBlocks: string[] = [];
    text = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre><code>${this.escapeHtml(code.trim())}</code></pre>`);
      return `___CODE_BLOCK_${idx}___`;
    });

    // 2. Extraer y proteger código inline `...`
    const inlineCodes: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code>${this.escapeHtml(code)}</code>`);
      return `___INLINE_CODE_${idx}___`;
    });

    // 3. Normalizar viñetas de listas al inicio de línea: '* ' o '- ' o '+ ' -> '• '
    // Esto evita que los asteriscos de listas sean confundidos con etiquetas de cursiva o negrita
    text = text.replace(/^(\s*)[*+-]\s+/gm, '$1• ');

    // 4. Normalizar encabezados (# Titulo -> <b>Titulo</b>)
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

    // 5. Normalizar citas (> Cita -> <blockquote>Cita</blockquote>)
    text = text.replace(/^>\s*(.+)$/gm, '<blockquote>$1</blockquote>');

    // 6. Escapar caracteres HTML en el resto del texto antes de inyectar tags
    text = this.escapeHtml(text);

    // 7. Enlaces: [Texto](url) -> <a href="url">Texto</a>
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

    // 8. Negrita: **texto** o __texto__
    // (admite *cursiva* adentro: "**¿Qué pasa con la (*stall speed*)?**"; no cruza párrafos)
    text = text.replace(/\*\*(?=\S)((?:(?!\n\n)[\s\S])+?)(?<=\S)\*\*/g, '<b>$1</b>');
    // Para __ requerimos delimitación de palabra para no tocar variables snake_case
    text = text.replace(/(?<=^|[\s(])__([^_]+)__(?=$|[\s).,;:!?])/g, '<b>$1</b>');

    // 9. Cursiva: *texto* (que no sea viñeta) o _texto_ (delimitado por espacios/puntuación)
    text = text.replace(/(?<=^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, '<i>$1</i>');
    text = text.replace(/(?<=^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, '<i>$1</i>');

    // 10. Tachado: ~~texto~~ -> <s>texto</s>
    text = text.replace(/~~([^~]+)~~/g, '<s>$1</s>');

    // 11. Reinsertar el código protegido intacto
    inlineCodes.forEach((codeHtml, idx) => {
      text = text.replace(`___INLINE_CODE_${idx}___`, codeHtml);
    });
    codeBlocks.forEach((blockHtml, idx) => {
      text = text.replace(`___CODE_BLOCK_${idx}___`, blockHtml);
    });

    // 12. Sanitizar etiquetas no cerradas que podrían hacer fallar a Telegram
    text = this.sanitizeTelegramHtml(text);

    return text.trim();
  }

  /**
   * Formatea Markdown para Google Chat:
   * - Google Chat usa *negrita*, _cursiva_, ~tachado~, `código` y ```bloque```
   */
  public formatForGoogleChat(markdown: string): string {
    if (!markdown) return '';

    let text = markdown.replace(/\r\n/g, '\n');

    // 1. Proteger bloques y códigos
    const codeBlocks: string[] = [];
    text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(`\`\`\`\n${code.trim()}\n\`\`\``);
      return `___GC_BLOCK_${idx}___`;
    });

    const inlineCodes: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`\`${code}\``);
      return `___GC_INLINE_${idx}___`;
    });

    // 2. Viñetas
    text = text.replace(/^(\s*)[*+-]\s+/gm, '$1• ');

    // 3. Encabezados (# -> *MAYÚSCULAS*)
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // 4. Enlaces [Texto](url) -> <url|Texto> (formato Google Chat)
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>');

    // 5. Negrita: transformar **texto** del markdown estándar al *texto* de Google Chat
    text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');

    // 6. Tachado: ~~texto~~ -> ~texto~
    text = text.replace(/~~([^~]+)~~/g, '~$1~');

    // 7. Reinsertar código
    inlineCodes.forEach((code, idx) => {
      text = text.replace(`___GC_INLINE_${idx}___`, code);
    });
    codeBlocks.forEach((block, idx) => {
      text = text.replace(`___GC_BLOCK_${idx}___`, block);
    });

    return text.trim();
  }

  /**
   * Formatea Markdown a HTML moderno y estilizado para Email / Gmail:
   */
  public formatForEmail(markdown: string, title?: string, wrapInCard: boolean = false): string {
    if (!markdown) return '';

    let text = markdown.replace(/\r\n/g, '\n');

    // 1. Proteger bloques de código
    const codeBlocks: string[] = [];
    text = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(
        `<pre style="background:#f8fafc;border:1px solid #e2e8f0;color:#0f172a;padding:12px 16px;border-radius:6px;overflow-x:auto;font-family:Consolas,Monaco,monospace;font-size:13px;line-height:1.5;"><code>${this.escapeHtml(code.trim())}</code></pre>`
      );
      return `___EMAIL_BLOCK_${idx}___`;
    });

    // 2. Proteger código inline
    const inlineCodes: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code style="background:#f1f5f9;color:#0f172a;padding:2px 6px;border-radius:4px;font-family:Consolas,Monaco,monospace;font-size:13px;">${this.escapeHtml(code)}</code>`);
      return `___EMAIL_INLINE_${idx}___`;
    });

    // 3. Formato inline (enlaces, negrita, cursiva, tachado)
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="color:#2563eb;text-decoration:underline;">$1</a>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:600;color:#111827;">$1</strong>');
    text = text.replace(/(?<=^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, '<em>$1</em>');
    text = text.replace(/(?<=^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, '<em>$1</em>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 4. Procesamiento de bloques por párrafos vacíos
    const rawBlocks = text.split(/\n\s*\n/);
    const renderedBlocks: string[] = [];

    for (const block of rawBlocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      if (/^___EMAIL_BLOCK_\d+___$/.test(trimmed)) {
        renderedBlocks.push(trimmed);
        continue;
      }

      if (/^---+$/.test(trimmed)) {
        renderedBlocks.push('<hr style="border:0;border-top:1px solid #e5e7eb;margin:16px 0;" />');
        continue;
      }

      const lines = trimmed.split('\n');
      const formattedLines = lines.map((line) => {
        const l = line.trim();
        if (/^#{1,3}\s+(.+)$/.test(l)) {
          return `<div><b>${l.replace(/^#{1,3}\s+/, '')}</b></div>`;
        }
        if (/^(\d+\.\s+.+:?)$/.test(l)) {
          return `<div><b>${l}</b></div>`;
        }
        if (/^[•*-]\s+(.+)$/.test(l)) {
          return `<div style="margin-left:20px;">• ${l.replace(/^[•*-]\s+/, '')}</div>`;
        }
        return `<div>${line}</div>`;
      });

      renderedBlocks.push(formattedLines.join('\n'));
    }

    // Unir párrafos con <br/> explícito para que Gmail nunca los colapse ni al editar ni al copiar
    let finalHtml = renderedBlocks.join('\n<br/>\n');

    // Reinsertar código protegido
    inlineCodes.forEach((code, idx) => {
      finalHtml = finalHtml.replace(`___EMAIL_INLINE_${idx}___`, code);
    });
    codeBlocks.forEach((block, idx) => {
      finalHtml = finalHtml.replace(`___EMAIL_BLOCK_${idx}___`, block);
    });

    if (wrapInCard || title) {
      const headerHtml = title ? `
        <div style="background:#0f172a;padding:16px 20px;border-radius:8px 8px 0 0;color:#ffffff;font-size:16px;font-weight:bold;">
          ${this.escapeHtml(title)}
        </div>
      ` : '';

      return `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#ffffff;">
          ${headerHtml}
          <div style="padding:20px;color:#334155;font-size:14px;line-height:1.6;">
            ${finalHtml}
          </div>
        </div>
      `.trim();
    }

    return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14.5px;line-height:1.6;color:#1f2937;">
        ${finalHtml}
      </div>
    `.trim();
  }

  /**
   * Limpia cualquier formato para obtener texto plano legible
   */
  public formatForPlainText(markdown: string): string {
    if (!markdown) return '';
    return markdown
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z0-9_-]*/g, '').trim())
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<=^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, '$1')
      .replace(/^#{1,6}\s+(.+)$/gm, '$1')
      .replace(/^(\s*)[*+-]\s+/gm, '$1• ')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .trim();
  }

  /**
   * Validador simple de balanceo de tags para Telegram
   */
  private sanitizeTelegramHtml(html: string): string {
    const supportedTags = ['b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'a', 'blockquote'];
    // Verificar si hay tags huérfanos comunes
    for (const tag of supportedTags) {
      const openMatches = html.match(new RegExp(`<${tag}(\\s+[^>]*)?>`, 'gi')) || [];
      const closeMatches = html.match(new RegExp(`</${tag}>`, 'gi')) || [];
      if (openMatches.length > closeMatches.length) {
        const diff = openMatches.length - closeMatches.length;
        html += `</${tag}>`.repeat(diff);
      }
    }
    return html;
  }
}

export const messageFormatter = new MessageFormatter();
