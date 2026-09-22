import { FunctionTool } from "@google/adk";
import { z } from "zod";

/**
 * Herramienta para buscar correos en Gmail
 */
export const gmailSearchEmails = new FunctionTool({
  name: 'gmail_search_emails',
  description: 'Busca correos electrónicos en Gmail según palabras clave, remitente (ej. "from:pablo@apprecio.com"), asunto, o etiquetas (ej. "is:unread").',
  parameters: z.object({
    query: z.string().describe('Término o filtro de búsqueda en Gmail (ej: "reunión", "from:alguien@empresa.com", "is:unread").'),
    maxResults: z.number().optional().describe('Cantidad máxima de correos a retornar (por defecto 5).')
  }) as any,
  execute: async (args: any) => {
    const { query, maxResults = 5 } = args;
    try {
      // 🛡️ 2FA / Man-in-the-Middle vía Telegram: Requiere confirmación de Jesús
      const { telegramAuthService } = await import('../../services/telegram_auth.service.js');
      const isAuthorized = await telegramAuthService.requestApproval(
        `Búsqueda de correos: "${query || 'últimos correos'}"`
      );

      if (!isAuthorized) {
        return {
          status: 'unauthorized',
          result: 'Acceso denegado: El propietario (Jesús) no autorizó el acceso a su bandeja de correo en Telegram o la solicitud expiró.',
        };
      }

      const { googleService } = await import('../../services/google.service.js');
      const emails = await googleService.searchEmails(query, maxResults);

      if (!emails || emails.length === 0) {
        return { status: 'success', result: `No se encontraron correos para la búsqueda: "${query}".` };
      }

      const formatted = emails.map(e => 
        `ID: ${e.id} | De: ${e.from} | Fecha: ${e.date}\nAsunto: ${e.subject}\nSnippet: ${e.snippet}`
      ).join('\n---\n');

      return { status: 'success', result: formatted, data: emails };
    } catch (error: any) {
      return { status: 'error', message: `Error al buscar correos en Gmail: ${error.message}` };
    }
  },
});

/**
 * Herramienta para leer un correo completo de Gmail
 */
export const gmailReadEmail = new FunctionTool({
  name: 'gmail_read_email',
  description: 'Lee el contenido completo de un correo electrónico específico usando su message ID.',
  parameters: z.object({
    messageId: z.string().describe('El ID del correo obtenido previamente con gmail_search_emails.')
  }) as any,
  execute: async (args: any) => {
    const { messageId } = args;
    try {
      // 🛡️ 2FA / Man-in-the-Middle vía Telegram: Si no hay sesión activa de 5 min, pide confirmación
      const { telegramAuthService } = await import('../../services/telegram_auth.service.js');
      const isAuthorized = await telegramAuthService.requestApproval(
        `Lectura de correo (ID: ${messageId})`
      );

      if (!isAuthorized) {
        return {
          status: 'unauthorized',
          result: 'Acceso denegado: El propietario (Jesús) no autorizó la lectura de este correo en Telegram o la solicitud expiró.',
        };
      }

      const { googleService } = await import('../../services/google.service.js');
      const email = await googleService.readEmail(messageId);

      const formatted = `ID: ${email.id} (Thread ID: ${email.threadId})\nDe: ${email.from}\nPara: ${email.to}\nFecha: ${email.date}\nAsunto: ${email.subject}\n\nCuerpo:\n${email.body}`;
      return { status: 'success', result: formatted, data: email };
    } catch (error: any) {
      return { status: 'error', message: `Error al leer correo en Gmail: ${error.message}` };
    }
  },
});

/**
 * Herramienta para crear un borrador de correo en Gmail
 */
