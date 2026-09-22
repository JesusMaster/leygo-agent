import { google } from 'googleapis';
import { messageFormatter } from '../utils/message_formatter.js';

export class GoogleWorkspaceService {
  private getAuthClient() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'https://developers.google.com/oauthplayground';

    // 1. Prioridad: OAuth2 con Refresh Token (recomendado para cuenta de usuario)
    if (clientId && clientSecret && refreshToken) {
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      return oauth2Client;
    }

    // 2. Alternativa: Service Account
    if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
      const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
      return new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: privateKey,
        scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.compose',
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/drive.readonly',
        ],
      });
    }

    throw new Error(
      'Credenciales de Google no configuradas en el entorno (.env). Se requiere GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REFRESH_TOKEN.'
    );
  }

  // ─────────────────────────────────────────────────────────────
  // GMAIL
  // ─────────────────────────────────────────────────────────────
  async searchEmails(query: string = '', maxResults: number = 5) {
    const auth = this.getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      return [];
    }

    const fullMessages = await Promise.all(
      messages.map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id!,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date'],
        });

        const headers = detail.data.payload?.headers || [];
        const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value || '(Sin asunto)';
        const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value || '(Desconocido)';
        const date = headers.find((h) => h.name?.toLowerCase() === 'date')?.value || '';

        return {
          id: msg.id,
          threadId: msg.threadId,
          snippet: detail.data.snippet || '',
          subject,
          from,
          date,
        };
      })
    );

    return fullMessages;
  }

  async readEmail(messageId: string) {
    const auth = this.getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const res = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = res.data.payload?.headers || [];
    const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value || '(Sin asunto)';
    const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value || '(Desconocido)';
    const to = headers.find((h) => h.name?.toLowerCase() === 'to')?.value || '';
    const date = headers.find((h) => h.name?.toLowerCase() === 'date')?.value || '';

    let body = res.data.snippet || '';
    const extractText = (part: any): string => {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts && Array.isArray(part.parts)) {
        for (const subPart of part.parts) {
          const text = extractText(subPart);
          if (text) return text;
        }
      }
      return '';
    };

    if (res.data.payload) {
      const fullText = extractText(res.data.payload);
      if (fullText) body = fullText;
    }

    const messageHeaderId = headers.find((h) => h.name?.toLowerCase() === 'message-id')?.value || '';

    return {
      id: res.data.id,
      threadId: res.data.threadId,
      messageHeaderId,
      subject,
      from,
      to,
      date,
      body,
    };
  }

  /**
   * Busca hilos recientes de Gmail descartando automáticamente remitentes bots y promociones
   */
  /**
   * @param sinceHours ventana hacia atrás. Gmail acepta epoch en segundos con `after:`,
   *                   que es más preciso que newer_than (que solo admite días).
   */
  async searchRecentGmailThreads(query: string = '', maxResults: number = 10, sinceHours?: number) {
    const auth = this.getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const antiNoiseFilter = '-category:promotions -category:social -from:noreply -from:no-reply -from:notifications@github.com -from:sentry.io';

    const windowFilter = sinceHours && sinceHours > 0
      ? `after:${Math.floor(Date.now() / 1000) - Math.round(sinceHours * 3600)}`
      : 'newer_than:2d';

    const finalQuery = query
      ? `${query} ${windowFilter} ${antiNoiseFilter}`
      : `${windowFilter} ${antiNoiseFilter}`;

    const listRes = await gmail.users.threads.list({
      userId: 'me',
      q: finalQuery,
      maxResults,
    });

    const threads = listRes.data.threads || [];
    return threads.map((t) => ({
      id: t.id!,
      snippet: t.snippet || '',
      historyId: t.historyId,
    }));
  }

  /**
   * Obtiene la conversación completa de un hilo de Gmail en orden cronológico
   */
  async getGmailThread(threadId: string) {
    const auth = this.getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const res = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const messages = res.data.messages || [];
    let subject = '(Sin asunto)';

    const parsedMessages = messages.map((msg) => {
      const headers = msg.payload?.headers || [];
      const msgSubj = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value;
      if (msgSubj && subject === '(Sin asunto)') {
        subject = msgSubj;
      }
      const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value || 'Desconocido';
      const to = headers.find((h) => h.name?.toLowerCase() === 'to')?.value || '';
      const date = headers.find((h) => h.name?.toLowerCase() === 'date')?.value || '';

      // Extraer cuerpo en texto plano
      let bodyText = msg.snippet || '';
      if (msg.payload?.parts) {
        const textPart = msg.payload.parts.find((p) => p.mimeType === 'text/plain');
        if (textPart?.body?.data) {
          bodyText = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        }
      } else if (msg.payload?.body?.data) {
        bodyText = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
      }

      return {
        id: msg.id,
        from,
        to,
        date,
        bodyText: bodyText.trim(),
      };
    });

    return {
      threadId,
      subject,
      messageCount: parsedMessages.length,
      messages: parsedMessages,
    };
  }

  async createDraft(
    to: string,
    subject: string,
    messageText: string,
    threadId?: string,
    replyToMessageId?: string
  ) {
    const auth = this.getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    // Codificación MIME RFC 2047 para caracteres no ASCII en cabeceras de correo (tildes, eñes, etc.)
    const encodeMimeHeader = (text: string): string => {
      if (!text || /^[\x00-\x7F]*$/.test(text)) {
        return text;
      }
      return `=?UTF-8?B?${Buffer.from(text, 'utf-8').toString('base64')}?=`;
    };

    const encodeRecipient = (recipient: string): string => {
      if (!recipient || /^[\x00-\x7F]*$/.test(recipient)) {
        return recipient;
      }
      const match = recipient.match(/^([^<]+)(<[^>]+>)$/);
      if (match) {
        const name = match[1].trim();
        const emailPart = match[2];
        return `${encodeMimeHeader(name)} ${emailPart}`;
      }
      return encodeMimeHeader(recipient);
    };

    let finalThreadId = threadId;
    let inReplyToHeader = '';
    let referencesHeader = '';

    // Si nos pasan el ID del mensaje original a responder, extraemos sus cabeceras para enhebrar correctamente
    if (replyToMessageId) {
      try {
        const origMsg = await gmail.users.messages.get({
          userId: 'me',
          id: replyToMessageId,
          format: 'metadata',
          metadataHeaders: ['Message-ID', 'References', 'Subject'],
        });

        if (!finalThreadId && origMsg.data.threadId) {
          finalThreadId = origMsg.data.threadId;
        }

        const origHeaders = origMsg.data.payload?.headers || [];
        const origMsgId = origHeaders.find((h) => h.name?.toLowerCase() === 'message-id')?.value;
        const origRefs = origHeaders.find((h) => h.name?.toLowerCase() === 'references')?.value;

        if (origMsgId) {
          inReplyToHeader = origMsgId;
          referencesHeader = origRefs ? `${origRefs} ${origMsgId}` : origMsgId;
        }
      } catch (err: any) {
        console.warn(`[createDraft] No se pudo obtener metadata del mensaje original ${replyToMessageId}:`, err.message);
      }
    }

    // Normalizar firma: los correos deben ir firmados siempre como Jesús Leiva, nunca como Yisus o Asistente IA
    const sanitizedMessageText = messageText
      .replace(/Yisus\s*\((?:AI\s+Assistant|Asistente\s+IA|Asistente|Clon\s+Digital)\)/gi, 'Jesús Leiva')
      .replace(/(?<=\n|^)(Saludos(?: cordiales)?,?\s*\n+)(?:Yisus)(?=\s*$|\n)/gi, '$1Jesús Leiva');

    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const plainText = messageFormatter.formatForPlainText(sanitizedMessageText);
    const htmlText = messageFormatter.formatForEmail(sanitizedMessageText, undefined, false);

    // Asegurar saltos de línea CRLF (\r\n) estándar RFC 2822 para evitar que clientes de correo colapsen líneas
    const rfcPlainText = plainText.replace(/\r?\n/g, '\r\n');
    const rfcHtmlText = htmlText.replace(/\r?\n/g, '\r\n');

    const emailLines = [
      `To: ${encodeRecipient(to)}`,
      `Subject: ${encodeMimeHeader(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];

    if (inReplyToHeader) {
      emailLines.push(`In-Reply-To: ${inReplyToHeader}`);
    }
    if (referencesHeader) {
      emailLines.push(`References: ${referencesHeader}`);
    }

    emailLines.push('');
    // Parte de texto plano (fallback compatible)
    emailLines.push(`--${boundary}`);
    emailLines.push('Content-Type: text/plain; charset=UTF-8');
    emailLines.push('Content-Transfer-Encoding: 8bit');
    emailLines.push('');
    emailLines.push(rfcPlainText);
    emailLines.push('');

    // Parte HTML (formateo enriquecido nativo para Gmail web y móvil)
    emailLines.push(`--${boundary}`);
    emailLines.push('Content-Type: text/html; charset=UTF-8');
    emailLines.push('Content-Transfer-Encoding: 8bit');
    emailLines.push('');
    emailLines.push(rfcHtmlText);
    emailLines.push('');

    // Cierre del boundary
    emailLines.push(`--${boundary}--`);

    const emailRaw = Buffer.from(emailLines.join('\r\n'), 'utf-8').toString('base64url');

    const messagePayload: any = { raw: emailRaw };
    if (finalThreadId) {
      messagePayload.threadId = finalThreadId;
    }

    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: messagePayload,
      },
    });

    return {
      draftId: res.data.id,
      messageId: res.data.message?.id,
      threadId: res.data.message?.threadId,
      status: 'created',
    };
  }

  /**
   * Envía un borrador de correo existente en Gmail
   */
  async sendDraft(draftId: string) {
    const auth = this.getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const res = await gmail.users.drafts.send({
      userId: 'me',
      requestBody: {
        id: draftId,
      },
    });

    return {
      messageId: res.data.id,
      threadId: res.data.threadId,
      status: 'sent',
    };
  }

  /**
   * Elimina / descarta un borrador de correo en Gmail
   */
  async deleteDraft(draftId: string) {
    const auth = this.getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    await gmail.users.drafts.delete({
      userId: 'me',
      id: draftId,
    });

    return {
      draftId,
      status: 'deleted',
    };
  }

  async markEmailsAsRead(messageIds: string[]) {
    const auth = this.getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const results = await Promise.all(
      messageIds.map(async (id) => {
        try {
          await gmail.users.messages.modify({
            userId: 'me',
            id,
            requestBody: {
              removeLabelIds: ['UNREAD'],
            },
          });
          return { id, success: true };
        } catch (err: any) {
          return { id, success: false, error: err.message };
        }
      })
    );

    return results;
  }

  private getColorConfig(colorName?: string): { backgroundColor: string; textColor: string } | undefined {
    if (!colorName) return undefined;
    const normalized = colorName.toLowerCase().trim();
    const colorMap: Record<string, { backgroundColor: string; textColor: string }> = {
      amarillo: { backgroundColor: '#fad165', textColor: '#000000' },
      yellow: { backgroundColor: '#fad165', textColor: '#000000' },
      verde: { backgroundColor: '#16a765', textColor: '#ffffff' },
      green: { backgroundColor: '#16a765', textColor: '#ffffff' },
      azul: { backgroundColor: '#4986e7', textColor: '#ffffff' },
      blue: { backgroundColor: '#4986e7', textColor: '#ffffff' },
      rojo: { backgroundColor: '#fb4c2f', textColor: '#ffffff' },
      red: { backgroundColor: '#fb4c2f', textColor: '#ffffff' },
      naranja: { backgroundColor: '#ffad46', textColor: '#000000' },
      orange: { backgroundColor: '#ffad46', textColor: '#000000' },
      morado: { backgroundColor: '#a479e2', textColor: '#ffffff' },
      purpura: { backgroundColor: '#a479e2', textColor: '#ffffff' },
      purple: { backgroundColor: '#a479e2', textColor: '#ffffff' },
      gris: { backgroundColor: '#cccccc', textColor: '#000000' },
      gray: { backgroundColor: '#cccccc', textColor: '#000000' },
    };
    return colorMap[normalized];
  }

  async getOrCreateLabel(name: string, colorName?: string) {
    const auth = this.getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const listRes = await gmail.users.labels.list({ userId: 'me' });
    const existing = (listRes.data.labels || []).find(
      (l) => l.name?.toLowerCase() === name.toLowerCase()
    );

    const colorConfig = this.getColorConfig(colorName);

    if (existing && existing.id) {
      // Si existe y pidieron color, intentar actualizar el color
      if (colorConfig && !existing.color) {
        try {
          const patchRes = await gmail.users.labels.patch({
            userId: 'me',
            id: existing.id,
            requestBody: {
              color: colorConfig,
            },
          });
          return patchRes.data;
        } catch {
          // Si falla actualizar color (por ej. paleta no estándar), devolver existente
        }
      }
      return existing;
    }

    // Si no existe, crearla
    const createBody: any = {
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    };
    if (colorConfig) {
      createBody.color = colorConfig;
    }

    try {
      const createRes = await gmail.users.labels.create({
        userId: 'me',
        requestBody: createBody,
      });
      return createRes.data;
    } catch (err: any) {
      // Si falló por color, reintentar sin color
      if (createBody.color) {
        delete createBody.color;
        const retryRes = await gmail.users.labels.create({
          userId: 'me',
          requestBody: createBody,
        });
        return retryRes.data;
      }
      throw err;
    }
  }

  async addLabelToEmails(messageIds: string[], labelName: string, colorName?: string) {
    const auth = this.getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const label = await this.getOrCreateLabel(labelName, colorName);
    if (!label.id) {
      throw new Error(`No se pudo obtener o crear la etiqueta "${labelName}".`);
    }

    try {
      // Batch modify es más eficiente para múltiples correos
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: messageIds,
          addLabelIds: [label.id],
        },
      });
      return { success: true, labelId: label.id, labelName: label.name, count: messageIds.length };
    } catch (err: any) {
      // Fallback a modificación individual
      const individualResults = await Promise.all(
        messageIds.map(async (id) => {
          try {
            await gmail.users.messages.modify({
              userId: 'me',
              id,
              requestBody: {
                addLabelIds: [label.id!],
              },
            });
            return { id, success: true };
          } catch (e: any) {
            return { id, success: false, error: e.message };
          }
        })
      );
      return { success: true, labelId: label.id, labelName: label.name, results: individualResults };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GOOGLE CALENDAR
  // ─────────────────────────────────────────────────────────────
  async listCalendarEvents(timeMin?: string, timeMax?: string, maxResults: number = 10) {
    const auth = this.getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const start = timeMin || new Date().toISOString();
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: start,
      timeMax: timeMax || undefined,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const items = res.data.items || [];
    return items.map((evt) => ({
      id: evt.id,
      summary: evt.summary || '(Sin título)',
      description: evt.description || '',
      location: evt.location || '',
      start: evt.start?.dateTime || evt.start?.date,
      end: evt.end?.dateTime || evt.end?.date,
      attendees: evt.attendees?.map((a) => a.email) || [],
      htmlLink: evt.htmlLink,
    }));
  }

  async createCalendarEvent(
    summary: string,
    startDateTime: string,
    endDateTime: string,
    description: string = '',
    attendees: string[] = []
  ) {
    const auth = this.getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const event = {
      summary,
      description,
      start: { dateTime: startDateTime },
      end: { dateTime: endDateTime },
      attendees: attendees.map((email) => ({ email })),
    };

    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    return {
      id: res.data.id,
      summary: res.data.summary,
      start: res.data.start?.dateTime,
      end: res.data.end?.dateTime,
      htmlLink: res.data.htmlLink,
      status: 'created',
    };
  }

  // ─────────────────────────────────────────────────────────────
  // GOOGLE DRIVE & DOCS
  // ─────────────────────────────────────────────────────────────
  /**
   * @param rawQuery query cruda de la Drive API. Si viene, reemplaza al filtro por
   *                 nombre (necesario para buscar varios patrones a la vez).
   */
  async searchDriveFiles(query: string = '', maxResults: number = 10, rawQuery?: string) {
    const auth = this.getAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    let q = "trashed = false";
    if (rawQuery) {
      q += ` and (${rawQuery})`;
    } else if (query) {
      q += ` and (name contains '${query.replace(/'/g, "\\'")}' or fullText contains '${query.replace(/'/g, "\\'")}')`;
    }

    const res = await drive.files.list({
      q,
      pageSize: maxResults,
      orderBy: 'modifiedTime desc',
      fields: 'files(id, name, mimeType, modifiedTime, webViewLink, size)',
    });

    return (res.data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      link: f.webViewLink,
    }));
  }

  async readDriveFileContent(fileId: string, mimeType?: string) {
    const auth = this.getAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    // Si es un Google Doc, se exporta como texto plano
    if (mimeType?.includes('google-apps.document') || !mimeType) {
      try {
        const exportRes = await drive.files.export({
          fileId,
          mimeType: 'text/plain',
        });
        return {
          fileId,
          content: typeof exportRes.data === 'string' ? exportRes.data : JSON.stringify(exportRes.data),
        };
      } catch {
        // Fallback
      }
    }

    const getRes = await drive.files.get({
      fileId,
      alt: 'media',
    });

    return {
      fileId,
      content: typeof getRes.data === 'string' ? getRes.data : JSON.stringify(getRes.data),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // GOOGLE CHAT
  // ─────────────────────────────────────────────────────────────
  /**
   * Participantes humanos de un espacio (nombre visible). Para los mensajes
   * directos es la única forma de saber con quién es la conversación: la API no
   * les pone displayName.
   */
  private async listChatHumanMembers(chat: any, spaceName: string): Promise<string[]> {
    try {
      const res = await chat.spaces.members.list({
        parent: spaceName,
        pageSize: 20,
        filter: 'member.type = "HUMAN"',
      });
      const memberships: any[] = res.data.memberships || [];
      return memberships
        .map((m) => m.member?.displayName)
        .filter((n): n is string => !!n);
    } catch {
      return [];
    }
  }

  async listChatSpaces(pageSize: number = 20) {
    const auth = this.getAuthClient();
    const chat = google.chat({ version: 'v1', auth });

    const res = await chat.spaces.list({
      pageSize,
    });

    const spaces = res.data.spaces || [];

    // Los DMs vienen sin nombre. Sin resolver los participantes, la única manera
    // de saber con quién es cada uno era leer su historial, que es justo lo que
    // no queremos: una lectura de mensajes (y una autorización 2FA) por cada DM.
    return Promise.all(
      spaces.map(async (s) => {
        const esDm = (s.spaceType || s.type) === 'DIRECT_MESSAGE';
        const participantes = esDm && s.name ? await this.listChatHumanMembers(chat, s.name) : [];
        return {
          name: s.name, // formato: spaces/AAAAAAAAAA
          displayName: s.displayName || (participantes.length ? `DM con ${participantes.join(' y ')}` : '(Mensaje Directo)'),
          spaceType: s.spaceType || s.type,
          singleUserBotDm: s.singleUserBotDm,
          participantes,
        };
      }),
    );
  }

  /**
   * Encuentra el mensaje directo con una persona SIN leer mensajes.
   *
   * Por email usa spaces.findDirectMessage (exacto). Por nombre lista los DMs y
   * compara contra los participantes. Devuelve null si no hay coincidencia.
   */
  async findChatDirectMessage(query: string): Promise<{ name: string; displayName: string; participantes: string[]; coincidencias?: string[] } | null> {
    const q = query.trim();
    if (!q) return null;

    const auth = this.getAuthClient();
    const chat = google.chat({ version: 'v1', auth });

    if (q.includes('@')) {
      try {
        const res = await chat.spaces.findDirectMessage({ name: `users/${q}` });
        if (res.data?.name) {
          const participantes = await this.listChatHumanMembers(chat, res.data.name);
          return { name: res.data.name, displayName: `DM con ${participantes.join(' y ') || q}`, participantes };
        }
      } catch {
        // Sin DM previo con ese email; se intenta por nombre igual
      }
    }

    const normalizar = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const terminos = normalizar(q.replace(/@.*$/, '')).split(/\s+/).filter(Boolean);

    const espacios = await this.listChatSpaces(100);
    const dms = espacios.filter((e) => e.spaceType === 'DIRECT_MESSAGE' && e.participantes.length);

    const puntuados = dms
      .map((dm) => {
        const nombres = dm.participantes.map(normalizar).join(' | ');
        const aciertos = terminos.filter((t) => nombres.includes(t)).length;
        return { dm, aciertos };
      })
      .filter((x) => x.aciertos > 0)
      .sort((a, b) => b.aciertos - a.aciertos);

    if (puntuados.length === 0) return null;

    const mejor = puntuados[0].dm;
    const empatados = puntuados.filter((x) => x.aciertos === puntuados[0].aciertos);
    return {
      name: mejor.name!,
      displayName: mejor.displayName,
      participantes: mejor.participantes,
      coincidencias: empatados.length > 1 ? empatados.map((x) => `${x.dm.displayName} (${x.dm.name})`) : undefined,
    };
  }

  async readChatMessages(spaceName: string, maxMessages: number = 100) {
    const auth = this.getAuthClient();
    const chat = google.chat({ version: 'v1', auth });

    const allMessages: any[] = [];
    let pageToken: string | undefined = undefined;
    const batchSize = Math.min(Math.max(maxMessages, 10), 100);

    do {
      try {
        const res: any = await chat.spaces.messages.list({
          parent: spaceName,
          pageSize: batchSize,
          pageToken,
        });

        const items = res.data.messages || [];
        if (items.length === 0) break;

        for (const m of items) {
          allMessages.push({
            name: m.name,
            sender: m.sender?.displayName || m.sender?.name || 'Desconocido',
            senderType: m.sender?.type,
            text: m.text || '',
            createTime: m.createTime,
            threadName: m.thread?.name,
          });

          if (allMessages.length >= maxMessages) {
            break;
          }
        }

        pageToken = res.data.nextPageToken;
      } catch (err: any) {
        console.warn(`[readChatMessages] Error al paginar mensajes en ${spaceName}:`, err.message);
        break;
      }
    } while (pageToken && allMessages.length < maxMessages);

    // Ordenar cronológicamente (de más antiguo a más reciente) para análisis de evolución
    allMessages.sort((a, b) => new Date(a.createTime).getTime() - new Date(b.createTime).getTime());

    return allMessages;
  }

  /**
   * Obtiene conversaciones y discusiones recientes de Google Chat agrupadas por hilo
   */
  async getRecentChatThreads(hours: number = 24) {
    const spaces = await this.listChatSpaces(30);
    const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
    const groupedThreads: Array<{
      spaceName: string;
      spaceDisplayName: string;
      threadName: string;
      messages: Array<{ sender: string; text: string; createTime: string }>;
    }> = [];

    for (const space of spaces) {
      if (!space.name) continue;
      try {
        const messages = await this.readChatMessages(space.name, 100);
        const recentMessages = messages.filter((m) => new Date(m.createTime).getTime() >= cutoffTime);
        if (recentMessages.length === 0) continue;

        // Agrupar por threadName
        const threadMap = new Map<string, Array<{ sender: string; text: string; createTime: string }>>();

        for (const msg of recentMessages) {
          const tName = msg.threadName || `${space.name}/general`;
          if (!threadMap.has(tName)) {
            threadMap.set(tName, []);
          }
          threadMap.get(tName)!.push({
            sender: msg.sender,
            text: msg.text,
            createTime: msg.createTime,
          });
        }

        for (const [tName, msgs] of threadMap.entries()) {
          groupedThreads.push({
            spaceName: space.name!,
            spaceDisplayName: space.displayName || space.name || 'Espacio',
            threadName: tName,
            messages: msgs,
          });
        }
      } catch (err: any) {
        console.warn(`[getRecentChatThreads] Error leyendo espacio ${space.displayName}:`, err.message);
      }
    }

    return groupedThreads;
  }

  async sendChatMessage(spaceName: string, text: string, threadName?: string) {
    const auth = this.getAuthClient();
    const chat = google.chat({ version: 'v1', auth });

    const requestBody: any = {
      text,
    };
    if (threadName) {
      requestBody.thread = { name: threadName };
    }

    const res = await chat.spaces.messages.create({
      parent: spaceName,
      messageReplyOption: threadName ? 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : undefined,
      requestBody,
    });

    return {
      messageId: res.data.name,
      threadName: res.data.thread?.name,
      text: res.data.text,
      createTime: res.data.createTime,
      status: 'sent',
    };
  }
}

export const googleService = new GoogleWorkspaceService();

