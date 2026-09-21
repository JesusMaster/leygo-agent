import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { sqliteReminderService, UsageRecord } from '../database/sqlite.service.js';
import { telegramBotService } from './telegram_bot.service.js';
import { messageFormatter } from '../utils/message_formatter.js';

dotenv.config();

const LITELLM_PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

export interface ModelPrices {
  inputPricePer1M: number;
  outputPricePer1M: number;
}

/** Canales desde los que se consume IA. Cada uno puede tener su propio presupuesto. */
export type UsageChannel = 'telegram' | 'buzz' | 'a2a' | 'api' | 'system';

export const USAGE_CHANNELS: UsageChannel[] = ['telegram', 'buzz', 'a2a', 'api', 'system'];

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  cachedTokens: number;
}

export interface BudgetStatus {
  channel: UsageChannel | 'global';
  currentCost: number;
  budget: number;
  percentUsed: number;
  isExceeded: boolean;
  isNearLimit: boolean;
}

export class TokenTrackerService {
  private jsonPath: string;
  private memoryPricingCache: Map<string, ModelPrices> = new Map();
  private isUpdatingPricing: boolean = false;
  private warnedUnknownModels: Set<string> = new Set();

  constructor() {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.jsonPath = path.join(dataDir, 'litellm_cost.json');
    this.initPricing();
  }

  /**
   * Carga inicial de precios en memoria y verifica si requiere actualización en segundo plano
   */
  private async initPricing(): Promise<void> {
    // 1. Cargar archivo local existente en memoria
    this.loadJsonToMemory();

    // 2. Verificar si está vencido (> 7 días) o no existe, para descargarlo silenciosamente
    this.checkAndUpdatePricingInBackground();
  }

  /**
   * Carga el JSON local a la memoria RAM para consultas ultra rápidas O(1)
   */
  private loadJsonToMemory(): void {
    if (!fs.existsSync(this.jsonPath)) return;
    try {
      const raw = fs.readFileSync(this.jsonPath, 'utf8');
      const data = JSON.parse(raw);
      this.memoryPricingCache.clear();

      for (const [key, val] of Object.entries<any>(data)) {
        if (!val || typeof val !== 'object') continue;
        const inputCost = (val.input_cost_per_token || 0) * 1_000_000;
        const outputCost = (val.output_cost_per_token || 0) * 1_000_000;
        if (inputCost > 0 || outputCost > 0) {
          this.memoryPricingCache.set(key.toLowerCase(), {
            inputPricePer1M: inputCost,
            outputPricePer1M: outputCost,
          });
        }
      }
      console.log(`📊 [TokenTracker] Precios cargados en memoria: ${this.memoryPricingCache.size} modelos registrados.`);
    } catch (err: any) {
      console.warn('⚠️ [TokenTracker] Error al parsear litellm_cost.json local:', err.message);
    }
  }

  /**
   * Descarga la última versión de precios desde GitHub en segundo plano si tiene más de 7 días
   */
  public async checkAndUpdatePricingInBackground(force: boolean = false): Promise<boolean> {
    if (this.isUpdatingPricing) return false;

    let needsDownload = force;
    if (!needsDownload) {
      if (!fs.existsSync(this.jsonPath)) {
        needsDownload = true;
      } else {
        try {
          const stats = fs.statSync(this.jsonPath);
          const ageMs = Date.now() - stats.mtimeMs;
          if (ageMs > CACHE_MAX_AGE_MS) {
            needsDownload = true;
          }
        } catch {
          needsDownload = true;
        }
      }
    }

    if (!needsDownload) return false;

    this.isUpdatingPricing = true;
    try {
      console.log('🌐 [TokenTracker] Actualizando catálogo de precios desde LiteLLM...');
      const res = await axios.get(LITELLM_PRICING_URL, {
        timeout: 15000,
        headers: { 'User-Agent': 'YisusAgent/1.0' },
      });

      if (res.data && typeof res.data === 'object') {
        fs.writeFileSync(this.jsonPath, JSON.stringify(res.data, null, 2), 'utf8');
        this.loadJsonToMemory();
        console.log('✅ [TokenTracker] Catálogo litellm_cost.json actualizado con éxito.');
        return true;
      }
    } catch (err: any) {
      console.warn('⚠️ [TokenTracker] No se pudo descargar actualización de LiteLLM (usando caché local):', err.message);
    } finally {
      this.isUpdatingPricing = false;
    }
    return false;
  }