export const gmailCreateDraft = new FunctionTool({
  name: 'gmail_create_draft',
  description: 'Crea un borrador de correo en Gmail (NO lo envía automáticamente, lo deja listo para revisión de Jesús). IMPORTANTE: Si estás respondiendo a un correo o continuando una conversación, especifica "replyToMessageId" o "threadId" para que el borrador quede agrupado dentro del mismo hilo. Los correos deben firmarse SIEMPRE y ÚNICAMENTE como "Jesús Leiva" (o "Jesús Leiva, CTO Apprecio"), NUNCA como "Yisus" ni como asistente IA.',
  parameters: z.object({
    to: z.string().describe('Dirección de correo del destinatario.'),
    subject: z.string().describe('Asunto del correo.'),
    body: z.string().describe('Cuerpo o contenido del correo. IMPORTANTE: Debe firmarse únicamente como "Jesús Leiva" (o "Jesús Leiva, CTO Apprecio"). NUNCA firmar como Yisus ni como asistente virtual.'),
    replyToMessageId: z.string().optional().describe('ID del mensaje al que se está respondiendo para enhebrar la conversación en el mismo hilo.'),
    threadId: z.string().optional().describe('ID del hilo de Gmail (threadId) si se conoce.')
  }) as any,
  execute: async (args: any) => {
    const { to, subject, body, replyToMessageId, threadId } = args;
    try {
      const { googleService } = await import('../../services/google.service.js');
      const draft = await googleService.createDraft(to, subject, body, threadId, replyToMessageId);

      // 📲 Notificar a Telegram con tarjeta interactiva de respuesta rápida [Enviar ahora] / [Enviar después]
      try {
        const { telegramQuickActionsService } = await import('../../services/telegram_quick_actions.service.js');
        if (draft.draftId) {
          await telegramQuickActionsService.sendDraftApprovalCard(draft.draftId, to, subject, body);
        }
      } catch (notifyErr: any) {
        console.warn('⚠️ [gmailCreateDraft] No se pudo enviar tarjeta a Telegram:', notifyErr.message);
      }

      return { 
        status: 'success', 
        result: `Borrador creado exitosamente para "${to}" con asunto "${subject}"${draft.threadId ? ` en el hilo "${draft.threadId}"` : ''}. Se ha enviado una tarjeta interactiva a tu Telegram con botones de acción rápida ("Enviar ahora" o "Enviar después"). (Draft ID: ${draft.draftId})`,
        data: draft 
      };
    } catch (error: any) {
      return { status: 'error', message: `Error al crear borrador en Gmail: ${error.message}` };
    }
  },
});

/**
 * Herramienta para enviar un borrador existente de Gmail
 */
export const gmailSendDraft = new FunctionTool({
  name: 'gmail_send_draft',
  description: 'Envía un borrador de correo existente en Gmail usando su draft ID cuando Jesús confirma o solicita su despacho.',
  parameters: z.object({
    draftId: z.string().describe('El ID del borrador a enviar (obtenido previamente al crear o consultar borradores).')
  }) as any,
  execute: async (args: any) => {
    const { draftId } = args;
    try {
      // 🛡️ 2FA vía Telegram: Si no hay sesión activa, pide confirmación
      const { telegramAuthService } = await import('../../services/telegram_auth.service.js');
      const isAuthorized = await telegramAuthService.requestApproval(
        `Envío de borrador de correo (Draft ID: ${draftId})`
      );

      if (!isAuthorized) {
        return {
          status: 'unauthorized',
          result: 'Acceso denegado: El propietario (Jesús) no autorizó el envío de este borrador o la solicitud expiró.',
        };
      }

      const { googleService } = await import('../../services/google.service.js');
      const result = await googleService.sendDraft(draftId);

      return {
        status: 'success',
        result: `✅ Correo enviado exitosamente a partir del borrador ${draftId}. (Message ID: ${result.messageId})`,
        data: result
      };
    } catch (error: any) {
      return { status: 'error', message: `Error al enviar borrador en Gmail: ${error.message}` };
    }
  }
});

/**
 * Herramienta para marcar correos como leídos en Gmail
 */
export const gmailMarkAsRead = new FunctionTool({
  name: 'gmail_mark_as_read',
  description: 'Marca uno o más correos electrónicos como leídos en Gmail usando sus IDs de mensaje.',
  parameters: z.object({
    messageIds: z.array(z.string()).describe('Lista de IDs de correos a marcar como leídos (obtenidos previamente con gmail_search_emails).')
  }) as any,
  execute: async (args: any) => {
    const { messageIds } = args;
    try {
      // 🛡️ 2FA vía Telegram: Si no hay sesión activa, pide confirmación
      const { telegramAuthService } = await import('../../services/telegram_auth.service.js');
      const isAuthorized = await telegramAuthService.requestApproval(
        `Marcar ${messageIds.length} correo(s) como leído(s)`
      );

      if (!isAuthorized) {
        return {
          status: 'unauthorized',
          result: 'Acceso denegado: El propietario (Jesús) no autorizó la modificación de correos en Telegram.',
        };
      }

      const { googleService } = await import('../../services/google.service.js');
      const results = await googleService.markEmailsAsRead(messageIds);

      const successfulCount = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success);

      let msg = `Se marcaron ${successfulCount} de ${messageIds.length} correo(s) como leído(s).`;
      if (failed.length > 0) {
        msg += ` Fallaron: ${failed.map(f => f.id).join(', ')}`;
      }

      return { status: 'success', result: msg, data: results };
    } catch (error: any) {
      return { status: 'error', message: `Error al marcar correos como leídos: ${error.message}` };
    }
  },
});

