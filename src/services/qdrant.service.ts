import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export interface KnowledgePayload {
  source: 'obsidian' | 'google_chat' | 'gmail' | 'google_meet';
  title: string;
  filePath?: string;
  section?: string;
  tags?: string[];
  links?: string[];
  date?: string;
  author?: string;
  participants?: string[];
  content: string;
  [key: string]: any;
}

export class QdrantKnowledgeService {
  private client: QdrantClient;
  private ai: GoogleGenAI;
  private ollamaUrl: string;
  private ollamaModel: string;
  private provider: 'ollama' | 'gemini';

  public static CORE_COLLECTION = 'core_knowledge';
  public static EPISODIC_COLLECTION = 'episodic_memory';
  public static EMBEDDING_DIM = 768; // nomic-embed-text y gemini con dim 768

  constructor() {
    const url = process.env.QDRANT_URL || 'http://localhost:6333';
    const apiKey = process.env.QDRANT_API_KEY || undefined;

    this.client = new QdrantClient({
      url,
      apiKey,
      checkCompatibility: false,
    });

    const geminiKey = process.env.GEMINI_API_KEY || '';
    this.ai = new GoogleGenAI({ apiKey: geminiKey });

    this.ollamaUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL || 'https://ollama.openip.cl';
    this.ollamaModel = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text:latest';
    this.provider = (process.env.EMBEDDING_PROVIDER as 'ollama' | 'gemini') || 'ollama';
  }

  /**
   * Genera el vector de embedding usando Ollama (local/remoto) o Gemini (nube)
   */
  async generateEmbedding(text: string, retries: number = 3): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('No se puede generar embedding para texto vacío.');
    }

    // Red de seguridad: nomic-embed-text admite hasta 2048 tokens (~8000 caracteres)
    const safeText = text.length > 5000 ? text.substring(0, 5000) : text;

    // 1. Intentar con Ollama (ollama.openip.cl o local)
    if (this.provider === 'ollama') {
      try {
        const res = await axios.post(`${this.ollamaUrl}/api/embed`, {
          model: this.ollamaModel,
          input: safeText,
          truncate: true,
        });

        const embedding = res.data?.embeddings?.[0];
        if (embedding && Array.isArray(embedding) && embedding.length > 0) {
          return embedding;
        }
      } catch (err: any) {
        // Fallback al endpoint tradicional /api/embeddings
        try {
          const legacyRes = await axios.post(`${this.ollamaUrl}/api/embeddings`, {
            model: this.ollamaModel,
            prompt: text,
          });
          const legacyEmbedding = legacyRes.data?.embedding;
          if (legacyEmbedding && Array.isArray(legacyEmbedding) && legacyEmbedding.length > 0) {
            return legacyEmbedding;
          }
        } catch (legacyErr: any) {
          console.warn(`[Qdrant] Error con Ollama (${err.message}). Intentando fallback con Gemini...`);
        }
      }
    }

    // 2. Fallback o uso directo con Google Gemini
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await this.ai.models.embedContent({
          model: 'gemini-embedding-001',
          contents: text,
          config: {
            outputDimensionality: QdrantKnowledgeService.EMBEDDING_DIM,
          },
        });

        const values = response.embeddings?.[0]?.values;
        if (!values || values.length === 0) {
          throw new Error('La API de Gemini no retornó valores de embedding.');
        }

        return values;
      } catch (err: any) {
        if (attempt < retries && (err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED') || err.status === 429)) {
          const waitTime = attempt * 2000;
          console.log(`\n⏳ Cuota de Gemini alcanzada temporalmente. Esperando ${waitTime / 1000}s para reintentar...`);
          await new Promise((r) => setTimeout(r, waitTime));
          continue;
        }
        throw err;
      }
    }

    throw new Error('No se pudo generar el embedding después de varios reintentos.');
  }

  /**
   * Asegura que las colecciones necesarias existan en Qdrant
   */
  async ensureCollections(): Promise<void> {
    const collections = [
      QdrantKnowledgeService.CORE_COLLECTION,
      QdrantKnowledgeService.EPISODIC_COLLECTION,
    ];

    for (const name of collections) {
      try {
        const exists = await this.client.collectionExists(name);
        if (!exists.exists) {
          console.log(`[Qdrant] Creando colección "${name}"...`);
          await this.client.createCollection(name, {
            vectors: {
              size: QdrantKnowledgeService.EMBEDDING_DIM,
              distance: 'Cosine',
            },
          });
          console.log(`[Qdrant] Colección "${name}" creada exitosamente.`);
        }
      } catch (err: any) {
        console.warn(`[Qdrant] Error al verificar/crear colección "${name}":`, err.message);
      }
    }
  }

  /**
   * Inserta o actualiza un documento/chunk en Qdrant
   */
  async upsertKnowledge(
    collectionName: string,
    id: string | number,
    payload: KnowledgePayload
  ): Promise<void> {
    const embeddingText = `${payload.title}\n${payload.section ? `Sección: ${payload.section}\n` : ''}${payload.tags ? `Tags: ${payload.tags.join(', ')}\n` : ''}\n${payload.content}`;
    const vector = await this.generateEmbedding(embeddingText);

    await this.client.upsert(collectionName, {
      wait: true,
      points: [
        {
          id,
          vector,
          payload,
        },
      ],
    });
  }

  /**
   * Busca información semántica en la base de conocimientos
   */
  async searchKnowledge(
    collectionName: string,
    query: string,
    limit: number = 5,
    filter?: any
  ) {
    const queryVector = await this.generateEmbedding(query);

    const res = await this.client.query(collectionName, {
      query: queryVector,
      limit,
      filter,
      with_payload: true,
    });

    const points = res.points || [];

    return points.map((r: any) => ({
      score: r.score,
      id: r.id,
      title: r.payload?.title,
      section: r.payload?.section,
      filePath: r.payload?.filePath,
      tags: r.payload?.tags,
      content: r.payload?.content,
      source: r.payload?.source,
      date: r.payload?.date,
      author: r.payload?.author,
    }));
  }
}

export const qdrantService = new QdrantKnowledgeService();
