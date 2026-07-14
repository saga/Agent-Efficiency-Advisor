// Embedding types — v6.md Section 4.
// Embeddings are for semantic entities (Session, Prompt, Workflow, Error),
// NOT for individual events.

export type EmbeddingEntityType = 'session' | 'prompt' | 'workflow' | 'error' | 'workspace';

export interface EmbeddingRow {
  entityId: string;
  entityType: EmbeddingEntityType;
  model: string;       // 'feature-v1' for local, or 'text-embedding-3-small' for API
  dim: number;
  vector: number[];
  createdAt: number;
}

export interface SimilarityResult {
  entityId: string;
  entityType: EmbeddingEntityType;
  similarity: number;
  metadata?: Record<string, unknown>;
}
