import { Redis, RedisOptions } from 'ioredis';

const logger = {
    info: (msg: string) => console.log(msg),
    error: (msg: string) => console.error(msg),
};

export class RedisConnector {
    private defaultClient: Redis | null = null;
    private clients: Map<number, Redis> = new Map();
    private options: RedisOptions = {};
    private defaultDb: number = 0;
    private host?: string;

    constructor(optionsOrUrl: RedisOptions | string) {
        if (typeof optionsOrUrl === 'string') {
            this.options = {
                retryStrategy: (times: number) => Math.min(times * 50, 2000)
            };
            this.host = undefined; 
            (this as any).url = optionsOrUrl; 
        } else {
            this.options = {
                retryStrategy: (times: number) => Math.min(times * 50, 2000),
                ...optionsOrUrl
            };
            this.defaultDb = optionsOrUrl.db || 0;
            this.host = optionsOrUrl.host;
        }
    }

    async connect(): Promise<void> {
        if (this.defaultClient) {
            logger.info('Redis default client already connected');
            return;
        }
        try {
            this.defaultClient = this.createClient(this.defaultDb);
            this.clients.set(this.defaultDb, this.defaultClient);
            await this.defaultClient.connect();
        } catch (error) {
            logger.error(`Failed to connect to Redis: ${error}`);
            throw error;
        }
    }

    private createClient(db: number): Redis {
        let client: Redis;
        const url = (this as any).url;

        if (url) {
             client = new Redis(url, { ...this.options, db, lazyConnect: true });
        } else {
            client = new Redis({ ...this.options, db, lazyConnect: true });
        }

        client.on('connect', () => logger.info(`🔴 Redis connected to db ${db}`));
        client.on('error', (err) => logger.error(`Redis error on db ${db}: ${err}`));
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
            if (client.status === 'wait') await client.connect();
            return client;
        }
        const newClient = this.createClient(db);
        this.clients.set(db, newClient);
        await newClient.connect();
        return newClient;
    }
}

export let redisConnectorInstance: RedisConnector | null = null;

export const setRedisConnectorInstance = (connector: RedisConnector) => {
    redisConnectorInstance = connector;
};

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
