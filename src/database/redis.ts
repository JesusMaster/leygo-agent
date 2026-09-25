import { Redis, RedisOptions } from 'ioredis';

const logger = {
    info: (msg: string) => console.log(msg),
    error: (msg: string) => console.error(msg),
};

/**
 * Redis caído no debe tumbar el proceso: reintenta para siempre con backoff (máx. 10 s) y los
 * comandos emitidos sin conexión fallan en ~2 reintentos en vez de colgar la petición.
 */
const OPCIONES_RESILIENTES: RedisOptions = {
    retryStrategy: (times: number) => Math.min(times * 200, 10_000),
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
};

export type RedisEstado = 'conectado' | 'reconectando' | 'desconectado';

export class RedisConnector {
    private defaultClient: Redis | null = null;
    private clients: Map<number, Redis> = new Map();
    private options: RedisOptions = {};
    private defaultDb: number = 0;
    private host?: string;

    constructor(optionsOrUrl: RedisOptions | string) {
        if (typeof optionsOrUrl === 'string') {
            this.options = { ...OPCIONES_RESILIENTES };
            this.host = undefined; 
            (this as any).url = optionsOrUrl; 
        } else {
            this.options = { ...OPCIONES_RESILIENTES, ...optionsOrUrl };
            this.defaultDb = optionsOrUrl.db || 0;
            this.host = optionsOrUrl.host;
        }
    }

    async connect(): Promise<void> {
        if (this.defaultClient) {
            logger.info('Redis default client already connected');
            return;
        }
        this.defaultClient = this.createClient(this.defaultDb);
        this.clients.set(this.defaultDb, this.defaultClient);
        await this.conectarSinLanzar(this.defaultClient, this.defaultDb);
    }

    /**
     * Primer intento de conexión. Si falla NO lanza: ioredis sigue reintentando en segundo plano
     * (retryStrategy) y el servidor arranca igual (GUI, Telegram y Buzz vivos, /api/status avisa).
     */
    private async conectarSinLanzar(client: Redis, db: number): Promise<void> {
        if (client.status !== 'wait') return;
        try {
            await client.connect();
        } catch (error: any) {
            logger.error(`⚠️  Redis no disponible (db ${db}): ${error?.message || error}. Sigo arrancando; reintento en segundo plano.`);
        }
    }

    /** Estado de la conexión principal (para /api/status y la GUI). */
    estado(): RedisEstado {
        const st = this.defaultClient?.status;
        if (st === 'ready') return 'conectado';
        if (st === 'connecting' || st === 'reconnecting' || st === 'connect') return 'reconectando';
        return 'desconectado';
    }

    private createClient(db: number): Redis {
        let client: Redis;
        const url = (this as any).url;

        if (url) {
             client = new Redis(url, { ...this.options, db, lazyConnect: true });
        } else {
            client = new Redis({ ...this.options, db, lazyConnect: true });
        }

        // Sin conexión, ioredis emite 'error' en cada reintento: se loguea el primero y luego 1 por minuto.
        let caido = false;
        let ultimoLog = 0;
        client.on('ready', () => {
            logger.info(caido ? `🟢 Redis reconectado (db ${db})` : `🔴 Redis connected to db ${db}`);
            caido = false;
        });
        client.on('error', (err) => {
            const ahora = Date.now();
            if (!caido || ahora - ultimoLog > 60_000) {
                logger.error(`Redis error on db ${db}: ${err?.message || err}${caido ? ' (sigo reintentando)' : ''}`);
                ultimoLog = ahora;
            }
            caido = true;
        });
        return client;
    }

    async disconnect(): Promise<void> {
        const disconnectPromises: Promise<void>[] = [];
        for (const [db, client] of this.clients.entries()) {
            disconnectPromises.push(client.quit().then(() => {}).catch(() => client.disconnect()));
        }
        await Promise.all(disconnectPromises);
        this.clients.clear();
        this.defaultClient = null;
    }

    getClient(): Redis {
        if (!this.defaultClient) throw new Error('Redis not connected');
        return this.defaultClient;
    }