/**
 * Herramienta para añadir etiquetas (con o sin color) a correos en Gmail
 */
export const gmailAddLabel = new FunctionTool({
  name: 'gmail_add_label',
  description: 'Crea o busca una etiqueta en Gmail (con color opcional como "amarillo", "verde", "azul", "rojo", "naranja", "morado", "gris") y la asigna a uno o más correos usando sus IDs de mensaje.',
  parameters: z.object({
    messageIds: z.array(z.string()).describe('Lista de IDs de correos a los que asignar la etiqueta.'),
    labelName: z.string().describe('Nombre de la etiqueta (ej. "readed-by-ai", "Soporte", "Facturas"). Si no existe, se crea automáticamente.'),
    color: z.string().optional().describe('Color opcional para la etiqueta en Gmail (ej. "amarillo", "verde", "azul", "rojo", "naranja", "morado", "gris").')
  }) as any,
  execute: async (args: any) => {
    const { messageIds, labelName, color } = args;
    try {
      // 🛡️ 2FA vía Telegram: Si no hay sesión activa, pide confirmación
      const { telegramAuthService } = await import('../../services/telegram_auth.service.js');
      const isAuthorized = await telegramAuthService.requestApproval(
        `Asignar etiqueta "${labelName}" a ${messageIds.length} correo(s)`
      );

      if (!isAuthorized) {
        return {
          status: 'unauthorized',
          result: 'Acceso denegado: El propietario (Jesús) no autorizó la asignación de etiquetas en Telegram.',
        };
      }

      const { googleService } = await import('../../services/google.service.js');
      const res = await googleService.addLabelToEmails(messageIds, labelName, color);

      return {
        status: 'success',
        result: `Etiqueta "${labelName}"${color ? ` (color ${color})` : ''} aplicada correctamente a ${messageIds.length} correo(s).`,
        data: res,
      };
    } catch (error: any) {
      return { status: 'error', message: `Error al asignar etiqueta en Gmail: ${error.message}` };
    }
  },
});



/**
 * Herramienta para consultar eventos en Google Calendar
 */
export const calendarListEvents = new FunctionTool({
  name: 'calendar_list_events',
  description: 'Consulta los eventos, reuniones y compromisos de la agenda en Google Calendar para un rango de fechas.',
  parameters: z.object({
    timeMin: z.string().optional().describe('Fecha/hora de inicio en formato ISO (ej. 2026-09-20T09:00:00Z). Si se omite, toma la fecha y hora actual.'),
    timeMax: z.string().optional().describe('Fecha/hora de fin en formato ISO (ej. 2026-09-20T23:59:59Z).'),
    maxResults: z.number().optional().describe('Cantidad máxima de eventos a devolver (por defecto 10).')
  }) as any,
  execute: async (args: any) => {
    const { timeMin, timeMax, maxResults = 10 } = args;
    try {
      const { googleService } = await import('../../services/google.service.js');
      const events = await googleService.listCalendarEvents(timeMin, timeMax, maxResults);

      if (!events || events.length === 0) {
        return { status: 'success', result: 'No hay eventos ni reuniones programadas en el periodo consultado.' };
      }

      const formatted = events.map(ev => 
        `Evento: ${ev.summary}\nInicio: ${ev.start} | Fin: ${ev.end}\nParticipantes: ${ev.attendees.join(', ') || 'Sin participantes externos'}\nUbicación/Link: ${ev.location || ev.htmlLink || 'N/A'}`
      ).join('\n---\n');

      return { status: 'success', result: formatted, data: events };
    } catch (error: any) {
      return { status: 'error', message: `Error al consultar Google Calendar: ${error.message}` };
    }
  },
});

/**
 * Herramienta para agendar / crear un evento en Google Calendar
 */
