import { telegramBotService } from './telegram_bot.service.js';
import { sqliteReminderService, DbWebhookLog } from '../database/sqlite.service.js';

export interface WebhookResult {
  status: 'success' | 'ignored' | 'unauthorized' | 'error';
  message: string;
  provider: string;
  eventType?: string;
  title?: string;
}

export class WebhookService {
  private webhookSecret: string;

  constructor() {
    this.webhookSecret = process.env.WEBHOOK_SECRET || '';
  }

  /**
   * Valida el token o secreto si está configurado en .env
   */
  public validateSecret(providedSecret?: string): boolean {
    if (!this.webhookSecret) return true; // Si no hay secreto configurado, permite el paso
    return providedSecret === this.webhookSecret;
  }

  /**
   * Procesa un webhook entrante según su proveedor
   */
  public async handleWebhook(
    provider: string,
    headers: Record<string, any>,
    payload: any
  ): Promise<WebhookResult> {
    const normalizedProvider = provider.toLowerCase().trim();
    const eventId = Math.random().toString(36).substring(2, 10);

    let title = '';
    let summary = '';
    let telegramHtml = '';
    let eventType = 'unknown';

    try {
      switch (normalizedProvider) {
        case 'github': {
          const ghEvent = headers['x-github-event'] || headers['X-GitHub-Event'] || 'ping';
          eventType = ghEvent;
          const parsed = this.parseGitHubEvent(ghEvent, payload);
          if (!parsed) {
            return { status: 'ignored', message: `Evento de GitHub "${ghEvent}" ignorado.`, provider: 'github' };
          }
          title = parsed.title;
          summary = parsed.summary;
          telegramHtml = parsed.telegramHtml;
          break;
        }

        case 'gitlab': {
          const glEvent = headers['x-gitlab-event'] || headers['X-Gitlab-Event'] || 'unknown';
          eventType = glEvent;
          const parsed = this.parseGitLabEvent(glEvent, payload);
          if (!parsed) {
            return { status: 'ignored', message: `Evento de GitLab "${glEvent}" ignorado.`, provider: 'gitlab' };
          }
          title = parsed.title;
          summary = parsed.summary;
          telegramHtml = parsed.telegramHtml;
          break;
        }

        case 'sentry': {
          eventType = 'alert';
          const parsed = this.parseSentryEvent(payload);
          title = parsed.title;
          summary = parsed.summary;
          telegramHtml = parsed.telegramHtml;
          break;
        }

        case 'generic':
        case 'alert':
        default: {
          eventType = payload.event || payload.type || 'alert';
          title = payload.title || `Alerta recibida (${normalizedProvider})`;
          summary = payload.message || payload.description || JSON.stringify(payload);
          const level = (payload.level || 'info').toUpperCase();
          const levelEmoji = level === 'ERROR' ? '🚨' : level === 'WARNING' ? '⚠️' : '🔔';

          telegramHtml = `${levelEmoji} <b>[${level}] ${this.escapeHtml(title)}</b>\n\n` +
            `📌 ${this.escapeHtml(summary)}`;

          if (payload.url) {
            telegramHtml += `\n🔗 <a href="${payload.url}">Ver detalles</a>`;
          }
          break;
        }
      }

      // 1. Guardar en SQLite
      sqliteReminderService.saveWebhookLog(
        eventId,
        normalizedProvider,
        eventType,
        title,
        summary,
        JSON.stringify(payload).substring(0, 5000)
      );

      // 2. Notificar en tiempo real a Telegram
      if (telegramHtml) {
        await telegramBotService.sendDirectMessage(telegramHtml, { parseMode: 'HTML' });
      }

      return {
        status: 'success',
        message: 'Webhook procesado y notificado exitosamente.',
        provider: normalizedProvider,
        eventType,
        title,
      };
    } catch (err: any) {
      console.error(`❌ [WebhookService] Error procesando webhook de ${normalizedProvider}:`, err.message);
      return {
        status: 'error',
        message: err.message,
        provider: normalizedProvider,
      };
    }
  }

