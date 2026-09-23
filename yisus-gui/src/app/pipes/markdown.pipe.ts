import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ApiService } from '../services/api.service';

marked.setOptions({ gfm: true, breaks: true });

/** Markdown → HTML seguro. El agente relata contenido de correos y chats: nunca se confía en él. */
@Pipe({ name: 'markdown', pure: true })
export class MarkdownPipe implements PipeTransform {
  private sanitizer = inject(DomSanitizer);
  private api = inject(ApiService);

  transform(value: string | null | undefined): SafeHtml {
    if (!value) return '';
    // Marcadores [[adjunto:ID]] de imágenes/archivos generados por herramientas → imagen inline o enlace
    const conAdjuntos = value.replace(/\[\[\s*adjunto\s*:\s*([a-f0-9-]{16,72})\s*\]\]/gi, (_m, id) => {
      const url = `${this.api.baseUrl}/api/adjuntos/${String(id).replace(/-/g, '')}`;
      return `\n\n<a href="${url}" target="_blank" rel="noopener noreferrer" class="adjunto"><img src="${url}" alt="adjunto" class="adjunto-img" loading="lazy"></a>\n\n`;
    });
    const html = marked.parse(conAdjuntos, { async: false }) as string;
    const limpio = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'img', 'span'],
      ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt', 'class'],
    });
    // Los enlaces abren aparte
    const conTarget = limpio.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
    return this.sanitizer.bypassSecurityTrustHtml(conTarget);
  }
}