  /**
   * Obtiene los precios de entrada y salida por cada 1 millón de tokens para un modelo dado
   */
  public getPrices(modelId: string = ''): ModelPrices {
    const raw = (modelId || '').toLowerCase().trim();

    // 1. Modelos locales / Ollama siempre tienen costo $0.00
    if (
      raw.includes('ollama') ||
      raw.startsWith('gemma') ||
      raw.startsWith('llama') ||
      raw.startsWith('mistral') ||
      raw.startsWith('qwen') ||
      raw.startsWith('deepseek-r1') ||
      raw.includes(':latest')
    ) {
      return { inputPricePer1M: 0.0, outputPricePer1M: 0.0 };
    }

    // 2. Normalizar clave para búsqueda en LiteLLM
    const cleanKey = raw
      .replace(/^models\//, '')
      .replace(/^(google\/|openai\/|anthropic\/)/, '')
      .trim();

    // 3. Buscar en el mapa en memoria de LiteLLM
    if (this.memoryPricingCache.has(cleanKey)) {
      return this.memoryPricingCache.get(cleanKey)!;
    }

    // Probar variaciones comunes (ej: gemini-2.5-flash vs gemini/gemini-2.5-flash)
    for (const [key, prices] of this.memoryPricingCache.entries()) {
      if (key === cleanKey || key.endsWith(`/${cleanKey}`) || cleanKey.endsWith(`/${key}`)) {
        return prices;
      }
    }

    // 4. Fallbacks estáticos. OJO CON EL ORDEN: las variantes 'flash' se evalúan
    // ANTES que el genérico 'gemini-3', si no un gemini-3.x-flash termina tarifado
    // como un Pro (2.50/10.00) y el costo se infla ~5x.
    if (cleanKey.includes('flash-lite')) {
      return { inputPricePer1M: 0.10, outputPricePer1M: 0.40 };
    }
    if (cleanKey.includes('gemini-3') && cleanKey.includes('flash')) {
      // Tarifa de la familia gemini-3.x flash (referencia: gemini-3.1-flash del catálogo)
      return { inputPricePer1M: 0.50, outputPricePer1M: 3.00 };
    }
    if (cleanKey.includes('gemini-2.5-flash')) {
      return { inputPricePer1M: 0.30, outputPricePer1M: 2.50 };
    }
    if (cleanKey.includes('gemini-2.0-flash')) {
      return { inputPricePer1M: 0.15, outputPricePer1M: 0.60 };
    }
    if (cleanKey.includes('gemini-2.5-pro') || cleanKey.includes('gemini-3')) {
      return { inputPricePer1M: 2.50, outputPricePer1M: 10.00 };
    }
    if (cleanKey.includes('gemini-1.5-flash')) {
      return { inputPricePer1M: 0.075, outputPricePer1M: 0.30 };
    }
    if (cleanKey.includes('gemini-1.5-pro')) {
      return { inputPricePer1M: 1.25, outputPricePer1M: 5.00 };
    }
    if (cleanKey.includes('gpt-4o-mini')) {
      return { inputPricePer1M: 0.15, outputPricePer1M: 0.60 };
    }
    if (cleanKey.includes('gpt-4o')) {
      return { inputPricePer1M: 2.50, outputPricePer1M: 10.00 };
    }
    if (cleanKey.includes('claude-3-5-sonnet') || cleanKey.includes('claude-sonnet')) {
      return { inputPricePer1M: 3.00, outputPricePer1M: 15.00 };
    }

    // Si es un modelo genérico de Gemini
    if (cleanKey.includes('gemini')) {
      return { inputPricePer1M: 0.15, outputPricePer1M: 0.60 };
    }

    // Default conservador para modelos cloud desconocidos (se avisa una sola vez por modelo)
    if (!this.warnedUnknownModels.has(cleanKey)) {
      this.warnedUnknownModels.add(cleanKey);
      console.warn(`⚠️ [TokenTracker] Modelo "${modelId}" sin precio en el catálogo ni en los fallbacks: se tarifa con el default 0.15/0.60 y el costo será aproximado.`);
    }
    return { inputPricePer1M: 0.15, outputPricePer1M: 0.60 };
  }

  /**
   * Normaliza el usageMetadata de Gemini/ADK.
   *
   * IMPORTANTE: 'candidatesTokenCount' NO incluye los tokens de razonamiento
   * ('thoughtsTokenCount'), que Google factura como tokens de SALIDA. Contar solo
   * candidates subestima el output de forma severa en modelos con thinking activo.
   * 'promptTokenCount' tampoco incluye 'toolUsePromptTokenCount'.
   */
  public extractUsage(meta: any): UsageBreakdown {
    return {
      inputTokens:   (meta?.promptTokenCount || 0) + (meta?.toolUsePromptTokenCount || 0),
      outputTokens:  (meta?.candidatesTokenCount || 0) + (meta?.thoughtsTokenCount || 0),
      thoughtsTokens: meta?.thoughtsTokenCount || 0,
      cachedTokens:   meta?.cachedContentTokenCount || 0,
    };
  }

  public emptyUsage(): UsageBreakdown {
    return { inputTokens: 0, outputTokens: 0, thoughtsTokens: 0, cachedTokens: 0 };
  }

  /** Acumula el usageMetadata de un evento sobre un acumulador de turno */
  public accumulateUsage(acc: UsageBreakdown, meta: any): UsageBreakdown {
    const u = this.extractUsage(meta);
    acc.inputTokens    += u.inputTokens;
    acc.outputTokens   += u.outputTokens;
    acc.thoughtsTokens += u.thoughtsTokens;
    acc.cachedTokens   += u.cachedTokens;
    return acc;
  }

  /**
   * Registra el uso de tokens y calcula el costo en dólares
   */
  public async logUsage(
    userInput: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    threadId: string = 'system',
    channel: UsageChannel = 'system',
    agent: string = 'system'
  ): Promise<UsageRecord> {
    const inTokens = Math.max(0, inputTokens || 0);
    const outTokens = Math.max(0, outputTokens || 0);
    const prices = this.getPrices(model);

    const inputCost = (inTokens / 1_000_000) * prices.inputPricePer1M;
    const outputCost = (outTokens / 1_000_000) * prices.outputPricePer1M;
    const totalCost = inputCost + outputCost;

    const timestamp = new Date().toISOString();
    const truncatedInput = (userInput || '').length > 150 
      ? userInput.substring(0, 150) + '...' 
      : (userInput || '');

    const record: Omit<UsageRecord, 'id'> = {
      timestamp,
      user_input: truncatedInput,
      model: model || 'unknown',
      input_tokens: inTokens,
      output_tokens: outTokens,
      cost_usd: parseFloat(totalCost.toFixed(6)),
      thread_id: threadId || 'system',
      channel,
      agent: agent || 'system',
    };

    const saved = sqliteReminderService.logTokenUsage(record);

    // Revisar si se alcanzó algún umbral presupuestario para notificar
    this.checkAndSendBudgetAlerts(channel).catch((err) => {
      console.warn('⚠️ [TokenTracker] Error verificando alertas de budget:', err.message);
    });

    return saved;
  }

  /**
   * Retorna la fecha ISO del primer día del mes actual (00:00:00 CLT)
   */
  public getMonthStartIso(): string {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return monthStart.toISOString();
  }

  /**
   * Obtiene el presupuesto mensual configurado en USD
   */
  private budgetKey(channel?: UsageChannel): string {
    return channel ? `monthly_budget_usd_${channel}` : 'monthly_budget_usd';
  }

  /**
   * Presupuesto mensual en USD. Sin canal devuelve el global.
   * Con canal devuelve el suyo, o 0 si no tiene uno configurado (0 = sin tope propio).
   */
  public getMonthlyBudget(channel?: UsageChannel): number {
    const fromDb = sqliteReminderService.getConfig(this.budgetKey(channel));
    if (fromDb && !isNaN(parseFloat(fromDb))) {
      return parseFloat(fromDb);
    }

    const envKey = channel ? `MONTHLY_BUDGET_USD_${channel.toUpperCase()}` : 'MONTHLY_BUDGET_USD';
    const fromEnv = process.env[envKey];
    if (fromEnv && !isNaN(parseFloat(fromEnv))) {
      return parseFloat(fromEnv);
    }

    return channel ? 0 : 5.0; // sin tope propio por canal / $5.00 global por defecto
  }

  /** Presupuestos configurados por canal (solo los que tienen tope propio) */
  public getChannelBudgets(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const ch of USAGE_CHANNELS) {
      const b = this.getMonthlyBudget(ch);
      if (b > 0) out[ch] = b;
    }
    return out;
  }

