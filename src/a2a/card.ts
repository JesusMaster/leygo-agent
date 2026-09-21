/**
 * Agent Card de Yisus — documento de descubrimiento del protocolo A2A (Agent-to-Agent).
 * Publicado en /.well-known/agent-card.json
 */
import type { AgentCard, SecurityScheme } from '@a2a-js/sdk';

const PORT = process.env.PORT || '4000';

/**
 * Origen del agente. Se normaliza a propósito: si A2A_BASE_URL trae una ruta
 * (por ejemplo la del propio agent-card), la card terminaría anunciando un RPC
 * inexistente como ".../agent-card.json/a2a/v1" y el discovery del cliente falla
 * con 404 sin decir por qué.
 */
function normalizarBase(raw?: string): string {
    if (!raw) return `http://localhost:${PORT}`;
    try {
        const u = new URL(raw);
        if (u.pathname && u.pathname !== '/') {
            console.warn(`⚠️ [A2A] A2A_BASE_URL traía una ruta ("${u.pathname}"): se usa solo el origen ${u.origin}.`);
        }
        return u.origin;
    } catch {
        console.warn(`⚠️ [A2A] A2A_BASE_URL inválida ("${raw}"): se usa localhost.`);
        return `http://localhost:${PORT}`;
    }
}

const BASE_URL = normalizarBase(process.env.A2A_BASE_URL);

/**
 * El endpoint SIEMPRE exige token: los tokens viven en la base y se administran
 * desde la GUI. Antes este bloque dependía de A2A_API_KEY, así que al migrar a
 * tokens en base la card pasó a declarar "sin autenticación" — el cliente la leía,
 * no mandaba credencial, y chocaba con un 401 que no podía explicarse.
 */
const securitySchemes: { [key: string]: SecurityScheme } = {
    bearer: {
        scheme: {
            $case: 'httpAuthSecurityScheme',
            value: {
                description:  'Token de acceso de Yisus Agent. Cada token declara su propio alcance de herramientas.',
                scheme:       'Bearer',
                bearerFormat: 'opaque',
            },
        },
    },
};

/** El tipo del SDK es { schemes: { <nombre>: { list: string[] } } } */
const securityRequirements = [{ schemes: { bearer: { list: [] as string[] } } }];

export const yisusAgentCard: AgentCard = {
    name:        'Yisus',
    description:
        'Clon digital y asistente de operaciones tecnológicas de Jesús Leiva, CTO de Apprecio. ' +
        'Especializado en arquitectura de software y documentación técnica (Obsidian y Qdrant), ' +
        'y asistencia sobre la plataforma Apprecio. ' +
        'Por este canal no se exponen la cuenta de Google ni las automatizaciones internas.',
    supportedInterfaces: [
        {
            url:             `${BASE_URL}/a2a/v1`,
            protocolBinding: 'JSONRPC',
            tenant:          '',
            protocolVersion: '1.0',
        },
    ],
    provider: {
        organization: 'Apprecio (Dcanje SpA)',
        url:          'https://www.apprecio.cl',
    },
    version:      '1.0.0',
    capabilities: {
        streaming:         true,
        pushNotifications: false,
        extendedAgentCard: false,
        extensions:        [],
    },
    securitySchemes,
    securityRequirements,
    defaultInputModes:    ['text/plain'],
    defaultOutputModes:   ['text/plain'],
    skills: [
        {
            id:          'knowledge_architecture',
            name:        'Arquitectura y Documentación Técnica',
            description: 'Consulta sobre arquitectura de software de Apprecio, microservicios, bases de datos, patrones de diseño, decisiones técnicas y notas del vault de Obsidian indexadas en Qdrant.',
            tags:        ['architecture', 'obsidian', 'qdrant', 'engineering', 'apprecio', 'es'],
            examples:    ['¿Cómo funciona la arquitectura de puntos en Apprecio?', 'Explícame el flujo transaccional de canjes'],
            inputModes:  ['text/plain'],
            outputModes: ['text/plain'],
            securityRequirements,
        },
        {
            id:          'apprecio_platform_faq',
            name:        'Plataforma y Preguntas Frecuentes Apprecio',
            description: 'Respuestas sobre el funcionamiento de la plataforma Apprecio: canjes, puntos, catálogo de beneficios, equivalencias comerciales y comercios asociados.',
            tags:        ['faq', 'apprecio', 'loyalty', 'catalog', 'points', 'es'],
            examples:    ['¿Dónde se pueden canjear los puntos?', '¿Qué comercios están disponibles en el catálogo?'],
            inputModes:  ['text/plain'],
            outputModes: ['text/plain'],
            securityRequirements,
        },
    ],
    signatures: [],
};
