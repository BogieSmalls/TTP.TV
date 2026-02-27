import type { Config } from '../config.js';

export interface KnowledgeResult {
  text: string;
  similarity: number;
  source: string;
  sourceUrl: string;
  pageTitle: string;
  section: string;
  category: string;
}

export interface KnowledgeStatus {
  available: boolean;
  chromaConnected: boolean;
  ollamaConnected: boolean;
  collectionSize: number;
}

const CHROMA_TENANT = 'default_tenant';
const CHROMA_DATABASE = 'default_database';

export class KnowledgeBaseService {
  private readonly chromaUrl: string;
  private readonly chromaCollection: string;
  private readonly ollamaUrl: string;
  private readonly embeddingModel: string;
  private readonly chromaBase: string;

  constructor(config: Config) {
    this.chromaUrl = config.knowledgeBase.chromaUrl;
    this.chromaCollection = config.knowledgeBase.chromaCollection;
    this.ollamaUrl = config.knowledgeBase.ollamaUrl;
    this.embeddingModel = config.knowledgeBase.embeddingModel;
    this.chromaBase = `${this.chromaUrl}/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}`;
  }

  async query(text: string, options?: { nResults?: number; source?: string }): Promise<KnowledgeResult[]> {
    const nResults = options?.nResults ?? 5;

    // 1. Embed the query text via Ollama
    const embedding = await this.embed(text);

    // 2. Query ChromaDB
    const queryBody: Record<string, unknown> = {
      query_embeddings: [embedding],
      n_results: nResults,
      include: ['documents', 'metadatas', 'distances'],
    };

    if (options?.source) {
      queryBody.where = { source: options.source };
    }

    const collectionId = await this.getCollectionId();
    const resp = await fetch(
      `${this.chromaBase}/collections/${collectionId}/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(queryBody),
      },
    );

    if (!resp.ok) {
      throw new Error(`ChromaDB query failed: ${resp.status} ${await resp.text()}`);
    }

    const data = await resp.json() as {
      documents: string[][];
      metadatas: Record<string, string>[][];
      distances: number[][];
    };

    const documents = data.documents?.[0] ?? [];
    const metadatas = data.metadatas?.[0] ?? [];
    const distances = data.distances?.[0] ?? [];

    return documents.map((doc, i) => ({
      text: doc,
      similarity: 1.0 - (distances[i] ?? 1),
      source: metadatas[i]?.source ?? 'unknown',
      sourceUrl: metadatas[i]?.source_url ?? '',
      pageTitle: metadatas[i]?.page_title ?? '',
      section: metadatas[i]?.section ?? '',
      category: metadatas[i]?.category ?? '',
    }));
  }

  async addDocuments(
    documents: string[],
    metadatas: Record<string, string>[],
    ids: string[],
  ): Promise<void> {
    const embeddings: number[][] = [];
    for (const doc of documents) {
      embeddings.push(await this.embed(doc));
    }

    const collectionId = await this.getCollectionId();
    const resp = await fetch(
      `${this.chromaBase}/collections/${collectionId}/add`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, embeddings, documents, metadatas }),
      },
    );

    if (!resp.ok) {
      throw new Error(`ChromaDB add failed: ${resp.status} ${await resp.text()}`);
    }
  }

  async isAvailable(): Promise<KnowledgeStatus> {
    const status: KnowledgeStatus = {
      available: false,
      chromaConnected: false,
      ollamaConnected: false,
      collectionSize: 0,
    };

    // Check ChromaDB
    try {
      const resp = await fetch(`${this.chromaUrl}/api/v2/heartbeat`, { signal: AbortSignal.timeout(3000) });
      status.chromaConnected = resp.ok;
    } catch {
      // not reachable
    }

    // Check Ollama
    try {
      const resp = await fetch(`${this.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      status.ollamaConnected = resp.ok;
    } catch {
      // not reachable
    }

    // Check collection size
    if (status.chromaConnected) {
      try {
        const id = await this.getCollectionId();
        const resp = await fetch(`${this.chromaBase}/collections/${id}/count`);
        if (resp.ok) {
          status.collectionSize = await resp.json() as number;
        }
      } catch {
        // collection may not exist yet
      }
    }

    status.available = status.chromaConnected && status.ollamaConnected && status.collectionSize > 0;
    return status;
  }

  private async embed(text: string): Promise<number[]> {
    const resp = await fetch(`${this.ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.embeddingModel,
        input: text,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Ollama embed failed: ${resp.status} ${await resp.text()}`);
    }

    const data = await resp.json() as { embeddings: number[][] };
    return data.embeddings[0];
  }

  private _collectionId: string | null = null;

  private async getCollectionId(): Promise<string> {
    if (this._collectionId) return this._collectionId;

    const resp = await fetch(`${this.chromaBase}/collections/${this.chromaCollection}`);
    if (!resp.ok) {
      throw new Error(`ChromaDB collection '${this.chromaCollection}' not found. Run 'python scrape.py' first.`);
    }

    const data = await resp.json() as { id: string };
    this._collectionId = data.id;
    return data.id;
  }
}
