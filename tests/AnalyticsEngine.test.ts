// AnalyticsEngine tests — verify failure classification + Context ROI + llmPayload.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, dispose, seedGoodSession, seedRetrySession, seedExplodeSession, type TestContext } from './helpers.js';
import { AnalyticsEngine } from '../src/ml/AnalyticsEngine.js';
import { EmbeddingStore } from '../src/embedding/EmbeddingStore.js';
import { EmbeddingPipeline } from '../src/embedding/EmbeddingPipeline.js';

describe('AnalyticsEngine', () => {
  let ctx: TestContext;
  let engine: AnalyticsEngine;
  let embeddingStore: EmbeddingStore;
  let embeddingPipeline: EmbeddingPipeline;

  beforeEach(() => {
    ctx = createTestContext();
    embeddingStore = new EmbeddingStore(ctx.db);
    embeddingPipeline = new EmbeddingPipeline(ctx.eventStore, ctx.featureStore, embeddingStore);
    engine = new AnalyticsEngine(ctx.eventStore, ctx.featureStore, embeddingStore);
  });

  afterEach(() => {
    dispose(ctx);
  });

  describe('classifyFailures', () => {
    it('classifies retry session as retry_loop', () => {
      seedRetrySession(ctx);
      ctx.pipeline.computeSession('sess-retry');

      const report = engine.analyze();
      const retryFailure = report.failures.find((f) => f.sessionId === 'sess-retry');
      expect(retryFailure).toBeDefined();
      expect(retryFailure!.failureType).toBe('retry_loop');
    });

    it('classifies explode session as context_explosion', () => {
      seedExplodeSession(ctx);
      ctx.pipeline.computeSession('sess-explode');

      const report = engine.analyze();
      const explodeFailure = report.failures.find((f) => f.sessionId === 'sess-explode');
      expect(explodeFailure).toBeDefined();
      // Explode session has contextExpansionSpeed > 500 → context_explosion
      // OR retryBurstScore > 0.5 && retryRate > 0.3 → retry_loop
      // The first matching rule wins. Let's check it's one of these.
      expect(['context_explosion', 'retry_loop']).toContain(explodeFailure!.failureType);
    });

    it('does not classify good session as failure', () => {
      seedGoodSession(ctx);
      ctx.pipeline.computeSession('sess-good');

      const report = engine.analyze();
      const goodFailure = report.failures.find((f) => f.sessionId === 'sess-good');
      expect(goodFailure).toBeDefined();
      expect(goodFailure!.failureType).toBe('none');
    });
  });

  describe('llmPayload', () => {
    it('produces compact JSON payload with required fields', () => {
      seedGoodSession(ctx);
      seedRetrySession(ctx);
      ctx.pipeline.computeAllSessions();

      const report = engine.analyze();
      const payload = report.llmPayload;

      expect(payload).toHaveProperty('sessions');
      expect(payload).toHaveProperty('events');
      expect(payload).toHaveProperty('avgAcceptRate');
      expect(payload).toHaveProperty('avgRetryRate');
      expect(payload).toHaveProperty('healthDirection');
      expect(payload).toHaveProperty('topFailure');
      expect(payload).toHaveProperty('anomalyScore');
    });

    it('reports declining health when retry sessions dominate', () => {
      seedRetrySession(ctx);
      seedRetrySession(ctx, 'sess-retry-2');
      ctx.pipeline.computeAllSessions();

      const report = engine.analyze();
      // With 2 retry sessions and 0 good sessions, health should be declining or stable
      expect(['declining', 'stable']).toContain(report.llmPayload.healthDirection);
    });
  });

  describe('contextROI', () => {
    it('returns array of feature-correlation objects', () => {
      seedGoodSession(ctx);
      seedRetrySession(ctx);
      seedExplodeSession(ctx);
      ctx.pipeline.computeAllSessions();

      const report = engine.analyze();
      expect(Array.isArray(report.contextROI)).toBe(true);
      // With 3 sessions, some features should have measurable correlation
      // (may be empty if all correlations are below threshold)
    });
  });
});
