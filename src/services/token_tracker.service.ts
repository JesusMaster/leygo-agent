import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { sqliteReminderService, UsageRecord } from '../database/sqlite.service.js';
import { telegramBotService } from './telegram_bot.service.js';
import { messageFormatter } from '../utils/message_formatter.js';

dotenv.config();

const LITELLM_PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 día: LiteLLM agrega los modelos nuevos el mismo día
const CONFIG_OVERRIDES = 'llm.prices';

/** De dónde salió el precio. 'familia' y 'default' son aproximados. */
export type PriceSource = 'override' | 'catalogo' | 'local' | 'familia' | 'default';

export interface ModelPrices {
  inputPricePer1M: number;
  outputPricePer1M: number;
  /** Tokens de entrada leídos desde caché (Gemini/OpenAI/Anthropic): ~10 % del input. Si falta, se cobran como input. */
  cachedPricePer1M?: number;
  /** Modelos de generación de imágenes: precio por imagen producida (LiteLLM output_cost_per_image) */
  imagePriceEach?: number;
  source: PriceSource;
  /** Clave del catálogo con la que calzó (o el modelo en overrides) */
  key?: string;
}

export interface PriceOverride { inputPricePer1M: number; outputPricePer1M: number; cachedPricePer1M?: number; }

/** Prefijos con los que LiteLLM publica cada proveedor (los presets de llm_settings) */
const PREFIJOS_LITELLM: Record<string, string[]> = {
  gemini: ['gemini/', ''],
  google: ['gemini/', ''],
  openai: ['', 'openai/'],
  anthropic: ['', 'anthropic/'],
  xai: ['xai/', ''],
  moonshot: ['moonshot/', ''],
  'moonshot-kimi': ['moonshot/', ''],
  deepseek: ['deepseek/', ''],
  groq: ['groq/', ''],
  mistral: ['mistral/', ''],
  openrouter: ['openrouter/', ''],
};

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
  private overrides: Map<string, PriceOverride> | null = null;
  private catalogoMtime = 0;

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

    // 2. Verificar si está vencido (> 1 día) o no existe, para descargarlo silenciosamente,
    //    y volver a mirar cada 6 h mientras el proceso viva.
    this.checkAndUpdatePricingInBackground();
    const timer = setInterval(() => this.checkAndUpdatePricingInBackground().catch(() => {}), 6 * 60 * 60 * 1000);
    (timer as any).unref?.();
  }

  /** Fecha del catálogo local y cuántos modelos tiene (para la GUI). */
  public catalogInfo(): { modelos: number; actualizado: string | null } {
    return { modelos: this.memoryPricingCache.size, actualizado: this.catalogoMtime ? new Date(this.catalogoMtime).toISOString() : null };
  }

  // ─── Overrides manuales (system_config: llm.prices) ─────────────────────
  private leerOverrides(): Map<string, PriceOverride> {
    if (this.overrides) return this.overrides;
    const mapa = new Map<string, PriceOverride>();
    try {
      const raw = sqliteReminderService.getConfig(CONFIG_OVERRIDES, '');
      if (raw) for (const [k, v] of Object.entries<any>(JSON.parse(raw))) {
        if (v && typeof v === 'object') mapa.set(k.toLowerCase(), { inputPricePer1M: Number(v.inputPricePer1M) || 0, outputPricePer1M: Number(v.outputPricePer1M) || 0, ...(v.cachedPricePer1M != null ? { cachedPricePer1M: Number(v.cachedPricePer1M) || 0 } : {}) });
      }
    } catch (err: any) {
      console.warn('⚠️ [TokenTracker] llm.prices inválido:', err.message);
    }
    this.overrides = mapa;
    return mapa;
  }

  public listOverrides(): Record<string, PriceOverride> {
    return Object.fromEntries(this.leerOverrides());
  }

  /** Fija (o borra, con null) el precio manual de un modelo. Manda sobre el catálogo. */
  public setOverride(model: string, precio: PriceOverride | null): void {
    const mapa = this.leerOverrides();
    const k = (model || '').toLowerCase().trim();
    if (!k) throw new Error('Modelo vacío');
    if (precio) {
      if (!(precio.inputPricePer1M >= 0) || !(precio.outputPricePer1M >= 0)) throw new Error('Precios inválidos');
      mapa.set(k, precio);
    } else mapa.delete(k);
    sqliteReminderService.setConfig(CONFIG_OVERRIDES, JSON.stringify(Object.fromEntries(mapa)));
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
          const cached = val.cache_read_input_token_cost != null ? (val.cache_read_input_token_cost || 0) * 1_000_000 : undefined;
          const porImagen = typeof val.output_cost_per_image === 'number' ? val.output_cost_per_image : undefined;
          this.memoryPricingCache.set(key.toLowerCase(), {
            inputPricePer1M: inputCost,
            outputPricePer1M: outputCost,
            ...(cached != null ? { cachedPricePer1M: cached } : {}),
            ...(porImagen != null ? { imagePriceEach: porImagen } : {}),
            source: 'catalogo',
            key: key.toLowerCase(),
          });
        }
      }
      try { this.catalogoMtime = fs.statSync(this.jsonPath).mtimeMs; } catch { /* sin fecha */ }
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
    const cero = (source: PriceSource): ModelPrices => ({ inputPricePer1M: 0, outputPricePer1M: 0, cachedPricePer1M: 0, source });

    // 0. Override manual (mandan sobre todo): se acepta con o sin prefijo de proveedor
    const ov = this.leerOverrides();
    const sinPrefijo = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
    for (const k of [raw, sinPrefijo]) {
      const o = ov.get(k);
      if (o) return { ...o, source: 'override', key: k };
    }

    // 1. Modelos locales / Ollama siempre tienen costo $0.00
    if (
      raw.startsWith('ollama/') ||
      raw.includes('ollama') ||
      raw.startsWith('gemma') ||
      raw.startsWith('llama') ||
      raw.startsWith('qwen') ||
      raw.startsWith('deepseek-r1') ||
      raw.includes(':latest')
    ) {
      return cero('local');
    }

    // 2. Catálogo LiteLLM: "<preset>/<modelo>" → probar los prefijos con que LiteLLM publica ese proveedor,
    //    luego el nombre pelado (y por sufijo, para "models/…", versiones con fecha, etc.)
    const cleanKey = raw.replace(/^models\//, '').trim();
    const barra = cleanKey.indexOf('/');
    const preset = barra > 0 ? cleanKey.slice(0, barra) : '';
    const modelo = barra > 0 ? cleanKey.slice(barra + 1) : cleanKey;
    const candidatos: string[] = [];
    if (preset) {
      for (const pre of PREFIJOS_LITELLM[preset] || [`${preset}/`, '']) candidatos.push(`${pre}${modelo}`);
      candidatos.push(cleanKey);
    } else {
      candidatos.push(modelo, `gemini/${modelo}`, `openai/${modelo}`, `anthropic/${modelo}`);
    }
    for (const c of candidatos) {
      const hit = this.memoryPricingCache.get(c);
      if (hit) return hit;
    }
    // Sufijos: "gemini-3.8-flash-001" ↔ "gemini/gemini-3.8-flash", etc. Se prefiere la clave más corta.
    let mejor: ModelPrices | null = null;
    for (const [key, prices] of this.memoryPricingCache.entries()) {
      const k = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
      if (k === modelo || modelo.startsWith(`${k}-`) || k.startsWith(`${modelo}-`)) {
        if (!mejor || (mejor.key || '').length > key.length) mejor = prices;
      }
    }
    if (mejor) return mejor;

    // 3. Fallbacks por familia (aproximados). OJO CON EL ORDEN: las variantes 'flash' se
    //    evalúan ANTES que el genérico 'gemini-3', si no un flash termina tarifado como Pro.
    const familia = (i: number, o: number, c?: number): ModelPrices => ({ inputPricePer1M: i, outputPricePer1M: o, ...(c != null ? { cachedPricePer1M: c } : {}), source: 'familia', key: modelo });
    if (modelo.includes('flash-lite'))                          return familia(0.30, 2.50, 0.03);
    if (modelo.includes('gemini-3') && modelo.includes('flash')) return familia(0.75, 3.75, 0.075);
    if (modelo.includes('gemini-2.5-flash'))                    return familia(0.30, 2.50, 0.03);
    if (modelo.includes('gemini-2.0-flash'))                    return familia(0.15, 0.60);
    if (modelo.includes('gemini-2.5-pro') || modelo.includes('gemini-3')) return familia(2.50, 10.00, 0.25);
    if (modelo.includes('gemini-1.5-flash'))                    return familia(0.075, 0.30);
    if (modelo.includes('gemini-1.5-pro'))                      return familia(1.25, 5.00);
    if (modelo.includes('kimi') || modelo.includes('moonshot')) return familia(0.95, 4.00, 0.16);
    if (modelo.includes('gpt-4o-mini') || /gpt-\d(\.\d+)?-mini/.test(modelo)) return familia(0.25, 2.00, 0.025);
    if (modelo.includes('gpt-4o') || /^gpt-\d/.test(modelo))   return familia(2.50, 10.00, 0.25);
    if (modelo.includes('claude') && modelo.includes('haiku'))  return familia(1.00, 5.00, 0.10);
    if (modelo.includes('claude') && modelo.includes('opus'))   return familia(15.00, 75.00, 1.50);
    if (modelo.includes('claude'))                              return familia(3.00, 15.00, 0.30);
    if (modelo.includes('grok'))                                return familia(3.00, 15.00, 0.75);
    if (modelo.includes('deepseek'))                            return familia(0.28, 0.42, 0.028);
    if (modelo.includes('gemini'))                              return familia(0.15, 0.60);

    // 4. Default conservador para modelos cloud desconocidos (se avisa una sola vez por modelo)
    if (!this.warnedUnknownModels.has(cleanKey)) {
      this.warnedUnknownModels.add(cleanKey);
      console.warn(`⚠️ [TokenTracker] Modelo "${modelId}" sin precio en el catálogo ni en los fallbacks: se tarifa con el default 0.15/0.60 (aproximado). Fíjale un precio en Consumo → Precios.`);
    }
    return { inputPricePer1M: 0.15, outputPricePer1M: 0.60, source: 'default', key: cleanKey };
  }

  /** Costo en USD de una llamada. Los tokens cacheados se descuentan del input y se cobran a su tarifa. */
  public costFor(model: string, inputTokens: number, outputTokens: number, cachedTokens = 0, images = 0): { costUsd: number; prices: ModelPrices } {
    const prices = this.getPrices(model);
    const cached = Math.min(Math.max(0, cachedTokens || 0), Math.max(0, inputTokens || 0));
    const inputNormal = Math.max(0, (inputTokens || 0) - cached);
    const tarifaCache = prices.cachedPricePer1M != null ? prices.cachedPricePer1M : prices.inputPricePer1M;
    // Imágenes generadas: se cobran por unidad (LiteLLM output_cost_per_image); los tokens de salida
    // que la API reporta por la imagen (~1.3k por imagen) se descuentan para no cobrarlos dos veces.
    const nImg = Math.max(0, images || 0);
    const outTokens = Math.max(0, (outputTokens || 0) - (nImg && prices.imagePriceEach ? nImg * 1290 : 0));
    const costUsd = (inputNormal / 1_000_000) * prices.inputPricePer1M
      + (cached / 1_000_000) * tarifaCache
      + (outTokens / 1_000_000) * prices.outputPricePer1M
      + nImg * (prices.imagePriceEach || 0);
    return { costUsd, prices };
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
    agent: string = 'system',
    extra: { cachedTokens?: number; thoughtsTokens?: number; llamadas?: number; pasos?: string[]; images?: number } = {}
  ): Promise<UsageRecord> {
    const inTokens = Math.max(0, inputTokens || 0);
    const outTokens = Math.max(0, outputTokens || 0);
    const cachedTokens = Math.max(0, extra.cachedTokens || 0);
    const thoughtsTokens = Math.max(0, extra.thoughtsTokens || 0);
    const images = Math.max(0, extra.images || 0);
    const { costUsd: totalCost, prices } = this.costFor(model, inTokens, outTokens, cachedTokens, images);

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
      cached_tokens: cachedTokens,
      thoughts_tokens: thoughtsTokens,
      price_source: prices.source,
      calls: Math.max(1, extra.llamadas || 1),
      images,
      steps: extra.pasos?.length ? JSON.stringify(extra.pasos.slice(0, 60)) : null,
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
  /**
   * Serie diaria (zona horaria del scheduler) de los últimos `dias` días + indicadores del mes:
   * proyección a fin de mes, gasto de hoy, costo por turno y ahorro por caché de prompt.
   */
  public getDailyUsage(dias = 30) {
    const tz = process.env.SCHEDULER_TZ || 'America/Santiago';
    const diaDe = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tz });
    const hoy = diaDe(new Date());
    const inicioSerie = new Date(Date.now() - (dias + 1) * 86400000);
    const monthStart = this.getMonthStartIso();
    const desde = new Date(Math.min(inicioSerie.getTime(), new Date(monthStart).getTime())).toISOString();
    const filas = sqliteReminderService.listUsageRows(desde);

    const serie = new Map<string, { dia: string; costo: number; tokens: number; turnos: Set<string> }>();
    for (let i = dias - 1; i >= 0; i--) { const d = diaDe(new Date(Date.now() - i * 86400000)); serie.set(d, { dia: d, costo: 0, tokens: 0, turnos: new Set() }); }
    const mesActual = hoy.slice(0, 7);
    let mesCosto = 0, mesTokensIn = 0, mesCached = 0, ahorro = 0;
    const turnosMes = new Set<string>();
    const turnosHoy = new Set<string>();
    let hoyCosto = 0;
    const precios = new Map<string, ModelPrices>();
    for (const f of filas) {
      const d = diaDe(new Date(f.timestamp));
      const turno = `${f.thread_id}|${f.user_input}|${f.timestamp.slice(0, 16)}`;
      const s = serie.get(d);
      if (s) { s.costo += f.cost_usd; s.tokens += f.input_tokens + f.output_tokens; s.turnos.add(turno); }
      if (d.slice(0, 7) === mesActual) {
        mesCosto += f.cost_usd; mesTokensIn += f.input_tokens; mesCached += f.cached_tokens; turnosMes.add(turno);
        if (f.cached_tokens) {
          if (!precios.has(f.model)) precios.set(f.model, this.getPrices(f.model));
          const p = precios.get(f.model)!;
          if (p.cachedPricePer1M != null) ahorro += (f.cached_tokens / 1e6) * Math.max(0, p.inputPricePer1M - p.cachedPricePer1M);
        }
      }
      if (d === hoy) { hoyCosto += f.cost_usd; turnosHoy.add(turno); }
    }
    const [y, m, dd] = hoy.split('-').map(Number);
    const diasMes = new Date(y, m, 0).getDate();
    // Días transcurridos: hoy cuenta como fracción según la hora, para no inflar la proyección de madrugada.
    const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const transcurridos = Math.max(0.25, dd - 1 + (ahora.getHours() * 60 + ahora.getMinutes()) / 1440);
    const promedio = mesCosto / transcurridos;
    const budget = this.getBudgetStatus().budget;
    return {
      dias: [...serie.values()].map((s) => ({ dia: s.dia, costo: s.costo, tokens: s.tokens, turnos: s.turnos.size })),
      hoy: { dia: hoy, costo: hoyCosto, turnos: turnosHoy.size },
      mes: {
        costo: mesCosto, presupuesto: budget, diasMes, transcurridos,
        promedioDiario: promedio, proyeccion: promedio * diasMes,
        ritmoPresupuesto: budget > 0 ? budget / diasMes : 0,
        turnos: turnosMes.size, costoPorTurno: turnosMes.size ? mesCosto / turnosMes.size : 0,
        cacheRatio: mesTokensIn ? mesCached / mesTokensIn : 0, ahorroCache: ahorro,
      },
    };
  }

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

    // Precio vigente y fuente por modelo, para que la GUI marque los aproximados
    const byModelConPrecio = byModel.map((m) => {
      const p = this.getPrices(m.model);
      return { ...m, price: { input: p.inputPricePer1M, output: p.outputPricePer1M, cached: p.cachedPricePer1M ?? null, source: p.source, key: p.key || null } };
    });

    return {
      allHistory,
      catalogo: this.catalogInfo(),
      totalCost: totalMonthCost,
      totalTokens: tokenTotals.totalTokens,
      inputTokens: tokenTotals.inputTokens,
      outputTokens: tokenTotals.outputTokens,
      monthlyBudget: budgetStatus.budget,
      percentUsed: budgetStatus.percentUsed,
      isExceeded: budgetStatus.isExceeded,
      byModel: byModelConPrecio,
      byAgent,
      byChannel,
      channelBudgets,
    };
  }

  /**
   * Vuelve a calcular cost_usd de las filas desde `sinceIso` con los precios vigentes
   * (catálogo nuevo, override manual). Las filas antiguas sin cached_tokens se tarifan
   * sin caché (levemente por encima del real).
   */
  public reprice(sinceIso: string): { filas: number; antes: number; despues: number } {
    const filas = sqliteReminderService.listUsageSince(sinceIso);
    let antes = 0, despues = 0;
    for (const f of filas) {
      const { costUsd, prices } = this.costFor(f.model, f.input_tokens, f.output_tokens, f.cached_tokens, f.images);
      antes += f.cost_usd || 0;
      despues += costUsd;
      const nuevo = parseFloat(costUsd.toFixed(6));
      if (nuevo !== f.cost_usd) sqliteReminderService.updateUsageCost(f.id, nuevo, prices.source);
      else sqliteReminderService.updateUsageCost(f.id, f.cost_usd, prices.source);
    }
    console.log(`💲 [TokenTracker] Retarifadas ${filas.length} filas desde ${sinceIso}: $${antes.toFixed(4)} → $${despues.toFixed(4)}`);
    return { filas: filas.length, antes, despues };
  }

  /**
   * Tabla de precios: modelos usados en los últimos 90 días + overrides, con el
   * precio que se les aplica hoy y de dónde sale (para Consumo → Precios).
   */
  public listPrices(): Array<{ model: string; input: number; output: number; cached: number | null; imagen: number | null; source: PriceSource; key: string | null; override: PriceOverride | null }> {
    const desde = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const usados = sqliteReminderService.getUsageByModel(desde).map((r) => r.model);
    const modelos = new Set<string>([...usados, ...this.leerOverrides().keys()]);
    const ov = this.leerOverrides();
    return [...modelos].filter(Boolean).sort().map((model) => {
      const p = this.getPrices(model);
      const k = model.toLowerCase();
      const sinPrefijo = k.includes('/') ? k.slice(k.lastIndexOf('/') + 1) : k;
      return { model, input: p.inputPricePer1M, output: p.outputPricePer1M, cached: p.cachedPricePer1M ?? null, imagen: p.imagePriceEach ?? null, source: p.source, key: p.key || null, override: ov.get(k) || ov.get(sinPrefijo) || null };
    });
  }
}

export const tokenTrackerService = new TokenTrackerService();