  /**
   * Modifica el presupuesto mensual en USD
   */
  public setMonthlyBudget(amountUsd: number, channel?: UsageChannel): void {
    // 0 en un canal = quitarle el tope propio (queda solo bajo el global)
    const safeAmount = channel && amountUsd === 0 ? 0 : Math.max(0.5, amountUsd);
    sqliteReminderService.setConfig(this.budgetKey(channel), safeAmount.toFixed(2));
  }

  /**
   * Obtiene el estado presupuestario actual del mes
   */
  public getBudgetStatus(channel?: UsageChannel): BudgetStatus {
    const monthStart = this.getMonthStartIso();
    const currentCost = sqliteReminderService.getCurrentMonthCost(monthStart, channel);
    const budget = this.getMonthlyBudget(channel);
    const percentUsed = budget > 0 ? (currentCost / budget) * 100 : 0;

    return {
      channel: channel || 'global',
      currentCost: parseFloat(currentCost.toFixed(4)),
      budget: parseFloat(budget.toFixed(2)),
      percentUsed: parseFloat(percentUsed.toFixed(1)),
      isExceeded: budget > 0 && currentCost >= budget,
      isNearLimit: budget > 0 && percentUsed >= 80,
    };
  }

  /** ¿El canal (o el global) ya superó su tope este mes? Útil para cortar consumo. */
  public isOverBudget(channel?: UsageChannel): boolean {
    const globalExceeded = this.getBudgetStatus().isExceeded;
    if (globalExceeded) return true;
    if (!channel) return false;
    return this.getBudgetStatus(channel).isExceeded;
  }