  /**
   * Consulta el historial reciente de webhooks recibidos
   */
  public getRecentEvents(limit: number = 10): DbWebhookLog[] {
    return sqliteReminderService.getRecentWebhooks(limit);
  }

  // ─── Parsers Específicos ──────────────────────────────────────────────────

  private parseGitHubEvent(event: string, payload: any): { title: string; summary: string; telegramHtml: string } | null {
    const repo = payload.repository?.full_name || 'repositorio';

    if (event === 'ping') {
      return {
        title: `GitHub Ping en ${repo}`,
        summary: 'Webhook conectado correctamente.',
        telegramHtml: `🐙 <b>GitHub: Webhook Conectado</b>\n📁 Repositorio: <code>${repo}</code>\n✅ Conexión establecida correctamente.`,
      };
    }

    if (event === 'pull_request') {
      const action = payload.action;
      const pr = payload.pull_request;
      if (!pr) return null;

      const isMerged = pr.merged;
      const stateLabel = isMerged ? 'MERGEADA 🚀' : action.toUpperCase();
      const prTitle = pr.title || '(Sin título)';
      const author = pr.user?.login || 'desconocido';
      const url = pr.html_url;

      return {
        title: `PR ${stateLabel}: ${prTitle} (${repo})`,
        summary: `PR #${pr.number} por ${author}: ${prTitle}`,
        telegramHtml: `🐙 <b>GitHub: Pull Request ${stateLabel}</b>\n` +
          `📁 <b>Repo:</b> <code>${repo}</code> (#${pr.number})\n` +
          `📌 <b>Título:</b> ${this.escapeHtml(prTitle)}\n` +
          `👤 <b>Autor:</b> <code>${author}</code>\n` +
          `🔗 <a href="${url}">Abrir Pull Request</a>`,
      };
    }

    if (event === 'push') {
      const ref = payload.ref || '';
      const branch = ref.replace('refs/heads/', '');
      const commits = payload.commits || [];
      const pusher = payload.pusher?.name || payload.sender?.login || 'alguien';

      // Ignorar ramas temporales si no tienen commits
      if (commits.length === 0) return null;

      const commitMessages = commits
        .slice(0, 3)
        .map((c: any) => `• ${this.escapeHtml(c.message.split('\n')[0])}`)
        .join('\n');

      return {
        title: `Push en ${repo} (${branch})`,
        summary: `${commits.length} commit(s) por ${pusher} en ${branch}`,
        telegramHtml: `🐙 <b>GitHub: Nuevo Push</b>\n` +
          `📁 <b>Repo:</b> <code>${repo}</code> (Rama: <b>${branch}</b>)\n` +
          `👤 <b>Por:</b> <code>${pusher}</code> (${commits.length} commit(s))\n\n` +
          `${commitMessages}\n` +
          (payload.compare ? `🔗 <a href="${payload.compare}">Ver Cambios (Diff)</a>` : ''),
      };
    }

    if (event === 'release') {
      const action = payload.action;
      const release = payload.release;
      if (!release || action !== 'published') return null;

      return {
        title: `Nuevo Release en ${repo}: ${release.tag_name}`,
        summary: `Release ${release.tag_name}: ${release.name || ''}`,
        telegramHtml: `🚀 <b>GitHub: Nuevo Release Publicado</b>\n` +
          `📁 <b>Repo:</b> <code>${repo}</code>\n` +
          `🏷️ <b>Versión:</b> <code>${release.tag_name}</code>\n` +
          `📌 <b>Nombre:</b> ${this.escapeHtml(release.name || release.tag_name)}\n` +
          `🔗 <a href="${release.html_url}">Ver Release</a>`,
      };
    }

    if (event === 'issues') {
      const action = payload.action;
      const issue = payload.issue;
      if (!issue) return null;

      return {
        title: `Issue ${action.toUpperCase()} en ${repo}: ${issue.title}`,
        summary: `Issue #${issue.number} ${action}: ${issue.title}`,
        telegramHtml: `📋 <b>GitHub: Issue ${action.toUpperCase()}</b>\n` +
          `📁 <b>Repo:</b> <code>${repo}</code> (#${issue.number})\n` +
          `📌 <b>Título:</b> ${this.escapeHtml(issue.title)}\n` +
          `👤 <b>Por:</b> <code>${issue.user?.login || ''}</code>\n` +
          `🔗 <a href="${issue.html_url}">Ver Issue</a>`,
      };
    }

    return null;
  }