export const calendarCreateEvent = new FunctionTool({
  name: 'calendar_create_event',
  description: 'Agenda o crea una reunión en Google Calendar con fecha, hora, descripción e invitados.',
  parameters: z.object({
    summary: z.string().describe('Título o asunto de la reunión.'),
    startDateTime: z.string().describe('Fecha y hora de inicio en formato ISO (ej: 2026-09-21T15:00:00-03:00).'),
    endDateTime: z.string().describe('Fecha y hora de término en formato ISO (ej: 2026-09-21T16:00:00-03:00).'),
    description: z.string().optional().describe('Detalle o tabla de temas de la reunión.'),
    attendees: z.array(z.string()).optional().describe('Lista de correos de los invitados.')
  }) as any,
  execute: async (args: any) => {
    const { summary, startDateTime, endDateTime, description = '', attendees = [] } = args;
    try {
      const { googleService } = await import('../../services/google.service.js');
      const created = await googleService.createCalendarEvent(summary, startDateTime, endDateTime, description, attendees);
      return { 
        status: 'success', 
        result: `Reunión "${summary}" agendada exitosamente desde ${startDateTime} hasta ${endDateTime}. Link: ${created.htmlLink}`,
        data: created 
      };
    } catch (error: any) {
      return { status: 'error', message: `Error al agendar en Google Calendar: ${error.message}` };
    }
  },
});

/**
 * Herramienta para buscar archivos en Google Drive
 */
export const driveSearchFiles = new FunctionTool({
  name: 'drive_search_files',
  description: 'Busca archivos y documentos en Google Drive por nombre o palabras clave.',
  parameters: z.object({
    query: z.string().describe('Nombre del archivo o palabras clave a buscar en Google Drive.'),
    maxResults: z.number().optional().describe('Cantidad máxima de archivos a retornar (por defecto 10).')
  }) as any,
  execute: async (args: any) => {
    const { query, maxResults = 10 } = args;
    try {
      const { googleService } = await import('../../services/google.service.js');
      const files = await googleService.searchDriveFiles(query, maxResults);

      if (!files || files.length === 0) {
        return { status: 'success', result: `No se encontraron archivos en Drive para: "${query}".` };
      }

      const formatted = files.map(f => 
        `Nombre: ${f.name} | ID: ${f.id}\nTipo: ${f.mimeType} | Modificado: ${f.modifiedTime}\nLink: ${f.link}`
      ).join('\n---\n');

      return { status: 'success', result: formatted, data: files };
    } catch (error: any) {
      return { status: 'error', message: `Error al buscar archivos en Google Drive: ${error.message}` };
    }
  },
});

/**
 * Herramienta para leer el contenido de un archivo o Google Doc en Drive
 */
export const driveReadFile = new FunctionTool({
  name: 'drive_read_file',
  description: 'Lee el contenido de texto de un archivo o Google Doc desde Google Drive usando su File ID.',
  parameters: z.object({
    fileId: z.string().describe('El ID del archivo en Google Drive (obtenido previamente con drive_search_files).'),
    mimeType: z.string().optional().describe('El tipo MIME del archivo si se conoce.')
  }) as any,
  execute: async (args: any) => {
    const { fileId, mimeType } = args;
    try {
      const { googleService } = await import('../../services/google.service.js');
      const file = await googleService.readDriveFileContent(fileId, mimeType);
      return { status: 'success', result: file.content, data: file };
    } catch (error: any) {
      return { status: 'error', message: `Error al leer archivo en Google Drive: ${error.message}` };
    }
  },
});

/**
 * Herramienta para listar salas, espacios y mensajes directos en Google Chat
 */
export const chatListSpaces = new FunctionTool({
  name: 'chat_list_spaces',
  description: 'Lista las conversaciones, salas de equipo y mensajes directos (DMs) de Google Chat, ordenados por actividad reciente y con la fecha del último mensaje. Cada DM incluye el nombre de la persona con la que es, así que NO hace falta leer mensajes para saber quién participa.',
  parameters: z.object({
    pageSize: z.number().optional().describe('Cantidad máxima de espacios a retornar (por defecto 20).')
  }) as any,
  execute: async (args: any) => {
    const { pageSize = 20 } = args;
    try {
      // 🛡️ 2FA vía Telegram: Si no hay sesión activa, pide confirmación
      const { telegramAuthService } = await import('../../services/telegram_auth.service.js');
      const isAuthorized = await telegramAuthService.requestApproval('Consultar lista de conversaciones en Google Chat');

      if (!isAuthorized) {
        return {
          status: 'unauthorized',
          result: 'Acceso denegado: El propietario (Jesús) no autorizó el acceso a Google Chat en Telegram.',
        };
      }

      const { googleService } = await import('../../services/google.service.js');
      const spaces = await googleService.listChatSpaces(pageSize);

      if (!spaces || spaces.length === 0) {
        return { status: 'success', result: 'No se encontraron conversaciones ni salas en Google Chat.' };
      }

      const formatted = spaces.map(s =>
        `ID: ${s.name} | Nombre: ${s.displayName} | Tipo: ${s.spaceType}${s.lastActiveTime ? ` | Última actividad: ${s.lastActiveTime}` : ''}`
      ).join('\n');

      return { status: 'success', result: formatted, data: spaces };
    } catch (error: any) {
      return { status: 'error', message: `Error al consultar espacios de Google Chat: ${error.message}` };
    }
  },
});

