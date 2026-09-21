import { Document, Model } from 'mongoose';
import { defineModel } from '../defineModel.js';

export interface IFaq extends Document {
    pregunta: string;
    respuesta: string;
    clasificacion: string;
    question?: string | null;
    embedding: number[];
    pais: string;
    createdAt: Date;
    updatedAt: Date;
}

export const getFaqModel: () => Model<IFaq> = defineModel<IFaq>({
    name: 'Faq',
    collection: 'qdrant_dataset',
    connection: 'default',
    definition: {
        pregunta: { type: String, required: true },
        respuesta: { type: String, required: true },
        clasificacion: { type: String, required: true },
        question: { type: String, default: null },
        embedding: { type: [Number], required: true },
        pais: { type: String, required: true }
    }
});
