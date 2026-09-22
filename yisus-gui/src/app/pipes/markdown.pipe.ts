import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/** Markdown → HTML seguro. El agente relata contenido de correos y chats: nunca se confía en él. */
@Pipe({ name: 'markdown', pure: true })
export class MarkdownPipe implements PipeTransform {
  private sanitizer = inject(DomSanitizer);

  transform(value: string | null | undefined): SafeHtml {
    if (!value) return '';
    const html = marked.parse(value, { async: false }) as string;
    const limpio = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'img', 'span'],
      ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt', 'class'],
    });
    // Los enlaces abren aparte
    const conTarget = limpio.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
    return this.sanitizer.bypassSecurityTrustHtml(conTarget);
  }
}
