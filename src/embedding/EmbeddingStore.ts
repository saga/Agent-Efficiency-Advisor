// EmbeddingStore — SQLite-backed vector storage with cosine similarity search.
// v6.md Section 4: "Embedding 可以重新计算" — embeddings are derived data, never the source of truth.

import type Database from 'better-sqlite3';
import type { EmbeddingEntityType, EmbeddingRow, SimilarityResult } from './types.js';

export class EmbeddingStore {
  constructor(private db: Database.Database) {}

  write(entityId: string, entityType: EmbeddingEntityType, model: string, vector: number[]): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (entity_id, entity_type, model, dim, vector, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entityId, entityType, model, vector.length, JSON.stringify(vector), Date.now());
  }

  read(entityId: string, entityType: EmbeddingEntityType, model?: string): EmbeddingRow | undefined {
    const sql = model
      ? 'SELECT * FROM embeddings WHERE entity_id = ? AND entity_type = ? AND model = ?'
      : 'SELECT * FROM embeddings WHERE entity_id = ? AND entity_type = ? ORDER BY created_at DESC LIMIT 1';
    const params = model ? [entityId, entityType, model] : [entityId, entityType];
    const row = this.db.prepare(sql).get(...params) as any;
    if (!row) return undefined;
    return rowToEmbedding(row);
  }

  readAll(entityType: EmbeddingEntityType, model?: string): EmbeddingRow[] {
    const sql = model
      ? 'SELECT * FROM embeddings WHERE entity_type = ? AND model = ?'
      : 'SELECT * FROM embeddings WHERE entity_type = ?';
    const params = model ? [entityType, model] : [entityType];
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(rowToEmbedding);
  }

  /**
   * Search for the top-K most similar entities by cosine similarity.
   * Pure TS computation — fast enough for hundreds to thousands of vectors.
   */
  search(queryVector: number[], entityType: EmbeddingEntityType, topK = 10, model?: string): SimilarityResult[] {
    const all = this.readAll(entityType, model);
    const scored = all.map((row) => ({
      entityId: row.entityId,
      entityType: row.entityType,
      similarity: cosineSimilarity(queryVector, row.vector),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  /** 删除超过指定天数的旧 embedding */
  prune(olderThanDays: number): number {
    const cutoff = Date.now() - olderThanDays * 86400000;
    const result = this.db.prepare('DELETE FROM embeddings WHERE created_at < ?').run(cutoff);
    return Number(result.changes);
  }

  count(entityType?: EmbeddingEntityType): number {
    const sql = entityType
      ? 'SELECT COUNT(*) AS n FROM embeddings WHERE entity_type = ?'
      : 'SELECT COUNT(*) AS n FROM embeddings';
    const row = (entityType ? this.db.prepare(sql).get(entityType) : this.db.prepare(sql).get()) as { n: number };
    return row.n;
  }
}

function rowToEmbedding(row: any): EmbeddingRow {
  return {
    entityId: row.entity_id,
    entityType: row.entity_type,
    model: row.model,
    dim: row.dim,
    vector: JSON.parse(row.vector),
    createdAt: row.created_at,
  };
}

/**
 * Cosine similarity between two vectors. Returns 0..1 for non-negative vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * L2-normalize a vector to unit length (for cosine similarity precomputation).
 */
export function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