/**
 * Herramienta para leer mensajes de un espacio o conversación en Google Chat
 */
export const chatReadMessages = new FunctionTool({
  name: 'chat_read_messages',
  description: 'Lee los mensajes MÁS RECIENTES de una conversación o sala de Google Chat (los últimos N, entregados en orden cronológico). Marca cuáles están sin leer por Jesús. Usa sinceDays para "qué hay de nuevo en los últimos X días" y limit alto (200-500) solo si piden el historial completo. Cada llamada requiere autorización de Jesús por Telegram: NUNCA la uses para averiguar quién participa en una conversación ni para buscar a una persona; para eso está chat_find_dm.',
  parameters: z.object({
    spaceName: z.string().describe('ID del espacio en Google Chat (obtenido con chat_find_dm o chat_list_spaces).'),
    limit: z.number().optional().describe('Cantidad de mensajes recientes a leer (por defecto 50; 200-500 solo si piden el historial completo).'),
    sinceDays: z.number().optional().describe('Solo mensajes de los últimos N días. Útil para "qué hay de nuevo".'),
    maxResults: z.number().optional().describe('Alias de limit.')
  }) as any,
  execute: async (args: any) => {
    const { spaceName, limit, maxResults, sinceDays } = args;
    const requestedLimit = limit || maxResults || 50;
    const sinceIso = sinceDays ? new Date(Date.now() - sinceDays * 86400000).toISOString() : undefined;
    try {
      // 🛡️ 2FA vía Telegram: Si no hay sesión activa, pide confirmación
      const { telegramAuthService } = await import('../../services/telegram_auth.service.js');
      const alcance = sinceDays ? `últimos ${sinceDays} días` : `últimos ${requestedLimit} mensajes`;
      const isAuthorized = await telegramAuthService.requestApproval(`Leer chat (${spaceName}) [${alcance}]`);

      if (!isAuthorized) {
        return {
          status: 'unauthorized',
          result: 'Acceso denegado: Jesús no autorizó la lectura de mensajes. No insistas con otra conversación ni otra herramienta; infórmalo.',
        };
      }

      const { googleService } = await import('../../services/google.service.js');
      const [messages, lastReadTime] = await Promise.all([
        googleService.readChatMessages(spaceName, requestedLimit, sinceIso),
        googleService.getChatSpaceReadState(spaceName),
      ]);

      if (!messages || messages.length === 0) {
        return {
          status: 'success',
          result: sinceDays
            ? `No hay mensajes en los últimos ${sinceDays} días en "${spaceName}".`
            : `No hay mensajes en la conversación "${spaceName}".`,
        };
      }

      const leidoHasta = lastReadTime ? new Date(lastReadTime).getTime() : null;
      const esNuevo = (m: any) => leidoHasta !== null && new Date(m.createTime).getTime() > leidoHasta;
      const sinLeer = leidoHasta !== null ? messages.filter(esNuevo).length : null;

      const formatted = messages.map(m =>
        `${esNuevo(m) ? '🔵 [SIN LEER] ' : ''}[${m.createTime}] ${m.sender}: ${m.text}${m.threadName ? ` (Thread: ${m.threadName})` : ''}`
      ).join('\n---\n');

      const primero = messages[0].createTime;
      const ultimo = messages[messages.length - 1].createTime;
      const cabecera =
        `Se recuperaron los ${messages.length} mensajes más recientes (del ${primero} al ${ultimo}` +
        `${messages.length >= requestedLimit && !sinceDays ? '; hay mensajes anteriores que NO se leyeron' : ''}).\n` +
        (sinLeer === null
          ? 'Estado de lectura no disponible (el token de Google no tiene el scope chat.users.readstate.readonly).\n'
          : sinLeer === 0
          ? 'Jesús ya leyó todos estos mensajes.\n'
          : `⚠️ ${sinLeer} mensaje(s) SIN LEER por Jesús (leído hasta ${lastReadTime}).\n`);

      return {
        status: 'success',
        result: `${cabecera}\n${formatted}`,
        data: { messages, lastReadTime, sinLeer },
      };
    } catch (error: any) {
      return { status: 'error', message: `Error al leer mensajes de Google Chat: ${error.message}` };
    }
  },
});

