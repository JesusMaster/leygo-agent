import { AgentTool } from '@google/adk';
import { faqAgent } from './faqs.agent.js';
import { accountAgent } from './account.agent.js';
import { knowledgeAgent } from './knowledge.agent.js';
import { triageAgent } from './triage.agent.js';
import { publicKnowledgeAgent } from './public_knowledge.agent.js';
import { scheduleReminderTool, listRemindersTool, triggerMorningDigestTool } from './tools/scheduler.tools.js';
import {
  getRecentWebhooksTool,
  createCustomWebhookTool,
  listCustomWebhooksTool,
  toggleCustomWebhookTool,
  getCustomWebhookLogsTool,
} from './tools/webhook.tools.js';
import { getTokenUsageTool, setMonthlyBudgetTool, refreshPricingCatalogTool } from './tools/usage.tools.js';
import { buzzSendMessage, buzzStatus } from './tools/nostr.tools.js';

/**
 * Catálogo único de herramientas expuestas al Coordinator.
 *
 * Cada canal (telegram, buzz, a2a, api) arma su propio set a partir de acá, en vez
 * de compartir una lista fija. Así una herramienta nueva no queda automáticamente
 * disponible para todos los canales: hay que habilitarla donde corresponda.
 */
export const TOOL_CATALOG: Record<string, any> = {
  // Subagentes
  knowledge_agent:  new AgentTool({ agent: knowledgeAgent }),        // incluye memoria episódica (correos/chats)
  knowledge_public: new AgentTool({ agent: publicKnowledgeAgent }),  // solo documentación técnica de Obsidian
  faq_agent:        new AgentTool({ agent: faqAgent }),
  account_agent:    new AgentTool({ agent: accountAgent }),          // Gmail, Calendar, Drive, Chat
  triage_agent:     new AgentTool({ agent: triageAgent }),

  // Recordatorios y digest
  schedule_reminder:        scheduleReminderTool,
  list_scheduled_reminders: listRemindersTool,
  trigger_morning_digest:   triggerMorningDigestTool,

  // Webhooks
  get_recent_webhooks:     getRecentWebhooksTool,
  create_custom_webhook:   createCustomWebhookTool,
  list_custom_webhooks:    listCustomWebhooksTool,
  toggle_custom_webhook:   toggleCustomWebhookTool,
  get_custom_webhook_logs: getCustomWebhookLogsTool,

  // Consumo y presupuesto
  get_token_usage:        getTokenUsageTool,
  set_monthly_budget:     setMonthlyBudgetTool,
  refresh_pricing_catalog: refreshPricingCatalogTool,

  // Buzz / Nostr
  buzz_send_message: buzzSendMessage,
  buzz_status:       buzzStatus,
};

/**
 * Grupos para no tener que enumerar herramienta por herramienta en la config.
 * En la configuración se puede usar el nombre del grupo o el de una herramienta suelta.
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  knowledge:  ['knowledge_agent'],
  publico:    ['knowledge_public', 'faq_agent'],
  faq:        ['faq_agent'],
  workspace:  ['account_agent'],
  triage:     ['triage_agent'],
  reminders:  ['schedule_reminder', 'list_scheduled_reminders', 'trigger_morning_digest'],
  webhooks:   ['get_recent_webhooks', 'create_custom_webhook', 'list_custom_webhooks', 'toggle_custom_webhook', 'get_custom_webhook_logs'],
  usage:      ['get_token_usage', 'set_monthly_budget', 'refresh_pricing_catalog'],
  buzz:       ['buzz_send_message', 'buzz_status'],
};

/**
 * Herramientas que el canal A2A PUEDE ofrecer (se configuran en
 * config/channels.json → a2a.disponibles).
 *
 * Es el techo del canal, no el permiso de cada token: todas se montan en el
 * agente público y cada invocación se valida contra el alcance del token que
 * llamó (ver src/agents/a2a_guard.ts). Así un token puede tener acceso a algo
 * que otro no, sin construir un agente distinto por cada uno.
 */
export const TOOLS_DISPONIBLES_A2A_POR_DEFECTO = [
  'knowledge_public',
  'faq_agent',
  'triage_agent',
];

/** Nombres de todas las herramientas del catálogo */
export function allToolNames(): string[] {
  return Object.keys(TOOL_CATALOG);
}

/**
 * Expande una especificación de config a nombres concretos de herramientas.
 * Admite: "*" (todo), nombres de grupo y nombres de herramienta.
 */
export function expandToolSpec(spec: string[]): string[] {
  const out = new Set<string>();

  for (const raw of spec || []) {
    const item = String(raw).trim();
    if (!item) continue;

    if (item === '*') {
      allToolNames().forEach((n) => out.add(n));
      continue;
    }
    if (TOOL_GROUPS[item]) {
      TOOL_GROUPS[item].forEach((n) => out.add(n));
      continue;
    }
    if (TOOL_CATALOG[item]) {
      out.add(item);
      continue;
    }
    console.warn(`⚠️ [ToolCatalog] "${item}" no es una herramienta ni un grupo conocido: se ignora.`);
  }

  return [...out];
}

/** Instancias de herramientas a partir de la especificación */
export function resolveTools(spec: string[]): any[] {
  return expandToolSpec(spec).map((name) => TOOL_CATALOG[name]).filter(Boolean);
}

/** Etiquetas legibles para los grupos, en el orden en que se muestran en la GUI. */
export const TOOL_GROUP_LABELS: Record<string, string> = {
  publico:   'Conocimiento público',
  knowledge: 'Conocimiento y memoria',
  workspace: 'Google Workspace',
  triage:    'Escalamiento',
  reminders: 'Recordatorios y digest',
  webhooks:  'Webhooks',
  usage:     'Consumo y presupuesto',
  buzz:      'Buzz / Nostr',
};

/** Primer grupo (según el orden de TOOL_GROUP_LABELS) al que pertenece la herramienta. */
export function grupoDeTool(tool: string): { grupo: string; etiqueta: string } {
  for (const g of Object.keys(TOOL_GROUP_LABELS)) {
    if ((TOOL_GROUPS[g] || []).includes(tool)) return { grupo: g, etiqueta: TOOL_GROUP_LABELS[g] };
  }
  return { grupo: 'otros', etiqueta: 'Otros' };
}
