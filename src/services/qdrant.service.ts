import { QdrantClient } from '@qdrant/js-client-rest';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export interface KnowledgePayload {
  source: 'obsidian' | 'google_chat' | 'gmail' | 'google_meet';
  /** Modelo con el que se generó el vector. Permite detectar puntos de otro espacio vectorial. */
  embeddingModel?: string;
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
  private ollamaUrl: string;
  private ollamaModel: string;

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

    this.ollamaUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL || 'https://ollama.openip.cl';
    this.ollamaModel = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text:latest';

    if (process.env.EMBEDDING_PROVIDER && process.env.EMBEDDING_PROVIDER !== 'ollama') {
      console.warn(
        `⚠️ [Qdrant] EMBEDDING_PROVIDER="${process.env.EMBEDDING_PROVIDER}" ignorado: las colecciones usan exclusivamente ${this.ollamaModel} vía Ollama.`
      );
    }
  }

  /**
   * Genera el vector de embedding con Ollama.
   *
   * SIN FALLBACK A OTRO PROVEEDOR: un vector de Gemini tiene las mismas 768
   * dimensiones pero pertenece a otro espacio semántico. Entra en la colección sin
   * error y arruina en silencio la similitud contra todo lo indexado con
   * nomic-embed-text. Si Ollama no responde, es preferible fallar.
   */
  async generateEmbedding(text: string, retries: number = 3): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('No se puede generar embedding para texto vacío.');
    }

    // nomic-embed-text admite hasta 2048 tokens (~8000 caracteres)
    const safeText = text.length > 5000 ? text.substring(0, 5000) : text;
    let lastError: any = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await axios.post(
          `${this.ollamaUrl}/api/embed`,
          { model: this.ollamaModel, input: safeText, truncate: true },
          { timeout: 30000 }
        );
        const embedding = res.data?.embeddings?.[0];
        if (Array.isArray(embedding) && embedding.length > 0) {
          return embedding;
        }
        lastError = new Error('Ollama respondió sin vector de embedding.');
      } catch (err: any) {
        lastError = err;

        // Endpoint legacy de instalaciones antiguas de Ollama
        try {
          const legacyRes = await axios.post(
            `${this.ollamaUrl}/api/embeddings`,
            { model: this.ollamaModel, prompt: safeText },
            { timeout: 30000 }
          );
          const legacyEmbedding = legacyRes.data?.embedding;
          if (Array.isArray(legacyEmbedding) && legacyEmbedding.length > 0) {
            return legacyEmbedding;
          }
        } catch (legacyErr: any) {
          lastError = legacyErr;
        }
      }

      if (attempt < retries) {
        const waitMs = attempt * 1500;
        console.warn(`⏳ [Qdrant] Ollama no respondió (intento ${attempt}/${retries}). Reintentando en ${waitMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    throw new Error(
      `No se pudo generar el embedding con Ollama (${this.ollamaUrl}, modelo ${this.ollamaModel}) tras ${retries} intentos: ${lastError?.message || lastError}. ` +
      `No se usa otro proveedor a propósito: mezclaría espacios vectoriales.`
    );
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
          payload: { ...payload, embeddingModel: this.ollamaModel },
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

    // Se devuelve el payload COMPLETO: recortarlo dejaba fuera participantes,
    // decisiones, tareas y el link a la minuta, que es lo que permite verificar.
    return points.map((r: any) => ({
      ...(r.payload || {}),
      score: r.score,
      id: r.id,
    }));
  }
}

export const qdrantService = new QdrantKnowledgeService();
