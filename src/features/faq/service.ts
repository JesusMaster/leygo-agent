import axios from 'axios';
import { getFaqModel, IFaq } from '../../database/mongo/models/faq.model.js';

interface EmbeddingResponse {
    embedding: number[];
}

export class FaqService {
  private baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

  async getAll(): Promise<IFaq[]> {
    return getFaqModel().find();
  }

  async create(name: string): Promise<IFaq> {
    return getFaqModel().create({ name });
  }

  protected async post<T>(endpoint: string, data: Record<string, any>): Promise<T> {
    const response = await axios.post(`${this.baseUrl}/${endpoint}`, data, {
        timeout: 10000,
    });
    return response.data;
  }

  async search(question: string, pais: string = 'es_cl'): Promise<IFaq[]> {
    const query = {
        model: "nomic-embed-text:latest",
        prompt: question
    };

    const response = await this.post<EmbeddingResponse>('api/embeddings', query);

    const result = await getFaqModel().aggregate([
      {
        "$vectorSearch": {
          "index": "vector_question",
          "path": "embedding",
          "queryVector": response.embedding ?? [],
          "exact": false,
          "numCandidates": 20,
          "limit": 10,
          "filter": {
            "pais": pais
          }
        }
      },
      {
        "$project": {
          "_id": 0,
          "pregunta": 1,
          "respuesta": 1,
          "score": { "$meta": "vectorSearchScore" }
        }
      }
    ]);

    return result as IFaq[];

  }
}

export const faqService = new FaqService();