    async getConnection(db: number): Promise<Redis> {
        if (db === this.defaultDb) {
            if (!this.defaultClient) await this.connect();
            return this.defaultClient!;
        }
        if (this.clients.has(db)) {
            const client = this.clients.get(db)!;
            await this.conectarSinLanzar(client, db);
            return client;
        }
        const newClient = this.createClient(db);
        this.clients.set(db, newClient);
        await this.conectarSinLanzar(newClient, db);
        return newClient;
    }
}

export let redisConnectorInstance: RedisConnector | null = null;

export const setRedisConnectorInstance = (connector: RedisConnector) => {
    redisConnectorInstance = connector;
};

/** Estado de Redis para diagnósticos; 'desconectado' si aún no se inicializó. */
export const redisEstado = (): RedisEstado => redisConnectorInstance?.estado() ?? 'desconectado';

export const getRedisConnector = (): RedisConnector => {
    if (!redisConnectorInstance) {
        throw new Error('Redis connector not initialized.');
    }
    return redisConnectorInstance;
};

export const createRedisRepository = (getDb: () => (Redis | Promise<Redis>), keyPrefix: string) => {
    const promiseFunct = (err: any, response: any, resolve: (value: any) => void, reject: (reason?: any) => void) => {
        if (err) reject(err);
        else resolve(response);
    };

    const resolveDb = async (): Promise<Redis> => {
        const dbOrPromise = getDb();
        return dbOrPromise instanceof Promise ? await dbOrPromise : dbOrPromise;
    };

    return {
        find: async (_id: string) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.get(_id, (err, response) => promiseFunct(err, response, resolve, reject));
            });
        },
        saveTTL: async (_id: string, _data: any, ttl: number) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.set(_id, _data, (err, response) => {
                    if (err) reject(err);
                    else {
                        db.expire(_id, ttl);
                        resolve(response);
                    }
                });
            });
        },
        findKeys: async (_id: string) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.keys(_id, (err, response) => {
                    if (response && response.length > 0) {
                        promiseFunct(err, response, resolve, reject);
                    } else {
                        promiseFunct(null, ['No genero datos'], resolve, reject);
                    }
                });
            });
        },

        findAll: async () => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.keys(keyPrefix + '*', (err, response) => {
                    if (response && response.length > 0) {
                        db.mget(response, (err, response2) => {
                            promiseFunct(err, response2, resolve, reject);
                        });
                    } else {
                        promiseFunct(null, ['No genero datos'], resolve, reject);
                    }
                });
            });
        },

        save: async (_id: string, _data: any) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.set(_id, _data, (err, response) => {
                    promiseFunct(err, response, resolve, reject);
                });
            });
        },

        addTTL: async (_id: string, ttl: number) => {
            const db = await resolveDb();
            return db.expire(_id, ttl);
        },

        getTTL: async (_id: string) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.ttl(_id, (err, response) => {
                    promiseFunct(err, response, resolve, reject);
                });
            });
        },

        incr: async (_id: string) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.incr(_id, (err, response) => {
                    promiseFunct(err, response, resolve, reject);
                });
            });
        },

        sadd: async (_id: string, _data: any) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.sadd(_id, _data, (err, response) => {
                    promiseFunct(err, response, resolve, reject);
                });
            });
        },

        sismember: async (_id: string, _data: any) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.sismember(_id, _data, (err, response) => {
                    promiseFunct(err, response, resolve, reject);
                });
            });
        },

        sisremove: async (_id: string, _data: any) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.srem(_id, _data, (err, response) => {
                    promiseFunct(err, response, resolve, reject);
                });
            });
        },

        smembers: async (_id: string) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.smembers(_id, (err, response) => {
                    promiseFunct(err, response, resolve, reject);
                });
            });
        },

        sdiff: async (keys: string[]) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.sdiff(keys, (err, response) => {
                    promiseFunct(err, response, resolve, reject);
                });
            });
        },

        clear: async (key: string) => {
            const db = await resolveDb();
            return new Promise((resolve, reject) => {
                db.del(key, (err, response) => {
                    promiseFunct(err, response, resolve, reject);
                });
            });
        }
    };
};

export function createRedisConnector(urlOrOptions: string | RedisOptions): RedisConnector {
    const connector = new RedisConnector(urlOrOptions);
    setRedisConnectorInstance(connector);
    return connector;
}
