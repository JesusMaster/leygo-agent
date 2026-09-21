import { MongoDBConnector } from '../mongo.js';
import mongoose from 'mongoose';

let mongoConnector: MongoDBConnector | null = null;

export function setMongoDBConnector(connector: MongoDBConnector): void {
    mongoConnector = connector;
}

export function getMongoDBConnector(): MongoDBConnector {
    if (!mongoConnector) {
        throw new Error('MongoDB connector not initialized. Make sure to connect in main.ts');
    }
    return mongoConnector;
}

export function getSecondaryConnection(name: string): mongoose.Connection | undefined {
    return getMongoDBConnector().getSecondaryConnection(name);
}
