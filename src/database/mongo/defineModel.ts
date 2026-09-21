import mongoose, { Schema, Model, IndexOptions } from 'mongoose';
import { resolveConnection } from './connection.js';

export interface IndexDefinition {
    fields: Record<string, 1 | -1 | string>;
    options?: IndexOptions;
}

export interface DefineModelOptions<T> {
    name: string;
    collection: string;
    definition: Record<string, unknown>;
    connection?: string;
    indexes?: IndexDefinition[];
    configure?: (schema: Schema) => void;
}

export function defineModel<T>(options: DefineModelOptions<T>): () => Model<T> {
    let modelInstance: Model<T> | null = null;

    return (): Model<T> => {
        if (modelInstance) return modelInstance;

        const connectionName = options.connection || 'default';
        const conn = resolveConnection(connectionName);

        const schema: Schema = new Schema(options.definition as never, {
            timestamps: true,
            collection: options.collection,
        });

        if (options.indexes && options.indexes.length > 0) {
            for (const idx of options.indexes) {
                schema.index(idx.fields as never, idx.options);
            }
        }

        if (options.configure) {
            options.configure(schema);
        }

        modelInstance = conn.model(options.name, schema) as unknown as Model<T>;
        return modelInstance;
    };
}
