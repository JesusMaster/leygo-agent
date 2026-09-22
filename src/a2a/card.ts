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
 * Catálogo completo de skills publicables, indexado por la herramienta que las sirve en TOOL_CATALOG.
 * La card anuncia dinámicamente solo las que el canal A2A tenga disponibles según config/channels.json.
 *
 * Acá NO se declara el `id`: lo pone construirSkills() con el nombre de la
 * herramienta. Los permisos por token se conceden por nombre de herramienta (es
 * lo que muestra la GUI y lo que verifica a2a_guard), así que si el id de la
 * skill fuera otro, el cliente no tendría cómo correlacionar lo que ve en la
 * card con lo que hay que habilitarle. Antes pasaba: account_agent se publicaba
 * como "workspace_management".
 */
const SKILLS_POR_TOOL: Record<string, any> = {
    // ─── Subagentes Especialistas ─────────────────────────────────────────────
    knowledge_public: {
        name:        'Arquitectura y Documentación Técnica',
        description: 'Consulta sobre arquitectura de software de Apprecio, microservicios, bases de datos, patrones de diseño y notas técnicas del vault de Obsidian indexadas en Qdrant.',
        tags:        ['architecture', 'obsidian', 'qdrant', 'engineering', 'apprecio', 'es'],
        examples:    ['¿Cómo funciona la arquitectura de puntos en Apprecio?', 'Explícame el flujo transaccional de canjes'],
    },
    knowledge_agent: {
        name:        'Conocimiento y Memoria de Acuerdos',
        description: 'Arquitectura y documentación técnica, más la memoria episódica: acuerdos, decisiones y compromisos registrados en reuniones de Meet, hilos de Chat y correos.',
        tags:        ['architecture', 'episodic_memory', 'decisions', 'meetings', 'apprecio', 'es'],
        examples:    ['¿Qué se decidió sobre el pipeline de CDC?', '¿Qué acordamos en la reunión de arquitectura?'],
    },
    faq_agent: {
        name:        'Plataforma y Preguntas Frecuentes Apprecio',
        description: 'Funcionamiento de la plataforma Apprecio: canjes, puntos, catálogo de beneficios, equivalencias comerciales y comercios asociados.',
        tags:        ['faq', 'apprecio', 'loyalty', 'catalog', 'points', 'es'],
        examples:    ['¿Dónde se pueden canjear los puntos?', '¿Qué comercios están disponibles?'],
    },
    triage_agent: {
        name:        'Escalamiento y Triage a Jesús',
        description: 'Registra un tema que requiere la decisión del Jesús real (compromisos, temas sensibles o fuera del alcance del clon) y se lo notifica por Telegram.',
        tags:        ['escalation', 'triage', 'es'],
        examples:    ['Necesito confirmar una fecha de entrega con Jesús', '¿Qué temas pendientes tengo por resolver?'],
    },
    account_agent: {
        name:        'Google Workspace (Gmail, Calendar, Drive, Chat)',
        description: 'Consulta y gestión de Gmail (búsqueda y redacción de borradores), Calendar (agenda y disponibilidad), Drive (búsqueda y lectura de archivos) y mensajes de Google Chat.',
        tags:        ['workspace', 'gmail', 'calendar', 'drive', 'chat', 'es'],
        examples:    ['¿Tiene reuniones mañana en la tarde?', 'Redacta un borrador de respuesta al último correo de soporte'],
    },

    // ─── Recordatorios y Resumen Matutino ─────────────────────────────────────
    schedule_reminder: {
        name:        'Programar Recordatorios',
        description: 'Agenda un recordatorio para Jesús con fecha y hora programada, notificándolo automáticamente por Telegram.',
        tags:        ['reminders', 'scheduling', 'es'],
        examples:    ['Recuérdale revisar el deploy a las 18:00', 'Recuérdame en 20 minutos revisar el log del worker'],
    },
    list_scheduled_reminders: {
        name:        'Listar Recordatorios Programados',
        description: 'Consulta y lista los recordatorios activos y pendientes programados para Jesús.',
        tags:        ['reminders', 'list', 'es'],
        examples:    ['¿Qué recordatorios tiene pendientes Jesús?', 'Lista los recordatorios programados para hoy'],
    },
    trigger_morning_digest: {
        name:        'Resumen Matutino (Morning Digest)',
        description: 'Genera el resumen ejecutivo del día (agenda de reuniones de Google Calendar, correos prioritarios y tareas) y lo envía a Telegram.',
        tags:        ['digest', 'summary', 'calendar', 'gmail', 'es'],
        examples:    ['Genera el digest de hoy', 'Envíale el resumen matutino a Jesús'],
    },

    // ─── Webhooks y Automatizaciones ──────────────────────────────────────────
    get_recent_webhooks: {
        name:        'Monitoreo de Eventos y Webhooks Recientes',
        description: 'Consulta los eventos recientes recibidos por webhook: GitHub (PRs, issues, pushes), GitLab, Sentry y alertas de infraestructura.',
        tags:        ['webhooks', 'monitoring', 'github', 'sentry', 'es'],
        examples:    ['¿Hubo alertas de Sentry hoy?', '¿Qué PRs llegaron esta semana?'],
    },
    create_custom_webhook: {
        name:        'Crear Webhook con Procesamiento de IA',
        description: 'Crea un nuevo endpoint de webhook personalizado que procesa y resume payloads entrantes con IA.',
        tags:        ['webhooks', 'automation', 'creation', 'es'],
        examples:    ['Crea un webhook para alertas de despliegue en Kubernetes'],
    },
    list_custom_webhooks: {
        name:        'Listar Webhooks Personalizados',
        description: 'Lista los webhooks inteligentes creados en el sistema, sus URLs de recepción y su estado de activación.',
        tags:        ['webhooks', 'list', 'automation', 'es'],
        examples:    ['¿Qué webhooks personalizados están activos?', 'Muestra los webhooks configurados'],
    },
    toggle_custom_webhook: {
        name:        'Activar o Pausar Webhook',
        description: 'Habilita o deshabilita temporalmente un webhook personalizado según su ID.',
        tags:        ['webhooks', 'toggle', 'management', 'es'],
        examples:    ['Pausa el webhook de alertas de prueba', 'Reactiva el webhook abc-123'],
    },
    get_custom_webhook_logs: {
        name:        'Historial y Logs de Webhooks',
        description: 'Consulta los logs de ejecución, payloads recibidos y resúmenes de IA generados por un webhook específico.',
        tags:        ['webhooks', 'logs', 'debugging', 'es'],
        examples:    ['Muestra las últimas ejecuciones del webhook de GitHub'],
    },

    // ─── Consumo, Presupuesto y Precios ───────────────────────────────────────
    get_token_usage: {
        name:        'Reporte de Consumo de Tokens y Costos',
        description: 'Reporta el gasto en modelos de IA y consumo de tokens acumulado en el mes: desglosado por canal, agente y modelo, junto al estado del presupuesto.',
        tags:        ['usage', 'cost', 'budget', 'tokens', 'es'],
        examples:    ['¿Cuánto se ha gastado en IA este mes?', 'Muestra el consumo de tokens desglosado por canal'],
    },
    set_monthly_budget: {
        name:        'Configurar Presupuesto Mensual de IA',
        description: 'Configura o ajusta el límite de gasto mensual en USD para modelos de IA, ya sea global o por canal específico (telegram, buzz, a2a, api).',
        tags:        ['budget', 'cost_control', 'finance', 'es'],
        examples:    ['Establece un presupuesto mensual de $10 USD para Buzz', 'Ajusta el presupuesto global a 15 dólares'],
    },
    refresh_pricing_catalog: {
        name:        'Actualizar Catálogo de Precios LiteLLM',
        description: 'Sincroniza en caliente la tabla de precios y costos de tokens para más de 2,000 modelos de IA desde el repositorio oficial de LiteLLM.',
        tags:        ['pricing', 'catalog', 'litellm', 'models', 'es'],
        examples:    ['Actualiza el catálogo de precios de modelos', 'Sincroniza tarifas de LiteLLM'],
    },

    // ─── Buzz / Nostr ─────────────────────────────────────────────────────────
    buzz_send_message: {
        name:        'Publicar en Buzz (Nostr)',
        description: 'Publica un mensaje en un canal descentralizado de Buzz (Nostr) firmado con la identidad de Yisus.',
        tags:        ['buzz', 'nostr', 'publish', 'channels', 'es'],
        examples:    ['Avisa en el canal de Buzz que el release quedó arriba'],
    },
    buzz_status: {
        name:        'Estado del Bridge de Buzz',
        description: 'Informa si el Gateway Nostr/Buzz está conectado al relay, con qué clave pública (npub/hex) y qué canales está escuchando.',
        tags:        ['buzz', 'nostr', 'status', 'connectivity', 'es'],
        examples:    ['¿Está conectado el bridge de Buzz?', '¿Cuál es el npub de Yisus y qué canales escucha?'],
    },
};

