import mongoose from 'mongoose';

export interface MongoDBOptions {
    uri: string;
    options?: mongoose.ConnectOptions;
    secondaryConnections?: Record<string, string>;
}

export class MongoDBConnector {
    private uri: string;
    private options: mongoose.ConnectOptions;
    private secondaryConnectionsConfig: Record<string, string> = {};
    private isConnected = false;
    private secondaryConnections: Map<string, mongoose.Connection> = new Map();

    constructor(config: MongoDBOptions) {
        this.uri = config.uri;
        this.options = config.options || {};
        this.secondaryConnectionsConfig = config.secondaryConnections || {};
    }

    async connect(): Promise<void> {
        if (this.isConnected) return;
        try {
            await mongoose.connect(this.uri, this.options);
            this.isConnected = true;
            console.log('✅ Primary MongoDB connected');

            const secondaryPromises = Object.entries(this.secondaryConnectionsConfig).map(async ([name, uri]) => {
                const conn = mongoose.createConnection(uri, this.options);
                await conn.asPromise();
                this.secondaryConnections.set(name, conn);
                console.log(`✅ Secondary MongoDB '${name}' connected`);
            });
            await Promise.all(secondaryPromises);
        } catch (error) {
            console.error('MongoDB connection error:', error);
            throw error;
        }
    }

    getSecondaryConnection(name: string): mongoose.Connection | undefined {
        return this.secondaryConnections.get(name);
    }
}

export function createMongoDBConnector(uri: string, secondaryConnections?: Record<string, string>): MongoDBConnector {
    return new MongoDBConnector({ uri, secondaryConnections });
}