/**
 * Encuentra el DM con una persona sin abrir ningún historial.
 *
 * Existe porque los DMs de Google Chat no tienen nombre: sin esta herramienta,
 * para escribirle a alguien el modelo listaba los espacios y abría el historial
 * de cada uno para ver quién era, con una autorización 2FA por cada lectura.
 */
export const chatFindDm = new FunctionTool({
  name: 'chat_find_dm',
  description: 'Encuentra el mensaje directo (DM) de Google Chat con una persona, por nombre o por email, SIN leer mensajes. Úsala SIEMPRE antes de chat_send_message cuando te pidan escribirle a alguien. Devuelve el ID del espacio para enviar el mensaje.',
  parameters: z.object({
    persona: z.string().describe('Nombre (ej: "Fabricio Figueroa") o email de la persona.'),
  }) as any,
  execute: async (args: any) => {
    const { persona } = args;
    try {
      const { telegramAuthService } = await import('../../services/telegram_auth.service.js');
      const isAuthorized = await telegramAuthService.requestApproval(`Buscar la conversación de Google Chat con "${persona}"`);
      if (!isAuthorized) {
        return {
          status: 'unauthorized',
          result: 'Acceso denegado: Jesús no autorizó el acceso a Google Chat. No insistas por otra vía; infórmalo.',
        };
      }

      const { googleService } = await import('../../services/google.service.js');
      const dm = await googleService.findChatDirectMessage(persona);

      if (!dm) {
        return {
          status: 'not_found',
          result: `No hay un mensaje directo previo con "${persona}". Si tienes su email, vuelve a intentar con él; si no, pídeselo a Jesús. No abras historiales de otras conversaciones para buscarla.`,
        };
      }

      const aviso = dm.coincidencias
        ? `\n⚠️ Hay más de una conversación que coincide: ${dm.coincidencias.join('; ')}. Confirma con el usuario cuál es antes de enviar.`
        : '';

      return {
        status: 'success',
        result: `${dm.displayName} → spaceName: ${dm.name}${aviso}`,
        data: dm,
      };
    } catch (error: any) {
      return { status: 'error', message: `Error al buscar la conversación en Google Chat: ${error.message}` };
    }
  },
});

/**
 * Herramienta para responder o enviar un mensaje en Google Chat
 */
export const chatSendMessage = new FunctionTool({
  name: 'chat_send_message',
  description: 'Envía o responde un mensaje en una conversación o sala de Google Chat.',
  parameters: z.object({
    spaceName: z.string().describe('ID del espacio en Google Chat (ej: "spaces/AAAAAAAAAA"), obtenido con chat_find_dm (para una persona) o chat_list_spaces (para una sala).'),
    text: z.string().describe('Texto del mensaje a enviar.'),
    threadName: z.string().optional().describe('Nombre del hilo (threadName) si se desea responder directamente a un hilo específico dentro del chat.')
  }) as any,
  execute: async (args: any) => {
    const { spaceName, text, threadName } = args;
    try {
      // 🛡️ 2FA vía Telegram: Si no hay sesión activa, pide confirmación
      const { telegramAuthService } = await import('../../services/telegram_auth.service.js');
      const isAuthorized = await telegramAuthService.requestApproval(`Enviar mensaje en Google Chat a "${spaceName}": "${text}"`);

      if (!isAuthorized) {
        return {
          status: 'unauthorized',
          result: 'Acceso denegado: El propietario (Jesús) no autorizó el envío del mensaje en Telegram.',
        };
      }

      const { googleService } = await import('../../services/google.service.js');
      const res = await googleService.sendChatMessage(spaceName, text, threadName);

      return {
        status: 'success',
        result: `Mensaje enviado exitosamente en Google Chat (${spaceName}).`,
        data: res,
      };
    } catch (error: any) {
      return { status: 'error', message: `Error al enviar mensaje en Google Chat: ${error.message}` };
    }
  },
});

