/**
 * Agent Card de Yisus — documento de descubrimiento del protocolo A2A (Agent-to-Agent).
 * Publicado en /.well-known/agent-card.json
 */
import type { AgentCard, SecurityScheme } from '@a2a-js/sdk';
import { getToolsDisponiblesA2A } from '../config/channels.js';

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

/**
 * Catálogo de skills publicables, indexado por la herramienta que las sirve.
 * La card anuncia solo las que el canal A2A tenga disponibles: si mañana se
 * habilita otra herramienta, aparece sola en el discovery.
 */
const SKILLS_POR_TOOL: Record<string, any> = {
    knowledge_public: {
        id:          'knowledge_architecture',
        name:        'Arquitectura y Documentación Técnica',
        description: 'Consulta sobre arquitectura de software de Apprecio, microservicios, bases de datos, patrones de diseño y notas técnicas del vault de Obsidian indexadas en Qdrant.',
        tags:        ['architecture', 'obsidian', 'qdrant', 'engineering', 'apprecio', 'es'],
        examples:    ['¿Cómo funciona la arquitectura de puntos en Apprecio?', 'Explícame el flujo transaccional de canjes'],
    },
    knowledge_agent: {
        id:          'knowledge_and_memory',
        name:        'Conocimiento y Memoria de Acuerdos',
        description: 'Arquitectura y documentación técnica, más la memoria episódica: acuerdos, decisiones y compromisos registrados en reuniones de Meet, hilos de Chat y correos.',
        tags:        ['architecture', 'episodic_memory', 'decisions', 'meetings', 'apprecio', 'es'],
        examples:    ['¿Qué se decidió sobre el pipeline de CDC?', '¿Qué acordamos en la reunión de arquitectura?'],
    },
    faq_agent: {
        id:          'apprecio_platform_faq',
        name:        'Plataforma y Preguntas Frecuentes Apprecio',
        description: 'Funcionamiento de la plataforma Apprecio: canjes, puntos, catálogo de beneficios, equivalencias comerciales y comercios asociados.',
        tags:        ['faq', 'apprecio', 'loyalty', 'catalog', 'points', 'es'],
        examples:    ['¿Dónde se pueden canjear los puntos?', '¿Qué comercios están disponibles?'],
    },
    triage_agent: {
        id:          'escalation',
        name:        'Escalamiento a Jesús',
        description: 'Registra un tema que requiere la decisión del Jesús real (compromisos, temas sensibles o fuera del alcance del clon) y se lo notifica.',
        tags:        ['escalation', 'triage', 'es'],
        examples:    ['Necesito confirmar una fecha de entrega con Jesús'],
    },
    account_agent: {
        id:          'workspace_management',
        name:        'Google Workspace (correo, agenda, Drive, Chat)',
        description: 'Consulta y gestión de Gmail, Calendar, Drive y Google Chat de la cuenta de Jesús. Cada acción exige además su aprobación por Telegram.',
        tags:        ['workspace', 'gmail', 'calendar', 'drive', 'chat', 'es'],
        examples:    ['¿Tiene reuniones mañana en la tarde?', 'Redacta un borrador de respuesta al último correo de soporte'],
    },
    schedule_reminder: {
        id:          'reminders',
        name:        'Recordatorios',
        description: 'Agenda un recordatorio para Jesús y consulta los pendientes.',
        tags:        ['reminders', 'scheduling', 'es'],
        examples:    ['Recuérdale revisar el deploy a las 18:00'],
    },
    list_scheduled_reminders: {
        id:          'reminders_list',
        name:        'Recordatorios programados',
        description: 'Lista los recordatorios pendientes de Jesús.',
        tags:        ['reminders', 'es'],
        examples:    ['¿Qué recordatorios tiene pendientes?'],
    },
    trigger_morning_digest: {
        id:          'morning_digest',
        name:        'Resumen matutino',
        description: 'Genera el resumen ejecutivo del día (agenda y correos) y lo envía a Telegram.',
        tags:        ['digest', 'summary', 'es'],
        examples:    ['Genera el digest de hoy'],
    },
    get_recent_webhooks: {
        id:          'webhooks_monitoring',
        name:        'Monitoreo de eventos y alertas',
        description: 'Consulta los eventos recientes recibidos por webhook: GitHub, GitLab, Sentry y alertas genéricas.',
        tags:        ['webhooks', 'monitoring', 'github', 'sentry', 'es'],
        examples:    ['¿Hubo alertas de Sentry hoy?', '¿Qué PRs llegaron esta semana?'],
    },
    create_custom_webhook: {
        id:          'webhooks_management',
        name:        'Gestión de webhooks con IA',
        description: 'Crea, pausa y consulta webhooks personalizados que resumen con IA el payload recibido.',
        tags:        ['webhooks', 'automation', 'es'],
        examples:    ['Crea un webhook para alertas de despliegue'],
    },
    get_token_usage: {
        id:          'usage_reporting',
        name:        'Consumo de tokens y presupuesto',
        description: 'Reporte del gasto en modelos de IA del mes: por canal, agente y modelo, con el estado del presupuesto.',
        tags:        ['usage', 'cost', 'budget', 'es'],
        examples:    ['¿Cuánto se ha gastado este mes?'],
    },
    buzz_send_message: {
        id:          'buzz_publish',
        name:        'Publicar en Buzz',
        description: 'Publica un mensaje en el canal de Buzz (Nostr) firmado con la identidad de Yisus. Requiere aprobación por Telegram.',
        tags:        ['buzz', 'nostr', 'publish', 'es'],
        examples:    ['Avisa en el canal que el release quedó arriba'],
    },
    buzz_status: {
        id:          'buzz_status',
        name:        'Estado del bridge de Buzz',
        description: 'Informa si el bridge de Buzz/Nostr está conectado, con qué identidad y a qué canales.',
        tags:        ['buzz', 'nostr', 'status', 'es'],
        examples:    ['¿Está conectado el bridge de Buzz?'],
    },
};

function construirSkills() {
    const disponibles = getToolsDisponiblesA2A();
    return disponibles
        .map((tool) => SKILLS_POR_TOOL[tool])
        .filter(Boolean)
        .map((s: any) => ({
            ...s,
            inputModes:  ['text/plain'],
            outputModes: ['text/plain'],
            securityRequirements,
        }));
}

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
    skills: construirSkills(),
    signatures: [],
};
