import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { tokenTrackerService, USAGE_CHANNELS, UsageChannel } from "../../services/token_tracker.service.js";

/**
 * Herramienta para consultar el consumo de tokens y presupuesto
 */
export const getTokenUsageTool = new FunctionTool({
  name: 'get_token_usage',
  description: 'Consulta el consumo de tokens, el gasto acumulado en USD en el mes actual para los modelos de IA (Gemini y Ollama), y el estado del presupuesto mensual.',
  parameters: z.object({}) as any,
  execute: async () => {
    try {
      const summary = tokenTrackerService.getUsageSummary(50);
      const { currentCost, budget, percentUsed, isExceeded } = tokenTrackerService.getBudgetStatus();

      const canalLabel: Record<string, string> = {
        telegram: '📱 Telegram', buzz: '⚡ Buzz', a2a: '🔌 A2A', api: '🌐 API', system: '⚙️ Sistema', unknown: '❔ Sin clasificar',
      };

      const byChannelStr = summary.byChannel.length > 0
        ? summary.byChannel.map((c: any) => {
            const st = summary.channelBudgets.find((b: any) => b.channel === c.channel);
            const tope = st && st.budget > 0 ? ` / $${st.budget.toFixed(2)} (${st.percentUsed}%)` : ' (sin tope propio)';
            return `  • ${canalLabel[c.channel] || c.channel}: ${c.count} llamadas | $${c.total_cost.toFixed(4)} USD${tope}`;
          }).join('\n')
        : '  (Sin registros este mes)';

      const byAgentStr = summary.byAgent.length > 0
        ? summary.byAgent.map((a: any) =>
            `  • **${a.agent}** (${a.model}): ${a.count} llamadas | ${(a.input_tokens + a.output_tokens).toLocaleString()} tokens | $${a.total_cost.toFixed(4)} USD`
          ).join('\n')
        : '  (Sin registros este mes)';

      const byModelStr = summary.byModel.length > 0
        ? summary.byModel.map(m => `  • **${m.model}**: ${m.count} llamadas | ${(m.input_tokens + m.output_tokens).toLocaleString()} tokens | $${m.total_cost.toFixed(4)} USD`).join('\n')
        : '  (Sin registros este mes)';

      const estadoPresupuesto = isExceeded
        ? '🚨 **¡PRESUPUESTO EXCEDIDO!**'
        : percentUsed >= 80
        ? '⚠️ **Cerca del límite (≥80%)**'
        : '✅ **Dentro del presupuesto**';

      const result = `📊 **Reporte de Consumo de Tokens (Mes en curso)**\n\n` +
        `• **Gasto Total Acumulado:** $${currentCost.toFixed(4)} USD\n` +
        `• **Presupuesto Mensual:** $${budget.toFixed(2)} USD (${percentUsed}% usado)\n` +
        `• **Estado:** ${estadoPresupuesto}\n` +
        `• **Tokens Totales:** ${summary.totalTokens.toLocaleString()} (Entrada: ${summary.inputTokens.toLocaleString()} | Salida: ${summary.outputTokens.toLocaleString()})\n\n` +
        `📡 **Desglose por Canal:**\n${byChannelStr}\n\n` +
        `🤖 **Desglose por Agente:**\n${byAgentStr}\n\n` +
        `📈 **Desglose por Modelo:**\n${byModelStr}`;

      return {
        status: 'success',
        result,
        data: {
          currentCost,
          budget,
          percentUsed,
          totalTokens: summary.totalTokens,
          byModel: summary.byModel,
          byAgent: summary.byAgent,
          byChannel: summary.byChannel,
          channelBudgets: summary.channelBudgets,
        },
      };
    } catch (err: any) {
      return {
        status: 'error',
        message: `Error al consultar el consumo de tokens: ${err.message}`,
      };
    }
  },
});

/**
 * Herramienta para cambiar el presupuesto mensual
 */
export const setMonthlyBudgetTool = new FunctionTool({
  name: 'set_monthly_budget',
  description: 'Ajusta el límite de presupuesto mensual en USD. Sin canal ajusta el presupuesto GLOBAL; con canal (telegram, buzz, a2a, api, system) ajusta solo el tope de ese canal. Usar 0 en un canal le quita su tope propio.',
  parameters: z.object({
    budgetUsd: z.number().describe('Nuevo valor del presupuesto mensual en dólares (USD), por ejemplo: 5.0, 3.0, 2.0. Usar 0 con un canal para quitarle su tope propio.'),
    channel: z.enum(['telegram', 'buzz', 'a2a', 'api', 'system']).optional().describe('Canal al que aplica el tope. Si se omite, se ajusta el presupuesto global.')
  }) as any,
  execute: async (args: any) => {
    try {
      const { budgetUsd, channel } = args as { budgetUsd: number; channel?: UsageChannel };
      if (budgetUsd < 0 || (budgetUsd === 0 && !channel)) {
        return {
          status: 'error',
          message: 'El presupuesto global debe ser mayor a 0. Solo un canal puede quedar en 0 (sin tope propio).',
        };
      }

      tokenTrackerService.setMonthlyBudget(budgetUsd, channel);
      const status = tokenTrackerService.getBudgetStatus(channel);
      const alcance = channel ? `del canal **${channel}**` : '**global**';

      if (channel && budgetUsd === 0) {
        return {
          status: 'success',
          result: `✅ El canal **${channel}** quedó sin tope propio: ahora solo responde al presupuesto global.`,
          budget: 0,
        };
      }

      const globalStatus = tokenTrackerService.getBudgetStatus();
      const sumaCanales = Object.values(tokenTrackerService.getChannelBudgets()).reduce((a, b) => a + b, 0);
      const aviso = sumaCanales > globalStatus.budget
        ? `\n\n⚠️ Ojo: los topes por canal suman $${sumaCanales.toFixed(2)} USD, más que el global de $${globalStatus.budget.toFixed(2)}. El global corta primero.`
        : '';

      return {
        status: 'success',
        result: `✅ Presupuesto ${alcance} actualizado a **$${status.budget.toFixed(2)} USD**.\n• Consumo actual del mes: $${status.currentCost.toFixed(4)} USD (${status.percentUsed}% consumido).${aviso}`,
        budget: status.budget,
      };
    } catch (err: any) {
      return {
        status: 'error',
        message: `Error al actualizar presupuesto: ${err.message}`,
      };
    }
  },
});

/**
 * Herramienta para forzar actualización de precios LiteLLM
 */
export const refreshPricingCatalogTool = new FunctionTool({
  name: 'refresh_pricing_catalog',
  description: 'Fuerza la actualización inmediata del catálogo comunitario de precios de LiteLLM desde GitHub.',
  parameters: z.object({}) as any,
  execute: async () => {
    try {
      const updated = await tokenTrackerService.checkAndUpdatePricingInBackground(true);
      return {
        status: 'success',
        result: updated 
          ? '✅ Catálogo de precios de LiteLLM descargado y actualizado con éxito.' 
          : 'ℹ️ El catálogo de precios ya se encuentra en su versión más reciente.',
      };
    } catch (err: any) {
      return {
        status: 'error',
        message: `Error al actualizar catálogo de precios: ${err.message}`,
      };
    }
  },
});
