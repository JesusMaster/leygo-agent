/**
 * Agent Card de Yisus — documento de descubrimiento del protocolo A2A (Agent-to-Agent).
 * Publicado en /.well-known/agent-card.json
 */
import type { AgentCard, SecurityScheme } from '@a2a-js/sdk';

const PORT = process.env.PORT || '4000';
const BASE_URL = process.env.A2A_BASE_URL || `http://localhost:${PORT}`;

const securitySchemes: { [key: string]: SecurityScheme } = process.env.A2A_API_KEY
    ? {
        bearer: {
            scheme: {
                $case: 'httpAuthSecurityScheme',
                value: {
                    description:  'API key estática de Yisus Agent enviada como Bearer token',
                    scheme:       'Bearer',
                    bearerFormat: 'opaque',
                },
            },
        },
    }
    : {};

export const yisusAgentCard: AgentCard = {
    name:        'Yisus',
    description:
        'Clon digital y asistente de operaciones tecnológicas de Jesús Leiva, CTO de Apprecio. ' +
        'Especializado en arquitectura de software y documentación técnica (Obsidian y Qdrant), ' +
        'gestión integral de Google Workspace (Gmail, Google Calendar, Google Drive, Google Chat), ' +
        'memoria episódica y acuerdos de reuniones (Google Meet), ' +
        'asistencia en plataforma y consultas de Apprecio, ' +
        'y automatización de eventos e incidentes mediante Webhooks.',
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
    securityRequirements: [],
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
            securityRequirements: [],
        },
        {
            id:          'episodic_memory',
            name:        'Memoria Episódica y Acuerdos',
            description: 'Búsqueda semántica de acuerdos, decisiones tomadas, compromisos y minutas en reuniones de Google Meet, hilos de Google Chat y correos de Gmail.',
            tags:        ['episodic_memory', 'meetings', 'google_meet', 'decisions', 'chat', 'es'],
            examples:    ['¿Qué acordamos con el equipo el martes sobre infraestructura?', '¿Cuáles fueron los compromisos de la reunión de arquitectura?'],
            inputModes:  ['text/plain'],
            outputModes: ['text/plain'],
            securityRequirements: [],
        },
        {
            id:          'workspace_management',
            name:        'Gestión de Google Workspace',
            description: 'Búsqueda y lectura de correos en Gmail, redacción de borradores ejecutivos en nombre de Jesús Leiva, consulta de agenda/reuniones en Calendar, búsqueda en Drive y salas de Chat.',
            tags:        ['workspace', 'gmail', 'calendar', 'drive', 'chat', 'es'],
            examples:    ['¿Tengo reuniones hoy en la tarde?', 'Redacta un borrador de correo para el equipo sobre el release'],
            inputModes:  ['text/plain'],
            outputModes: ['text/plain'],
            securityRequirements: [],
        },
        {
            id:          'apprecio_platform_faq',
            name:        'Plataforma y Preguntas Frecuentes Apprecio',
            description: 'Respuestas sobre el funcionamiento de la plataforma Apprecio: canjes, puntos, catálogo de beneficios, equivalencias comerciales y comercios asociados.',
            tags:        ['faq', 'apprecio', 'loyalty', 'catalog', 'points', 'es'],
            examples:    ['¿Dónde se pueden canjear los puntos?', '¿Qué comercios están disponibles en el catálogo?'],
            inputModes:  ['text/plain'],
            outputModes: ['text/plain'],
            securityRequirements: [],
        },
        {
            id:          'webhooks_and_automation',
            name:        'Webhooks y Monitoreo de Eventos',
            description: 'Recepción y procesamiento con IA de eventos de GitHub (PRs, releases), GitLab, Sentry y webhooks personalizados con alertas directas a Telegram.',
            tags:        ['webhooks', 'automation', 'github', 'sentry', 'monitoring', 'es'],
            examples:    ['Consultar webhooks recientes', 'Crear un webhook personalizado para alertas de despliegue'],
            inputModes:  ['text/plain'],
            outputModes: ['text/plain'],
            securityRequirements: [],
        },
    ],
    signatures: [],
};