  /**
   * Verifica umbrales (80% y 100%) y notifica a Telegram de forma proactiva una sola vez por mes
   */
  private async checkAndSendBudgetAlerts(channel?: UsageChannel): Promise<void> {
    // Se revisa el tope del canal (si tiene uno propio) y siempre el global.
    const targets: Array<UsageChannel | undefined> = channel ? [channel, undefined] : [undefined];

    for (const target of targets) {
      const status = this.getBudgetStatus(target);
      if (status.budget <= 0) continue;

      const label = target ? `del canal ${target.toUpperCase()}` : 'GLOBAL';
      const scopeKey = target || 'global';
      const now = new Date();
      const yearMonth = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}`;

      if (status.isExceeded) {
        const flagKey = `budget_alert_100_${scopeKey}_${yearMonth}`;
        if (sqliteReminderService.getConfig(flagKey) === '1') continue;
        sqliteReminderService.setConfig(flagKey, '1');
        await telegramBotService.sendDirectMessage(
          `🚨 <b>PRESUPUESTO ${label} EXCEDIDO</b>\n\n` +
          `Has alcanzado el <b>${status.percentUsed}%</b> de la cuota mensual.\n` +
          `• <b>Gasto actual:</b> $${status.currentCost.toFixed(3)} USD\n` +
          `• <b>Límite mensual:</b> $${status.budget.toFixed(2)} USD\n\n` +
          `<i>Tip: puedes ampliarlo diciéndome "sube el presupuesto de ${scopeKey} a $10".</i>`,
          { parseMode: 'HTML' }
        );
        continue;
      }

      if (status.isNearLimit) {
        const flagKey = `budget_alert_80_${scopeKey}_${yearMonth}`;
        if (sqliteReminderService.getConfig(flagKey) === '1') continue;
        sqliteReminderService.setConfig(flagKey, '1');
        await telegramBotService.sendDirectMessage(
          `⚠️ <b>AVISO DE CONSUMO ${label} (80%)</b>\n\n` +
          `Has consumido el <b>${status.percentUsed}%</b> del presupuesto mensual.\n` +
          `• <b>Gasto actual:</b> $${status.currentCost.toFixed(3)} USD\n` +
          `• <b>Límite mensual:</b> $${status.budget.toFixed(2)} USD`,
          { parseMode: 'HTML' }
        );
      }
    }
  }

  /**
   * Resumen completo para el dashboard o API (compatible con Leygo GUI)
   */
  public getUsageSummary(limit: number = 1000) {
    const monthStart = this.getMonthStartIso();
    const allHistory = sqliteReminderService.getUsageHistory(limit);
    const totalMonthCost = sqliteReminderService.getCurrentMonthCost(monthStart);
    const tokenTotals = sqliteReminderService.getCurrentMonthTokens(monthStart);
    const byModel = sqliteReminderService.getUsageByModel(monthStart);
    const byChannel = sqliteReminderService.getUsageByChannel(monthStart);
    const byAgent = sqliteReminderService.getUsageByAgent(monthStart);
    const budgetStatus = this.getBudgetStatus();
    const channelBudgets = USAGE_CHANNELS
      .map((ch) => this.getBudgetStatus(ch))
      .filter((st) => st.budget > 0 || st.currentCost > 0);

    return {
      allHistory,
      totalCost: totalMonthCost,
      totalTokens: tokenTotals.totalTokens,
      inputTokens: tokenTotals.inputTokens,
      outputTokens: tokenTotals.outputTokens,
      monthlyBudget: budgetStatus.budget,
      percentUsed: budgetStatus.percentUsed,
      isExceeded: budgetStatus.isExceeded,
      byModel,
      byAgent,
      byChannel,
      channelBudgets,
    };
  }
}

export const tokenTrackerService = new TokenTrackerService();