/**
 * Construye dinámicamente la lista de skills según las herramientas disponibles
 * en el techo del canal A2A (config/channels.json).
 */
export function construirSkills(): any[] {
    const disponibles = getToolsDisponiblesA2A();
    return disponibles
        .map((tool) => {
            // Fallback automático para herramientas nuevas no mapeadas explícitamente
            const skill = SKILLS_POR_TOOL[tool] ?? {
                name:        tool.replace(/_/g, ' '),
                description: `Herramienta de operaciones: ${tool}`,
                tags:        ['tools', 'operations', 'es'],
                examples:    [`Ejecuta ${tool}`],
            };
            return {
                ...skill,
                // El id ES el nombre de la herramienta: es la llave con la que se
                // concede el permiso al token desde la GUI.
                id:          tool,
                inputModes:  ['text/plain'],
                outputModes: ['text/plain'],
                securityRequirements,
            };
        })
        .filter(Boolean);
}

/**
 * Genera la Agent Card actualizada al momento de ser consultada.
 */
export function getYisusAgentCard(): AgentCard {
    return {
        name:        'Yisus',
        description:
            'Clon digital y asistente de operaciones tecnológicas de Jesús Leiva, CTO de Apprecio. ' +
            'Especializado en arquitectura de software, documentación técnica (Obsidian y Qdrant), ' +
            'memoria de acuerdos de reuniones y soporte sobre la plataforma Apprecio. ' +
            'El acceso a herramientas está protegido mediante tokens con alcance (scopes) configurables.',
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
}

/**
 * Export retrocompatible de la Agent Card.
 * La propiedad skills se resuelve dinámicamente a través de un getter para reflejar
 * cambios en la configuración sin requerir reinicios.
 */
export const yisusAgentCard: AgentCard = {
    name:        'Yisus',
    description:
        'Clon digital y asistente de operaciones tecnológicas de Jesús Leiva, CTO de Apprecio. ' +
        'Especializado en arquitectura de software, documentación técnica (Obsidian y Qdrant), ' +
        'memoria de acuerdos de reuniones y soporte sobre la plataforma Apprecio. ' +
        'El acceso a herramientas está protegido mediante tokens con alcance (scopes) configurables.',
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
    get skills() {
        return construirSkills();
    },
    signatures: [],
} as any;
