import {
  BaseSessionService,
  createSession,
  Event,
  Session,
  CreateSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  DeleteSessionRequest,
  AppendEventRequest,
} from '@google/adk';
import { getRedisConnector, createRedisRepository } from '../database/redis.js';
import { randomUUID } from 'crypto';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 días
const INDEX_TTL_SECONDS   = SESSION_TTL_SECONDS + 300;

export class RedisSessionService extends BaseSessionService {
  private redis = createRedisRepository(
    async () => {
      const db = parseInt(process.env.REDIS_DB || '0', 10);
      return getRedisConnector().getConnection(db);
    },
    'adksession:'
  );

  // ─── Keys ────────────────────────────────────────────────────────────────

  /** Datos completos de una sesión */
  private sessionKey(appName: string, userId: string, sessionId: string) {
    return `adksession:${appName}:${userId}:${sessionId}`;
  }

  /** Redis Set con los sessionIds de un usuario */
  private indexKey(appName: string, userId: string) {
    return `adksession-idx:${appName}:${userId}`;
  }

  // ─── createSession ───────────────────────────────────────────────────────

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    const id  = sessionId ?? randomUUID();
    const now = Date.now() / 1000; // ADK usa segundos (float)

    const session = createSession({
      id,
      appName,
      userId,
      state: state ?? {},
      events: [],
      lastUpdateTime: now,
    });

    const key = this.sessionKey(appName, userId, id);
    await this.redis.saveTTL(key, JSON.stringify(session), SESSION_TTL_SECONDS);

    // Registrar en el índice (Set nativo → thread-safe)
    const idxKey = this.indexKey(appName, userId);
    await this.redis.sadd(idxKey, id);
    await this.redis.addTTL(idxKey, INDEX_TTL_SECONDS);

    return session;
  }

  // ─── getSession ──────────────────────────────────────────────────────────

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    const data = await this.redis.find(this.sessionKey(appName, userId, sessionId));
    if (!data) return undefined;

    const session = JSON.parse(data as string) as Session;

    if (config?.numRecentEvents) {
      session.events = session.events.slice(-config.numRecentEvents);
    }

    if (config?.afterTimestamp) {
      session.events = session.events.filter(
        (e) => e.timestamp >= config.afterTimestamp!
      );
    }

    return session;
  }

  // ─── listSessions ────────────────────────────────────────────────────────

  async listSessions({
    appName,
    userId,
    limit,
    offset,
    page,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    const idxKey    = this.indexKey(appName, userId as any);
    const sessionIds = (await this.redis.smembers(idxKey) as string[]) ?? [];

    const allSessions: Session[] = [];
    const expired:  string[]  = [];

    for (const sid of sessionIds) {
      const data = await this.redis.find(this.sessionKey(appName, userId as any, sid));
      if (data) {
        const session = JSON.parse(data as string) as Session;
        // Sin events para no inflar la respuesta (igual que VertexAI)
        allSessions.push({ ...session, events: [] });
      } else {
        expired.push(sid);
      }
    }

    // Limpiar del índice las sesiones que ya expiraron
    for (const sid of expired) {
      await this.redis.sisremove(idxKey, sid);
    }

    const totalItems = allSessions.length;
    const pageSize = limit ?? totalItems;
    const currentPage = page ?? 1;
    const totalPages = pageSize > 0 ? Math.ceil(totalItems / pageSize) : 0;

    let startIndex = 0;
    if (page && limit) {
      startIndex = (page - 1) * limit;
    } else if (offset !== undefined) {
      startIndex = offset;
    }

    const sessions = limit !== undefined
      ? allSessions.slice(startIndex, startIndex + pageSize)
      : allSessions;

    return {
      sessions,
      page: currentPage,
      limit: pageSize,
      totalItems,
      totalPages,
    };
  }

  // ─── deleteSession ───────────────────────────────────────────────────────

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    // Delete real usando .clear()
    await this.redis.clear(this.sessionKey(appName, userId, sessionId));
    // Eliminar del índice
    await this.redis.sisremove(this.indexKey(appName, userId), sessionId);
  }

  // ─── appendEvent ─────────────────────────────────────────────────────────

  async appendEvent({ session, event }: AppendEventRequest): Promise<Event> {
    // super aplica el stateDelta al session.state en memoria
    await super.appendEvent({ session, event });

    const key        = this.sessionKey(session.appName, session.userId, session.id);
    const storedData = await this.redis.find(key);

    let toStore: Session;

    if (storedData) {
      const stored = JSON.parse(storedData as string) as Session;

      // Idempotencia: no duplicar si el evento ya fue persistido (retry)
      const alreadyExists = stored.events.some((e) => e.id === event.id);

      toStore = {
        ...stored,
        events:         alreadyExists ? stored.events : [...stored.events, event],
        state:          { ...stored.state, ...session.state }, // state local tiene el delta ya aplicado
        lastUpdateTime: event.timestamp,
      };
    } else {
      // Sesión expirada o primer evento — persistir desde estado local
      toStore = { ...session, lastUpdateTime: event.timestamp };
    }

    await this.redis.saveTTL(key, JSON.stringify(toStore), SESSION_TTL_SECONDS);

    return event;
  }
}