  private parseGitLabEvent(event: string, payload: any): { title: string; summary: string; telegramHtml: string } | null {
    const project = payload.project?.name || payload.project?.path_with_namespace || 'GitLab Project';

    if (event.includes('Pipeline')) {
      const attrs = payload.object_attributes || {};
      const status = (attrs.status || '').toLowerCase();
      const ref = attrs.ref || 'main';
      const duration = attrs.duration ? `${Math.round(attrs.duration / 60)} min` : '';

      const isFailed = status === 'failed';
      const icon = isFailed ? '❌' : status === 'success' ? '✅' : '⚙️';
      const statusLabel = isFailed ? 'FALLÓ' : status === 'success' ? 'EXITOSO' : status.toUpperCase();

      return {
        title: `GitLab Pipeline ${statusLabel}: ${project}`,
        summary: `Pipeline en ${ref} finalizó con estado: ${statusLabel}`,
        telegramHtml: `🦊 <b>GitLab: Pipeline ${icon} ${statusLabel}</b>\n` +
          `📁 <b>Proyecto:</b> <code>${project}</code> (Rama: <b>${ref}</b>)\n` +
          (duration ? `⏱️ <b>Duración:</b> ${duration}\n` : '') +
          (attrs.url ? `🔗 <a href="${attrs.url}">Ver Pipeline</a>` : ''),
      };
    }

    if (event.includes('Merge Request')) {
      const attrs = payload.object_attributes || {};
      const action = attrs.action || attrs.state || 'actualizado';
      const title = attrs.title || '';

      return {
        title: `GitLab MR ${action.toUpperCase()}: ${project}`,
        summary: `Merge Request #${attrs.iid}: ${title}`,
        telegramHtml: `🦊 <b>GitLab: Merge Request ${action.toUpperCase()}</b>\n` +
          `📁 <b>Proyecto:</b> <code>${project}</code>\n` +
          `📌 <b>Título:</b> ${this.escapeHtml(title)}\n` +
          (attrs.url ? `🔗 <a href="${attrs.url}">Ver Merge Request</a>` : ''),
      };
    }

    return null;
  }

  private parseSentryEvent(payload: any): { title: string; summary: string; telegramHtml: string } {
    const project = payload.project_name || payload.project || 'Apprecio';
    const culprit = payload.culprit || payload.event?.culprit || '';
    const message = payload.message || payload.event?.title || payload.event?.message || 'Error en backend';
    const url = payload.url || (payload.issue ? payload.issue.url : '');

    return {
      title: `Sentry Alert: ${project} - ${message}`,
      summary: `Error en ${project}: ${message} (${culprit})`,
      telegramHtml: `🚨 <b>SENTRY: ERROR DETECTADO</b>\n\n` +
        `📁 <b>Servicio/Proyecto:</b> <code>${project}</code>\n` +
        `💥 <b>Error:</b> <code>${this.escapeHtml(message)}</code>\n` +
        (culprit ? `📍 <b>Ubicación:</b> <code>${this.escapeHtml(culprit)}</code>\n` : '') +
        (url ? `🔗 <a href="${url}">Ver Incidencia en Sentry</a>` : ''),
    };
  }

  private escapeHtml(str: string): string {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

export const webhookService = new WebhookService();
