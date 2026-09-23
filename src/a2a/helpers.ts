/**
 * Helpers para construir mensajes/partes del protocolo A2A (spec 1.0).
 * Los tipos generados desde proto exigen todos los campos, así que
 * centralizamos la construcción aquí.
 */
import { randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import type { Message, Part, TaskStatus } from '@a2a-js/sdk';
import { TaskState } from '@a2a-js/sdk';

export function textPart(text: string): Part {
    return {
        content:   { $case: 'text', value: text },
        metadata:  undefined,
        filename:  '',
        mediaType: 'text/plain',
    };
}

/** Extrae y concatena las partes de texto de un mensaje A2A entrante. */
export function extractText(message: Message | undefined): string {
    if (!message?.parts?.length) return '';
    return message.parts
        .map(p => (p.content?.$case === 'text' ? p.content.value : ''))
        .filter(Boolean)
        .join('\n');
}

/** Parte de archivo por URL (imágenes/archivos generados por herramientas). */
export function urlPart(url: string, mediaType: string, filename: string): Part {
    return {
        content:   { $case: 'url', value: url },
        metadata:  undefined,
        filename,
        mediaType,
    };
}

/** Mensaje del agente (Yisus) asociado a un task/context. */
export function agentMessage(text: string, taskId: string, contextId: string, extraParts: Part[] = []): Message {
    return {
        messageId:        randomUUID(),
        contextId,
        taskId,
        role:             Role.ROLE_AGENT,
        parts:            [textPart(text), ...extraParts],
        metadata:         undefined,
        extensions:       [],
        referenceTaskIds: [],
    };
}

export function status(state: TaskState, message?: Message): TaskStatus {
    return {
        state,
        message:   message,
        timestamp: new Date().toISOString(),
    };
}
