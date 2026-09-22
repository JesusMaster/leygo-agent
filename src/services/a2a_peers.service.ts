import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import { randomUUID } from 'node:crypto';
import { sqliteReminderService, A2APeer } from '../database/sqlite.service.js';

/**
 * Yisus como CLIENTE A2A: le escribe a otros agentes (OpenClaw, por ejemplo).
 *
 * Cada peer es una Agent Card + un token Bearer. Se guarda el último contextId
 * para poder seguir una conversación en vez de abrir una nueva cada vez.
 * Sirve para tres cosas: la herramienta a2a_send_message (el coordinator le
 * escribe a un peer), el canal de entrega "a2a" de las tareas programadas, y
 * empujar las resoluciones de escalamientos que llegaron por A2A.
 */
export class A2APeersService {
  private clientes = new Map<string, { client: any; cardUrl: string; token: string | null }>();

  public list(): Array<Omit<A2APeer, 'token'> & { tokenPreview: string | null }> {
    return sqliteReminderService.listA2APeers().map(({ token, ...p }) => ({
      ...p,
      tokenPreview: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : null,
    }));
  }

  public get(name: string) { return sqliteReminderService.getA2APeer(name); }

  public create(p: { name: string; card_url: string; token?: string | null; token_name?: string | null }) {
    const name = p.name.trim();
    if (!name) throw new Error('Falta el nombre del agente remoto.');
    if (!/^https?:\/\//.test(p.card_url || '')) throw new Error('La URL de la Agent Card debe empezar por http(s)://');
    if (sqliteReminderService.getA2APeer(name)) throw new Error(`Ya existe un agente remoto llamado "${name}".`);
    sqliteReminderService.createA2APeer({ name, card_url: p.card_url.trim(), token: p.token?.trim() || null, token_name: p.token_name?.trim() || null });
    return sqliteReminderService.getA2APeer(name)!;
  }

  public update(name: string, cambios: Partial<{ card_url: string; token: string | null; token_name: string | null; enabled: boolean }>) {
    const ok = sqliteReminderService.updateA2APeer(name, cambios);
    if (ok) this.clientes.delete(name);
    return ok ? sqliteReminderService.getA2APeer(name) : null;
  }

  public delete(name: string) { this.clientes.delete(name); return sqliteReminderService.deleteA2APeer(name); }

  /** Descarga la card y devuelve un resumen: sirve para "Probar conexión" en la GUI. */
  public async probar(name: string): Promise<{ ok: boolean; agente?: string; skills?: number; version?: string; url?: string; error?: string }> {
    const peer = sqliteReminderService.getA2APeer(name);
    if (!peer) return { ok: false, error: 'Agente remoto no encontrado' };
    try {
      const res = await this.fetchCon(peer)(peer.card_url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return { ok: false, error: `La card respondió HTTP ${res.status}` };
      const card: any = await res.json();
      const url = card?.supportedInterfaces?.[0]?.url || card?.url;
      sqliteReminderService.updateA2APeer(name, { last_error: null });
      return { ok: true, agente: card?.name, skills: card?.skills?.length || 0, version: card?.supportedInterfaces?.[0]?.protocolVersion || card?.protocolVersion, url };
    } catch (err: any) {
      sqliteReminderService.updateA2APeer(name, { last_error: err.message });
      return { ok: false, error: err.message };
    }
  }

  /**
   * Envía un mensaje y devuelve la respuesta en texto.
   * `nuevaConversacion` abre otro contextId; si no, continúa el último.
   */
  public async send(name: string, texto: string, opts: { nuevaConversacion?: boolean; contextId?: string } = {}): Promise<{ texto: string; contextId: string | null; estado?: string }> {
    const peer = sqliteReminderService.getA2APeer(name);
    if (!peer) throw new Error(`Agente remoto "${name}" no encontrado.`);
    if (!peer.enabled) throw new Error(`El agente remoto "${name}" está deshabilitado.`);

    const client = await this.clientePara(peer);
    const contextId = opts.contextId || (opts.nuevaConversacion ? undefined : peer.last_context_id || undefined);

    const message: any = {
      messageId: randomUUID(),
      role: 1, // ROLE_USER
      parts: [{ content: { $case: 'text', value: texto } }],
      ...(contextId ? { contextId } : {}),
    };

    try {
      const res: any = await client.sendMessage({ message, tenant: '', configuration: undefined, metadata: undefined });
      const salida = this.extraer(res);
      sqliteReminderService.updateA2APeer(name, { last_used_at: Date.now(), last_context_id: salida.contextId || contextId || null, last_error: null });
      return salida;
    } catch (err: any) {
      sqliteReminderService.updateA2APeer(name, { last_error: err?.message || String(err) });
      throw new Error(`No se pudo hablar con "${name}": ${err?.message || err}`);
    }
  }

  // ─── internos ────────────────────────────────────────────────────────────

  private fetchCon(peer: A2APeer): typeof fetch {
    return (input: any, init: any = {}) => {
      const headers = new Headers(init.headers || {});
      if (peer.token) headers.set('Authorization', `Bearer ${peer.token}`);
      return fetch(input, { ...init, headers });
    };
  }

  private async clientePara(peer: A2APeer) {
    const cache = this.clientes.get(peer.name);
    if (cache && cache.cardUrl === peer.card_url && cache.token === peer.token) return cache.client;

    const fetchImpl = this.fetchCon(peer);
    const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      // legacyCompat: si el otro agente habla 0.3 (message/send), el SDK cambia de transporte solo
      transports: [new JsonRpcTransportFactory({ fetchImpl, legacyCompat: { enabled: true } })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
    });

    const factory = new ClientFactory(options);
    const client = await factory.createFromUrl(peer.card_url, '');
    this.clientes.set(peer.name, { client, cardUrl: peer.card_url, token: peer.token });
    return client;
  }

  /** Saca el texto de la respuesta, venga como Message o como Task. */
  private extraer(res: any): { texto: string; contextId: string | null; estado?: string } {
    const partes = (msg: any): string =>
      (msg?.parts || [])
        .map((p: any) => (p?.content?.$case === 'text' ? p.content.value : p?.text || ''))
        .filter(Boolean)
        .join('\n');

    const payload = res?.payload ?? res;
    if (payload?.$case === 'message' || payload?.message) {
      const m = payload.$case === 'message' ? payload.value : payload.message;
      return { texto: partes(m), contextId: m?.contextId || null };
    }
    const task = payload?.$case === 'task' ? payload.value : payload?.task || payload;
    const msg = task?.status?.message;
    let texto = partes(msg);
    if (!texto && Array.isArray(task?.artifacts)) {
      texto = task.artifacts.map((a: any) => partes(a)).filter(Boolean).join('\n');
    }
    if (!texto && Array.isArray(task?.history)) {
      const ultimo = [...task.history].reverse().find((h: any) => h?.role === 2 || h?.role === 'ROLE_AGENT');
      texto = partes(ultimo);
    }
    return { texto: texto || '(sin texto en la respuesta)', contextId: task?.contextId || null, estado: task?.status?.state };
  }
}

export const a2aPeersService = new A2APeersService();
