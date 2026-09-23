import { Relay, finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import WebSocket from 'ws';
import type { Runner } from '@google/adk';
import type { RedisSessionService } from './redis_session.service.js';
import { getRedisConnector } from '../database/redis.js';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { attachmentsService } from './attachments.service.js';
import { sufijoFechaMensaje } from '../utils/fecha.js';

dotenv.config();

const KEYS_FILE = path.resolve(process.cwd(), '.nostr_keys.json');

// ─── Parámetros de conexión ──────────────────────────────────────────────────
const CONNECT_TIMEOUT_MS   = 15000;  // si el socket no abre en 15s, se aborta y se reintenta
const AUTH_WAIT_MS         = 8000;   // margen para que el relay mande el desafío NIP-42
const RECONNECT_BASE_MS    = 2000;   // backoff exponencial 2s → 30s
const RECONNECT_MAX_MS     = 30000;
const WATCHDOG_MS          = 15000;  // cada cuánto se verifica que el relay siga vivo de verdad
const PROBE_TIMEOUT_MS     = 10000;  // deadline del REQ de prueba del watchdog
// El relay de Buzz NO empuja en vivo las respuestas de hilo (eventos p-gated): solo
// las entrega como eventos almacenados ante un REQ nuevo. Por eso la suscripción se
// re-emite periódicamente: ese intervalo es, en la práctica, la latencia máxima de
// respuesta dentro de un hilo.
const RESUBSCRIBE_MS       = Math.max(15, parseInt(process.env.NOSTR_RESUBSCRIBE_SECONDS || '30', 10)) * 1000;
const MAX_CATCHUP_SECONDS  = 3600;   // cuánto se puede retroceder para recuperar mensajes perdidos
const PENDING_REPLY_TTL_MS = 10 * 60 * 1000;
const PROFILE_REFRESH_MS   = 6 * 60 * 60 * 1000;
const SUMMARY_MS           = Math.max(60, parseInt(process.env.NOSTR_SUMMARY_SECONDS || '900', 10)) * 1000;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export interface NostrIdentity {
  secretKeyHex: string;
  secretKeyNsec: string;
  publicKeyHex: string;
  publicKeyNpub: string;
}

interface PendingReply {
  incoming: any;
  text: string;
  rootId: string;
  queuedAt: number;
}

export class NostrGatewayService {
  private relayUrl: string;
  private relay: Relay | null = null;
  private activeSubscription: any = null;
  private secretKey: Uint8Array;
  private publicKeyHex: string;
  private publicKeyNpub: string;
  private runner: Runner | null = null;
  private sessionService: RedisSessionService | null = null;
  private redisClient: any = null;
  private isRunning: boolean = false;
  private isConnecting: boolean = false;

  // Generaciones: invalidan callbacks de sockets/suscripciones viejas y evitan
  // que un cierre tardío dispare reconexiones en cadena.
  private relayGeneration: number = 0;
  private subGeneration: number = 0;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastSubscribedAt: number = 0;
  private lastStreamAt: number = 0; // último EVENT/EOSE recibido por la suscripción principal
  private lastGreenLogGen: number = -1; // generación de relay ya anunciada como "suscripción activa"
  private renewalCount: number = 0;
  private eventCount: number = 0;
  private lastSummaryAt: number = Date.now();
  private probeInFlight: boolean = false;
  private watchdogProbe: boolean = process.env.NOSTR_WATCHDOG_PROBE === 'true';

  // Checkpoint temporal para no perder mensajes durante caídas
  private checkpointTs: number = 0;

  // Respuestas que no se pudieron publicar porque el socket se cayó mientras el agente pensaba
  private pendingReplies: PendingReply[] = [];
  private profilePublishedAt: number = 0;

  // Caché en memoria (con persistencia secundaria en Redis)
  private seenEvents: Set<string> = new Set();
  private requireMention: boolean;
  private allowedPubkeys: Set<string> = new Set();
  private isWildcardAllowed: boolean = true;
  private myMessageIds: Set<string> = new Set();
  private activeThreadRoots: Set<string> = new Set();
  private channelIds: string[];
  private listenGlobal: boolean;
  private channelKinds: number[];
  private debugEvents: boolean;
  private debugFirehose: boolean;
  private threadFilter: boolean;

  // Control de tormenta: si el relay rechaza el REQ, no se puede resuscribir en bucle.
  private subAttemptTimes: number[] = [];

  // IDs de eventos (raíces de hilo + mensajes propios) que se siguen vía filtro '#e'.
  // Las respuestas dentro de un hilo de Buzz no siempre traen el tag 'h' del canal,
  // así que sin este filtro nunca llegan al cliente.
  private threadFilterIds: string[] = [];
  private resubscribeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.relayUrl = process.env.NOSTR_RELAY_URL || 'wss://apprecio.communities.buzz.xyz';
    this.requireMention = process.env.NOSTR_REQUIRE_MENTION !== 'false'; // default true

    this.channelIds = process.env.NOSTR_CHANNELS
      ? process.env.NOSTR_CHANNELS.split(',').map(c => c.trim()).filter(Boolean)
      : ['3ebb4231-e162-477e-ad68-bdc568c5d3d5'];

    // Firehose global (kinds 1 y 42 sin filtro de canal). Útil para depurar, caro en producción.
    this.listenGlobal = process.env.NOSTR_LISTEN_GLOBAL !== 'false';

    this.channelKinds = (process.env.NOSTR_KINDS || '9,11,1111,1,42')
      .split(',').map(k => parseInt(k.trim(), 10)).filter(n => !isNaN(n));

    // Diagnóstico: imprime los tags de cada evento y, opcionalmente, escucha todo el relay.
    this.debugEvents = process.env.NOSTR_DEBUG_EVENTS === 'true';
    this.debugFirehose = process.env.NOSTR_DEBUG_FIREHOSE === 'true';

    // Buzz rechaza cualquier REQ con '#e' que no venga acompañado de '#p' propio
    // ("restricted: p-gated events require #p matching your pubkey"), así que va apagado.
    this.threadFilter = process.env.NOSTR_THREAD_FILTER === 'true';

    // Cargar o inicializar lista de pubkeys autorizadas (groupAllowFrom)
    const rawAllowed = process.env.NOSTR_ALLOWED_PUBKEYS || '*';
    if (rawAllowed.trim() === '*' || rawAllowed.trim() === '') {
      this.isWildcardAllowed = true;
    } else {
      this.isWildcardAllowed = false;
      rawAllowed.split(',').map(k => k.trim()).filter(Boolean).forEach(k => {
        if (k.startsWith('npub1')) {
          try {
            const decoded = nip19.decode(k);
            if (decoded.type === 'npub') this.allowedPubkeys.add(decoded.data as string);
          } catch {
            this.allowedPubkeys.add(k);
          }
        } else {
          this.allowedPubkeys.add(k);
        }
      });
    }

    // Cargar o generar identidad Nostr (clave privada/pública)
    const identity = this.loadOrGenerateIdentity();
    this.secretKey = hexToBytes(identity.secretKeyHex);
    this.publicKeyHex = identity.publicKeyHex;
    this.publicKeyNpub = identity.publicKeyNpub;
  }

  /**
   * Obtiene la conexión a Redis para persistencia
   */
  private async getRedis(): Promise<any> {
    if (this.redisClient) return this.redisClient;
    try {
      const db = parseInt(process.env.REDIS_DB || '0', 10);
      this.redisClient = await getRedisConnector().getConnection(db);
      return this.redisClient;
    } catch (e: any) {
      console.warn('⚠️ [NostrGateway] Redis no disponible para caché de mensajes:', e.message);
      return null;
    }
  }

  /**
   * Comprueba si un evento ya fue procesado (en memoria o Redis)
   */
  private async hasEventBeenSeen(eventId: string): Promise<boolean> {
    if (this.seenEvents.has(eventId)) return true;
    try {
      const redis = await this.getRedis();
      if (redis) {
        const val = await redis.get(`nostr:seen:${eventId}`);
        if (val) {
          this.seenEvents.add(eventId);
          return true;
        }
      }
    } catch {
      // Ignorar error de redis y depender de memoria
    }
    return false;
  }

  /**
   * Marca un evento como en proceso (solo memoria). Evita que dos filtros del mismo
   * REQ disparen el agente dos veces, sin bloquear un reintento si la respuesta falla.
   */
  private markEventInFlight(eventId: string): void {
    this.seenEvents.add(eventId);
    if (this.seenEvents.size > 1000) {
      const oldest = Array.from(this.seenEvents).slice(0, 200);
      oldest.forEach(id => this.seenEvents.delete(id));
    }
  }

  /**
   * Libera un evento para que pueda reprocesarse (la respuesta no llegó a publicarse)
   */
  private releaseEvent(eventId: string): void {
    this.seenEvents.delete(eventId);
  }

  /**
   * Persiste el evento como procesado definitivamente (48h)
   */
  private async markEventSeen(eventId: string): Promise<void> {
    this.markEventInFlight(eventId);
    try {
      const redis = await this.getRedis();
      if (redis) {
        await redis.set(`nostr:seen:${eventId}`, '1', 'EX', 86400 * 2);
      }
    } catch {}
  }

  /**
   * Checkpoint temporal: hasta qué created_at se alcanzó a procesar.
   * Permite recuperar mensajes recibidos mientras el socket estuvo caído.
   */
  private async loadCheckpoint(): Promise<void> {
    try {
      const redis = await this.getRedis();
      if (redis) {
        const val = await redis.get('nostr:checkpoint');
        if (val) this.checkpointTs = parseInt(val, 10) || 0;
      }
    } catch {}
  }

  private async saveCheckpoint(createdAt: number): Promise<void> {
    if (!createdAt || createdAt <= this.checkpointTs) return;
    this.checkpointTs = createdAt;
    try {
      const redis = await this.getRedis();
      if (redis) await redis.set('nostr:checkpoint', String(createdAt));
    } catch {}
  }

  /**
   * Desde cuándo pedir eventos: retoma en el último procesado (con 60s de solape)
   * y nunca retrocede más de MAX_CATCHUP_SECONDS.
   */
  private computeSince(): number {
    const now = Math.floor(Date.now() / 1000);
    const floor = now - MAX_CATCHUP_SECONDS;
    const fromCheckpoint = this.checkpointTs > 0 ? this.checkpointTs - 60 : now - 180;
    return Math.max(floor, Math.min(fromCheckpoint, now));
  }

  /**
   * Verifica si alguno de los IDs de referencia pertenece a un hilo activo o mensaje propio
   */
  private async isThreadOrReplyActive(replyIds: string[]): Promise<boolean> {
    if (!replyIds || replyIds.length === 0) return false;

    for (const id of replyIds) {
      if (this.activeThreadRoots.has(id) || this.myMessageIds.has(id)) {
        return true;
      }
    }

    try {
      const redis = await this.getRedis();
      if (redis) {
        for (const id of replyIds) {
          const isThread = await redis.exists(`nostr:thread:${id}`);
          if (isThread) {
            this.activeThreadRoots.add(id);
            return true;
          }
          const isMyMsg = await redis.exists(`nostr:mymsg:${id}`);
          if (isMyMsg) {
            this.myMessageIds.add(id);
            return true;
          }
        }
      }
    } catch {}

    return false;
  }

  /**
   * Agrega un ID al filtro '#e' y reprograma la suscripción para empezar a
   * escuchar las respuestas de ese hilo (aunque no traigan el tag 'h').
   */
  private trackThreadFilterId(id: string): void {
    if (!this.threadFilter) return;
    if (!id || this.threadFilterIds.includes(id)) return;
    this.threadFilterIds.unshift(id);
    if (this.threadFilterIds.length > 20) this.threadFilterIds.length = 20;
    this.scheduleResubscribe();
  }

  /**
   * Resuscripción agrupada: varios markThreadActive seguidos generan un solo REQ nuevo.
   */
  private scheduleResubscribe(): void {
    if (this.resubscribeTimer || !this.isRunning) return;
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      if (this.relay && this.relay.connected) this.subscribeToEvents();
    }, 1500);
  }

  /**
   * Registra un hilo como activo donde Yisus participa
   */
  private async markThreadActive(threadRootId: string): Promise<void> {
    if (!threadRootId) return;
    this.activeThreadRoots.add(threadRootId);
    this.trackThreadFilterId(threadRootId);
    if (this.activeThreadRoots.size > 500) {
      const oldest = Array.from(this.activeThreadRoots).slice(0, 100);
      oldest.forEach(id => this.activeThreadRoots.delete(id));
    }
    try {
      const redis = await this.getRedis();
      if (redis) {
        await redis.set(`nostr:thread:${threadRootId}`, '1', 'EX', 86400 * 7); // 7 días
      }
    } catch {}
  }

  /**
   * Registra el ID de un mensaje enviado por Yisus
   */
  private async markMyMessage(messageId: string): Promise<void> {
    if (!messageId) return;
    this.myMessageIds.add(messageId);
    this.trackThreadFilterId(messageId);
    if (this.myMessageIds.size > 500) {
      const oldest = Array.from(this.myMessageIds).slice(0, 100);
      oldest.forEach(id => this.myMessageIds.delete(id));
    }
    try {
      const redis = await this.getRedis();
      if (redis) {
        await redis.set(`nostr:mymsg:${messageId}`, '1', 'EX', 86400 * 7); // 7 días
      }
    } catch {}
  }

  /**
   * Obtiene la identidad Nostr activa de Yisus
   */
  public getIdentity(): NostrIdentity {
    return {
      secretKeyHex: bytesToHex(this.secretKey),
      secretKeyNsec: nip19.nsecEncode(this.secretKey),
      publicKeyHex: this.publicKeyHex,
      publicKeyNpub: this.publicKeyNpub,
    };
  }

  /**
   * Carga la clave privada desde .env o .nostr_keys.json, o genera un nuevo par de claves
   */
  private loadOrGenerateIdentity(): NostrIdentity {
    // 1) Si está definida en .env
    const envKey = process.env.NOSTR_PRIVATE_KEY?.trim();
    if (envKey) {
      let secretBytes: Uint8Array;
      if (envKey.startsWith('nsec1')) {
        const decoded = nip19.decode(envKey);
        if (decoded.type !== 'nsec') throw new Error('NOSTR_PRIVATE_KEY con formato nsec inválido');
        secretBytes = decoded.data as Uint8Array;
      } else {
        secretBytes = hexToBytes(envKey);
      }
      const pkHex = getPublicKey(secretBytes);
      return {
        secretKeyHex: bytesToHex(secretBytes),
        secretKeyNsec: nip19.nsecEncode(secretBytes),
        publicKeyHex: pkHex,
        publicKeyNpub: nip19.npubEncode(pkHex),
      };
    }

    // 2) Si existe archivo .nostr_keys.json
    if (fs.existsSync(KEYS_FILE)) {
      try {
        const raw = fs.readFileSync(KEYS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.secretKeyHex) {
          const secretBytes = hexToBytes(parsed.secretKeyHex);
          const pkHex = getPublicKey(secretBytes);
          return {
            secretKeyHex: parsed.secretKeyHex,
            secretKeyNsec: nip19.nsecEncode(secretBytes),
            publicKeyHex: pkHex,
            publicKeyNpub: nip19.npubEncode(pkHex),
          };
        }
      } catch (err) {
        console.warn('⚠️ [NostrGateway] Error leyendo .nostr_keys.json, se generará uno nuevo:', err);
      }
    }

    // 3) Generar nuevo par de claves
    const newSecret = generateSecretKey();
    const pkHex = getPublicKey(newSecret);
    const newIdentity: NostrIdentity = {
      secretKeyHex: bytesToHex(newSecret),
      secretKeyNsec: nip19.nsecEncode(newSecret),
      publicKeyHex: pkHex,
      publicKeyNpub: nip19.npubEncode(pkHex),
    };

    try {
      fs.writeFileSync(KEYS_FILE, JSON.stringify(newIdentity, null, 2), { mode: 0o600 });
      console.log(`🔐 [NostrGateway] Nuevas claves Nostr generadas y guardadas en ${KEYS_FILE}`);
    } catch (e: any) {
      console.warn('⚠️ [NostrGateway] No se pudo persistir .nostr_keys.json:', e.message);
    }

    return newIdentity;
  }

  /**
   * Inicia el Gateway y se conecta al relay
   */
  public async start(runner: Runner, sessionService?: RedisSessionService): Promise<void> {
    if (this.isRunning) return;
    this.runner = runner;
    this.sessionService = sessionService || null;
    this.isRunning = true;

    console.log('---------------------------------------------------------');
    console.log('⚡ [NostrGateway] Iniciando Bridge Nostr para Yisus Agent');
    console.log(`🌐 Relay:       ${this.relayUrl}`);
    console.log(`🔑 Pubkey Hex:  ${this.publicKeyHex}`);
    console.log(`🏷️  Npub:        ${this.publicKeyNpub}`);
    console.log(`📡 Canales:     ${this.channelIds.join(', ')} | Kinds: ${this.channelKinds.join(',')} | Global: ${this.listenGlobal}`);
    console.log(`🛡️  RequireMention: ${this.requireMention} | GroupPolicy: ${this.isWildcardAllowed ? 'abierto (*)' : Array.from(this.allowedPubkeys).join(', ')}`);
    console.log('---------------------------------------------------------');

    await this.loadCheckpoint();
    await this.connect();
    this.startWatchdog();
  }

  // ─── Conexión ──────────────────────────────────────────────────────────────

  /**
   * Conecta al relay. Single-flight: una sola conexión en vuelo a la vez.
   * Cada intento incrementa relayGeneration, de modo que los callbacks de
   * sockets anteriores quedan invalidados y no disparan reconexiones cruzadas.
   */
  private async connect(): Promise<void> {
    if (!this.isRunning || this.isConnecting) return;
    this.isConnecting = true;

    const gen = ++this.relayGeneration;

    try {
      this.teardownRelay();

      console.log(`🔌 [NostrGateway] Conectando a ${this.relayUrl}... (intento ${this.reconnectAttempts + 1})`);

      const relay = new Relay(this.relayUrl, {
        // 'ws' expone ping()/once('pong'), así nostr-tools usa ping/pong real del
        // protocolo WebSocket. Con el WebSocket nativo de Node caía al "forced-ping"
        // (un REQ falso cada 29s) que el relay no respondía y terminaba cerrando el socket.
        websocketImplementation: WebSocket as any,
        enablePing: true,
      } as any);

      relay.onauth = async (template: any) => {
        console.log('🔐 [NostrGateway] Desafío NIP-42 recibido. Firmando autenticación con clave de Yisus...');
        return finalizeEvent(template, this.secretKey);
      };

      relay.onnotice = (msg: string) => {
        console.log(`📢 [NostrGateway] NOTICE del relay: ${msg}`);
      };

      relay.onclose = () => {
        if (gen !== this.relayGeneration) return; // cierre de un socket viejo: se ignora
        console.warn('⚠️ [NostrGateway] Socket cerrado por el relay.');
        this.scheduleReconnect();
      };

      await relay.connect({ timeout: CONNECT_TIMEOUT_MS } as any);

      if (gen !== this.relayGeneration) {
        try { relay.onclose = null as any; relay.close(); } catch {}
        return;
      }

      this.relay = relay;
      console.log(`✅ [NostrGateway] Socket abierto con ${this.relayUrl}.`);

      await this.waitForAuth(relay);
      if (gen !== this.relayGeneration || !relay.connected) return;

      this.reconnectAttempts = 0;
      this.subscribeToEvents();

      this.publishProfileIfStale().catch(e => console.warn('⚠️ [NostrGateway] Error en publishProfile:', e.message));
      this.flushPendingReplies().catch(() => {});
    } catch (err: any) {
      console.error(`❌ [NostrGateway] Error conectando al relay: ${err?.message || err}`);
      this.scheduleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Cierra socket y suscripción actuales sin disparar los handlers de reconexión
   */
  private teardownRelay(): void {
    const relay = this.relay;
    this.relay = null;

    this.subGeneration++; // invalida el onclose de la suscripción vigente
    if (this.activeSubscription) {
      try { this.activeSubscription.close(); } catch {}
      this.activeSubscription = null;
    }

    if (relay) {
      try {
        relay.onclose = null as any;
        relay.close();
      } catch {}
    }
  }

  /**
   * Programa un único reintento con backoff exponencial (2s → 30s)
   */
  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer || this.isConnecting) return;

    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
    this.reconnectAttempts++;

    console.log(`⏳ [NostrGateway] Reconectando en ${Math.round(delay / 1000)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(e => console.error('❌ [NostrGateway] Error en reconexión:', e?.message || e));
    }, delay);
  }

  /**
   * Espera el handshake NIP-42. Si el relay no manda desafío en AUTH_WAIT_MS, continúa sin auth.
   */
  private async waitForAuth(relay: any): Promise<void> {
    const deadline = Date.now() + AUTH_WAIT_MS;

    while (Date.now() < deadline) {
      if (relay.authPromise) {
        try {
          await relay.authPromise;
          console.log('🔐 [NostrGateway] Autenticación NIP-42 confirmada por el relay con OK!');
        } catch (err: any) {
          console.warn('⚠️ [NostrGateway] El relay rechazó la autenticación NIP-42:', err?.message || err);
        }
        return;
      }
      if (!relay.connected) return;
      await sleep(100);
    }

    console.log('ℹ️ [NostrGateway] El relay no solicitó NIP-42 en el tiempo esperado. Continuando sin autenticar.');
  }

  /**
   * Reautentica sobre el socket vivo y vuelve a suscribir (respuesta a un CLOSED auth-required)
   */
  private async reauthAndResubscribe(): Promise<void> {
    const relay: any = this.relay;
    if (!relay || !relay.connected) {
      this.scheduleReconnect();
      return;
    }

    try {
      if (relay.challenge && relay.onauth) {
        relay.authPromise = undefined; // forzar un AUTH nuevo sobre el mismo socket
        await relay.auth(relay.onauth);
        console.log('🔐 [NostrGateway] Reautenticación NIP-42 completada.');
      }
      this.subscribeToEvents();
    } catch (err: any) {
      console.warn('⚠️ [NostrGateway] Falló la reautenticación:', err?.message || err);
      this.scheduleReconnect();
    }
  }

  /**
   * Publica el perfil de Yisus (Kind 0). Se republica solo cada PROFILE_REFRESH_MS
   * para no gatillar rate limits del relay en cada reconexión.
   */
  private async publishProfileIfStale(): Promise<void> {
    if (!this.relay || !this.relay.connected) return;
    if (Date.now() - this.profilePublishedAt < PROFILE_REFRESH_MS) return;

    try {
      const profile = {
        name: 'yisus',
        display_name: 'Yisus',
        about: 'Clon digital y asistente de operaciones tecnológicas de Jesús Leiva (CTO Apprecio).'
      };
      const template = {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(profile)
      };
      const signed = finalizeEvent(template, this.secretKey);
      await this.relay.publish(signed);
      this.profilePublishedAt = Date.now();
      console.log('👤 [NostrGateway] Perfil de Yisus sincronizado en el relay (Kind 0)');
    } catch (e: any) {
      console.warn('⚠️ [NostrGateway] Error sincronizando perfil:', e.message);
    }
  }

  // ─── Suscripción ───────────────────────────────────────────────────────────

  /**
   * Suscribe a los eventos relevantes del canal (kind 9 = Buzz / NIP-29, más kinds 1, 42, 11, 1111)
   */
  private subscribeToEvents(): void {
    if (!this.relay || !this.relay.connected) return;

    // Anti-tormenta: si el relay rechaza los filtros, reintentar en bucle solo inunda el log.
    const now = Date.now();
    this.subAttemptTimes = this.subAttemptTimes.filter(t => now - t < 60000);
    if (this.subAttemptTimes.length >= 8) {
      console.warn('⚠️ [NostrGateway] Demasiadas resuscripciones en 1 minuto. Pausando 60s antes de reintentar.');
      this.subAttemptTimes = [];
      setTimeout(() => {
        if (this.relay && this.relay.connected) this.subscribeToEvents();
      }, 60000);
      return;
    }
    this.subAttemptTimes.push(now);
    this.renewalCount++;

    const since = this.computeSince();
    const gen = this.relayGeneration;
    const subGen = ++this.subGeneration; // primero: invalida el onclose de la suscripción anterior

    if (this.activeSubscription) {
      try { this.activeSubscription.close(); } catch {}
      this.activeSubscription = null;
    }

    const filters: any[] = [
      { kinds: this.channelKinds, '#h': this.channelIds, since },
      { '#p': [this.publicKeyHex], since },
    ];

    // Respuestas dentro de hilos donde Yisus ya participó (pueden venir sin tag 'h').
    // Desactivado por defecto: Buzz cierra el REQ completo si pides eventos p-gated ajenos.
    if (this.threadFilter && this.threadFilterIds.length > 0) {
      filters.push({ '#e': [...this.threadFilterIds], since });
      filters.push({ '#E': [...this.threadFilterIds], since });
    }

    if (this.listenGlobal) {
      filters.push({ kinds: [1, 42], since });
    }

    // Solo para diagnosticar cómo emite Buzz cada tipo de mensaje
    if (this.debugFirehose) {
      filters.push({ since });
    }

    this.lastSubscribedAt = Date.now();

    if (this.debugEvents && this.subGeneration <= 1) {
      console.log(`🧪 [NostrGateway] Filtros activos: ${JSON.stringify(filters)}`);
    }

    this.activeSubscription = this.relay.subscribe(filters, {
      onevent: (event: any) => {
        this.lastStreamAt = Date.now();
        this.eventCount++;
        this.handleIncomingEvent(event).catch(err => {
          console.error('❌ [NostrGateway] Error procesando evento:', err);
        });
      },
      oneose: () => {
        this.lastStreamAt = Date.now();
        // Con la renovación cada 30s, anunciar cada EOSE inunda el log:
        // solo se anuncia la primera suscripción de cada conexión.
        if (gen !== this.lastGreenLogGen) {
          this.lastGreenLogGen = gen;
          console.log(`🟢 [NostrGateway] Suscripción activa en [${this.channelIds.join(', ')}] desde ${new Date(since * 1000).toISOString()}`);
        }
      },
      onclose: (reason: any) => {
        // Solo reacciona la suscripción vigente; los cierres provocados por
        // teardown/resubscribe llegan con una generación vieja y se ignoran.
        if (gen !== this.relayGeneration || subGen !== this.subGeneration) return;

        const r = String(reason ?? '');
        console.warn(`⚠️ [NostrGateway] Suscripción cerrada por el relay (${r}).`);

        if (/auth-required|auth_required|restricted: we can't serve/i.test(r)) {
          this.reauthAndResubscribe().catch(() => this.scheduleReconnect());
        } else if (/restricted|invalid|blocked|unsupported|error:/i.test(r)) {
          // El relay rechazó los filtros: reintentar igual es inútil y llena el log.
          if (this.threadFilter && this.threadFilterIds.length > 0) {
            console.warn('⚠️ [NostrGateway] El relay rechazó el filtro de hilos (#e). Desactivándolo para esta sesión.');
            this.threadFilter = false;
            this.threadFilterIds = [];
            this.subscribeToEvents();
          } else {
            console.error('❌ [NostrGateway] El relay rechazó la suscripción. Reintento en 60s; revisa los filtros.');
            setTimeout(() => {
              if (this.relay && this.relay.connected) this.subscribeToEvents();
            }, 60000);
          }
        } else if (this.relay && this.relay.connected) {
          // Socket vivo pero REQ cerrado: basta con volver a suscribir.
          this.subscribeToEvents();
        } else {
          this.scheduleReconnect();
        }
      },
    });
  }

  // ─── Watchdog ──────────────────────────────────────────────────────────────

  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      this.checkLiveness().catch(() => {});
    }, WATCHDOG_MS);
  }

  /**
   * relay.connected solo refleja el estado del socket del lado del cliente: con una
   * conexión zombie (o una suscripción que el relay dio de baja sin cerrar el socket)
   * queda en true y el bridge deja de recibir mensajes en silencio. Por eso además
   * del estado del socket se hace un REQ de prueba y se renueva la suscripción.
   */
  private async checkLiveness(): Promise<void> {
    if (!this.isRunning || this.isConnecting || this.reconnectTimer) return;

    const relay: any = this.relay;
    if (!relay || !relay.connected) {
      console.warn('⚠️ [NostrGateway] Watchdog: no hay conexión viva con el relay.');
      this.scheduleReconnect();
      return;
    }

    if (Date.now() - this.lastSummaryAt > SUMMARY_MS) {
      const mins = Math.round((Date.now() - this.lastSummaryAt) / 60000);
      console.log(`💤 [NostrGateway] Escuchando [${this.channelIds.join(', ')}] — ${this.renewalCount} renovaciones y ${this.eventCount} eventos en los últimos ${mins} min.`);
      this.lastSummaryAt = Date.now();
      this.renewalCount = 0;
      this.eventCount = 0;
    }

    if (Date.now() - this.lastSubscribedAt > RESUBSCRIBE_MS) {
      if (this.debugEvents) {
        const quietFor = Math.round((Date.now() - this.lastStreamAt) / 1000);
        console.log(`🔄 [NostrGateway] Renovando suscripción (sin tráfico del relay hace ${quietFor}s).`);
      }
      this.subscribeToEvents();
      return;
    }

    // El REQ de prueba queda apagado por defecto: si el relay admite una sola
    // suscripción por conexión, el probe reemplaza a la principal y el bridge
    // deja de recibir mensajes hasta el siguiente reinicio.
    if (!this.watchdogProbe) return;

    if (this.probeInFlight) return;
    this.probeInFlight = true;
    const alive = await this.probeRelay(relay);
    this.probeInFlight = false;

    if (!alive) {
      console.warn('⚠️ [NostrGateway] Watchdog: el relay no respondió el REQ de prueba. Reconectando...');
      this.scheduleReconnect();
    }
  }

  /**
   * REQ mínimo contra el canal: si no llega EOSE dentro del deadline, el socket está muerto.
   */
  private probeRelay(relay: any): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let sub: any = null;
      let done = false;

      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { sub?.close(); } catch {}
        resolve(ok);
      };

      const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);

      try {
        sub = relay.subscribe(
          [{ kinds: this.channelKinds, '#h': this.channelIds, limit: 1 }],
          {
            label: 'watchdog',
            eoseTimeout: PROBE_TIMEOUT_MS,
            onevent: () => {},
            oneose: () => finish(true),
            onclose: () => finish(false),
          }
        );
      } catch {
        finish(false);
      }
    });
  }

  // ─── Procesamiento de eventos ──────────────────────────────────────────────

  /**
   * Procesa un evento entrante del relay
   */
  private async handleIncomingEvent(event: any): Promise<void> {
    // 1) Ignorar eventos emitidos por el propio bot.
    // Si alguien escribe en Buzz con LA MISMA identidad del bot, el mensaje cae acá
    // y se descarta en silencio: el bot no puede distinguir humano de sí mismo.
    if (event.pubkey === this.publicKeyHex) {
      // Cada renovación reenvía los eventos almacenados: se loguea una sola vez
      // y se avanza el checkpoint, si no la propia respuesta vuelve en cada REQ.
      if (!this.seenEvents.has(event.id)) {
        this.markEventInFlight(event.id);
        if (this.debugEvents) {
          console.log(`🔁 [NostrGateway] Evento propio ignorado (id ${event.id.slice(0, 8)}...): "${(event.content || '').slice(0, 60)}"`);
        }
      }
      await this.saveCheckpoint(event.created_at);
      return;
    }

    // 2) Deduplicación (memoria + Redis). Se persiste recién cuando la respuesta sale.
    const alreadySeen = await this.hasEventBeenSeen(event.id);
    if (alreadySeen) return;
    this.markEventInFlight(event.id);

    const content = (event.content || '').trim();
    if (!content) return;

    const hTag = event.tags?.find((t: any) => t[0] === 'h' || t[0] === '~');
    console.log(`📥 [NostrGateway] Evento recibido (kind ${event.kind}${hTag ? `, h=${hTag[1]}` : ''}, id ${event.id.slice(0, 8)}... de ${event.pubkey.slice(0, 8)}...): "${content.slice(0, 60)}"`);
    if (this.debugEvents) {
      console.log(`🧪 [NostrGateway] Tags: ${JSON.stringify(event.tags)}`);
    }

    // 3) Filtro de remitente autorizado (groupAllowFrom)
    if (!this.isWildcardAllowed && !this.allowedPubkeys.has(event.pubkey)) {
      console.log(`⏭️ [NostrGateway] Omitido: Remitente ${event.pubkey.slice(0, 8)} no está en groupAllowFrom`);
      await this.markEventSeen(event.id);
      await this.saveCheckpoint(event.created_at);
      return;
    }

    // 4) Filtro de mención y contexto de hilo (requireMention)
    const mentionsPubkey = event.tags?.some((t: any) =>
      (t[0] === 'p' || t[0] === 'mention') &&
      (t[1]?.toLowerCase() === this.publicKeyHex.toLowerCase() || t[1] === this.publicKeyNpub)
    );

    const mentionsName = /\b@?yisus\b/i.test(content) || content.includes(this.publicKeyNpub);

    const eventReplyIds = event.tags?.filter((t: any) => t[0] === 'e').map((t: any) => t[1]) || [];
    const isReplyToMe = await this.isThreadOrReplyActive(eventReplyIds);

    if (this.requireMention && !mentionsPubkey && !mentionsName && !isReplyToMe) {
      console.log(`⏭️ [NostrGateway] Omitido: Sin mención ("Yisus" o "@Yisus") ni hilo activo (mentionsPubkey=${mentionsPubkey}, mentionsName=${mentionsName}, isReplyToMe=${isReplyToMe}) en "${content.slice(0, 40)}"`);
      await this.markEventSeen(event.id);
      await this.saveCheckpoint(event.created_at);
      return;
    }

    // 5) Registrar raíz del hilo activo para continuidad permanente
    const rootTag = event.tags?.find((t: any) => t[0] === 'e' && (t[3] === 'root' || !t[3]));
    const anyETag = event.tags?.find((t: any) => t[0] === 'e');
    const threadRootId = rootTag ? rootTag[1] : (anyETag ? anyETag[1] : event.id);

    await this.markThreadActive(threadRootId);
    for (const replyId of eventReplyIds) {
      await this.markThreadActive(replyId);
    }

    // 6) Limpiar mención del prompt
    let cleanPrompt = content
      .replace(/@?yisus[:,]?\s*/gi, '')
      .replace(new RegExp(`nostr:${this.publicKeyNpub}`, 'g'), '')
      .replace(new RegExp(this.publicKeyNpub, 'g'), '')
      .trim();

    if (!cleanPrompt) {
      cleanPrompt = 'Hola Yisus';
    }

    console.log(`🧠 [NostrGateway] Ejecutando Runner ADK con: "${cleanPrompt}"`);

    // 7) Ejecutar consulta a través del Runner de ADK
    const responseText = await this.askRunner(cleanPrompt, event);

    // 8) Publicar respuesta firmada en el canal
    const published = await this.publishReply(event, responseText, threadRootId);

    if (published) {
      await this.markEventSeen(event.id);
      await this.saveCheckpoint(event.created_at);
    } else {
      // Quedó encolada: se libera el ID para poder reintentar si el relay reenvía el evento.
      this.releaseEvent(event.id);
    }
  }

  /**
   * Consulta al Runner de ADK con persistencia de sesión por remitente / sala
   */
  private async askRunner(prompt: string, incomingEvent: any): Promise<string> {
    if (!this.runner) {
      return 'Yisus Agent está iniciando, por favor reintenta en un momento.';
    }

    try {
      const channelTag = incomingEvent.tags?.find((t: any) => t[0] === 'h' || t[0] === '~');
      const channelId = channelTag ? channelTag[1] : 'nostr-global';
      const sessionId = `nostr:${channelId}:${incomingEvent.pubkey}`;
      const userId = `nostr:${incomingEvent.pubkey}`;
      const appName = process.env.ADK_APP_NAME || 'yisus';

      if (this.sessionService) {
        let session = await this.sessionService.getSession({ appName, userId, sessionId });
        if (!session) {
          await this.sessionService.createSession({ appName, userId, sessionId });
        }
      }

      // Respaldo del cierre de escalamientos: si al resolver no se pudo publicar, se entrega acá
      const { escalationDeliveryService } = await import('./escalation_delivery.service.js');
      const pendiente = escalationDeliveryService.consumePendingFor(sessionId);

      const newMessage = {
        role: 'user',
        parts: [{ text: pendiente + prompt + sufijoFechaMensaje() }],
      } as any;

      const replies: string[] = [];
      let errorModelo = '';
      const { beginUsageScope, flushUsageScope } = await import('../utils/usage_collector.js');
      beginUsageScope('buzz', sessionId, `[Buzz] ${prompt}`);

      for await (const event of this.runner.runAsync({
        userId,
        sessionId,
        newMessage,
      })) {
        if ((event as any)?.errorMessage) errorModelo = (event as any).errorMessage;
        const parts = (event as any)?.content?.parts;
        const isPartial = (event as any)?.partial === true;
        if (Array.isArray(parts) && !isPartial && (event as any)?.author !== 'user') {
          const text = parts
            .map((p: any) => p?.text ?? '')
            .filter(Boolean)
            .join('');
          if (text) replies.push(text);
        }
      }

      flushUsageScope().catch(() => {});

      if (!replies.length && errorModelo) return `⚠️ El modelo no pudo responder: ${errorModelo}`;
      return replies[replies.length - 1] || 'Recibido.';
    } catch (err: any) {
      console.error('❌ [NostrGateway] Error invocando Runner:', err);
      return `Ocurrió un error al procesar tu solicitud: ${err.message}`;
    }
  }

  /**
   * Publica la respuesta en el canal Nostr etiquetando el hilo y remitente.
   * Si el socket se cayó mientras el agente pensaba, encola la respuesta y la
   * despacha en la próxima reconexión en vez de perderla.
   */
  private async publishReply(incomingEvent: any, responseText: string, threadRootId: string): Promise<boolean> {
    if (!this.relay || !this.relay.connected) {
      console.warn('⚠️ [NostrGateway] Relay no conectado: respuesta encolada para el siguiente reintento.');
      this.pendingReplies.push({ incoming: incomingEvent, text: responseText, rootId: threadRootId, queuedAt: Date.now() });
      this.scheduleReconnect();
      return false;
    }

    try {
      const tags: string[][] = [];

      const channelTag = incomingEvent.tags?.find((t: any) => t[0] === 'h' || t[0] === '~');
      if (channelTag) {
        tags.push([channelTag[0], channelTag[1]]);
      }

      if (threadRootId && threadRootId !== incomingEvent.id) {
        tags.push(['e', threadRootId, '', 'root']);
        tags.push(['e', incomingEvent.id, '', 'reply']);
      } else {
        tags.push(['e', incomingEvent.id, '', 'reply']);
      }

      tags.push(['p', incomingEvent.pubkey]);

      const eventTemplate = {
        kind: incomingEvent.kind, // kind 9 para Buzz
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: attachmentsService.comoEnlaces(responseText),
      };

      const signedEvent = finalizeEvent(eventTemplate, this.secretKey);

      await this.markMyMessage(signedEvent.id);
      await this.markThreadActive(threadRootId);
      await this.markThreadActive(incomingEvent.id);

      await this.relay.publish(signedEvent);

      console.log(`📤 [NostrGateway] Respuesta publicada a ${incomingEvent.pubkey.slice(0, 8)}... : "${responseText.replace(/\n/g, ' ').slice(0, 100)}..." (EventID: ${signedEvent.id.slice(0, 8)})`);
      return true;
    } catch (err: any) {
      console.error('❌ [NostrGateway] Error publicando respuesta al relay:', err?.message || err);
      this.pendingReplies.push({ incoming: incomingEvent, text: responseText, rootId: threadRootId, queuedAt: Date.now() });
      return false;
    }
  }

  /**
   * Despacha las respuestas que quedaron pendientes por una caída del socket
   */
  private async flushPendingReplies(): Promise<void> {
    if (this.pendingReplies.length === 0) return;

    const now = Date.now();
    const queue = this.pendingReplies.filter(p => now - p.queuedAt < PENDING_REPLY_TTL_MS);
    const expired = this.pendingReplies.length - queue.length;
    if (expired > 0) console.warn(`⚠️ [NostrGateway] ${expired} respuesta(s) pendiente(s) descartada(s) por antigüedad.`);
    this.pendingReplies = [];

    for (const item of queue) {
      const ok = await this.publishReply(item.incoming, item.text, item.rootId);
      if (ok) {
        await this.markEventSeen(item.incoming.id);
        await this.saveCheckpoint(item.incoming.created_at);
      }
    }
  }

  /**
   * Publica un mensaje nuevo en el canal (no es respuesta a nadie).
   * Es la pata de salida del bridge: la usan las herramientas del agente.
   */
  public async publishToChannel(text: string, channelId?: string, mentionPubkey?: string): Promise<{
    status: 'success' | 'error';
    eventId?: string;
    channel?: string;
    message?: string;
  }> {
    if (!text || !text.trim()) {
      return { status: 'error', message: 'El mensaje está vacío.' };
    }
    if (!this.isRunning) {
      return { status: 'error', message: 'El bridge Nostr no está iniciado (NOSTR_ENABLED=false).' };
    }
    if (!this.relay || !this.relay.connected) {
      return { status: 'error', message: 'No hay conexión activa con el relay de Buzz en este momento.' };
    }

    const channel = channelId || this.channelIds[0];
    if (!channel) {
      return { status: 'error', message: 'No hay canal configurado (NOSTR_CHANNELS).' };
    }

    try {
      const tags: string[][] = [['h', channel]];
      if (mentionPubkey) tags.push(['p', mentionPubkey]); // notifica a la persona (Buzz avisa las menciones)
      const template = {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: attachmentsService.comoEnlaces(text.trim()),
      };
      const signed = finalizeEvent(template, this.secretKey);

      await this.markMyMessage(signed.id);
      await this.markThreadActive(signed.id); // así las respuestas al mensaje se reconocen como hilo activo
      await this.relay.publish(signed);

      console.log(`📤 [NostrGateway] Mensaje publicado en el canal [${channel}]: "${text.slice(0, 80)}" (EventID: ${signed.id.slice(0, 8)})`);
      return { status: 'success', eventId: signed.id, channel };
    } catch (err: any) {
      return { status: 'error', message: `El relay rechazó el mensaje: ${err?.message || err}` };
    }
  }

  /**
   * Estado del bridge para diagnóstico desde el agente
   */
  public getStatus(): { running: boolean; connected: boolean; relay: string; npub: string; channels: string[] } {
    return {
      running: this.isRunning,
      connected: !!this.relay?.connected,
      relay: this.relayUrl,
      npub: this.publicKeyNpub,
      channels: this.channelIds,
    };
  }

  /**
   * Detiene el servicio
   */
  public stop(): void {
    this.isRunning = false;

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }

    this.teardownRelay();
  }
}

export const nostrGatewayService = new NostrGatewayService();
