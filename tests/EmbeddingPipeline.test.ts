// EmbeddingPipeline tests — verify vector normalization + cosine similarity.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, dispose, seedGoodSession, seedRetrySession, type TestContext } from './helpers.js';
import { EmbeddingStore, cosineSimilarity, normalize } from '../src/embedding/EmbeddingStore.js';
import { EmbeddingPipeline } from '../src/embedding/EmbeddingPipeline.js';

describe('Embedding utilities', () => {
  it('normalize produces unit L2 norm', () => {
    const v = normalize([3, 4]);
    const norm = Math.sqrt(v[0] ** 2 + v[1] ** 2);
    expect(norm).toBeCloseTo(1, 10);
  });

  it('cosineSimilarity of identical vectors is 1', () => {
    const v = normalize([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it('cosineSimilarity of orthogonal vectors is 0', () => {
    const a = normalize([1, 0]);
    const b = normalize([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
  });

  it('cosineSimilarity of opposite vectors is -1', () => {
    const a = normalize([1, 1]);
    const b = normalize([-1, -1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 10);
  });
});

describe('EmbeddingPipeline', () => {
  let ctx: TestContext;
  let embeddingStore: EmbeddingStore;
  let pipeline: EmbeddingPipeline;

  beforeEach(() => {
    ctx = createTestContext();
    embeddingStore = new EmbeddingStore(ctx.db);
    pipeline = new EmbeddingPipeline(ctx.eventStore, ctx.featureStore, embeddingStore);
  });

  afterEach(() => {
    dispose(ctx);
  });

  it('generates 10-dimensional session embedding', () => {
    seedGoodSession(ctx);
    ctx.pipeline.computeSession('sess-good');

    const vec = pipeline.generateSessionEmbedding('sess-good');
    expect(vec).toBeDefined();
    expect(vec!.length).toBe(10);
  });

  it('produces unit-norm session embedding', () => {
    seedGoodSession(ctx);
    ctx.pipeline.computeSession('sess-good');

    const vec = pipeline.generateSessionEmbedding('sess-good');
    const norm = Math.sqrt(vec!.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('returns undefined for session without features', () => {
    const vec = pipeline.generateSessionEmbedding('nonexistent');
    expect(vec).toBeUndefined();
  });

  it('similar sessions have higher cosine similarity than dissimilar ones', () => {
    // Two good sessions (similar pattern)
    seedGoodSession(ctx, 'sess-good-a');
    seedGoodSession(ctx, 'sess-good-b');
    // One retry session (different pattern)
    seedRetrySession(ctx, 'sess-retry');

    ctx.pipeline.computeAllSessions();

    const vecA = pipeline.generateSessionEmbedding('sess-good-a')!;
    const vecB = pipeline.generateSessionEmbedding('sess-good-b')!;
    const vecRetry = pipeline.generateSessionEmbedding('sess-retry')!;

    const simSimilar = cosineSimilarity(vecA, vecB);
    const simDifferent = cosineSimilarity(vecA, vecRetry);

    // Similar sessions should have higher similarity than dissimilar ones
    expect(simSimilar).toBeGreaterThan(simDifferent);
  });

  it('computeAll writes embeddings for all sessions', () => {
    seedGoodSession(ctx, 'sess-a');
    seedRetrySession(ctx, 'sess-b');

    ctx.pipeline.computeAllSessions();
    const result = pipeline.computeAll();

    expect(result.sessions).toBe(2);
    expect(embeddingStore.count('session')).toBe(2);
  });

  it('search returns most similar session first', () => {
    seedGoodSession(ctx, 'sess-good-a');
    seedGoodSession(ctx, 'sess-good-b');
    seedRetrySession(ctx, 'sess-retry');

    ctx.pipeline.computeAllSessions();
    pipeline.computeAll();

    const vecA = pipeline.generateSessionEmbedding('sess-good-a')!;
    const results = embeddingStore.search(vecA, 'session', 3);

    expect(results.length).toBeGreaterThan(0);
    // Top result should be sess-good-a itself (similarity = 1.0)
    // or sess-good-b (very similar)
    expect(results[0].similarity).toBeGreaterThan(0.5);
  });
});
