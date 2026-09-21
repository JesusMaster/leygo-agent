import mongoose from 'mongoose';
import { getMongoDBConnector } from './client.js';

export function resolveConnection(name: string = 'default'): mongoose.Connection {
    if (name === 'default' || name === 'primary') {
        return mongoose.connection;
    }

    const secondary = getMongoDBConnector().getSecondaryConnection(name);
    if (!secondary) {
        throw new Error(`Database connection "${name}" not found`);
    }

    return secondary;
}
