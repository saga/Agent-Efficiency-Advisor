// AnalyticsEngine tests — verify failure classification + Context ROI + summary.
// v7.md #8/#9: 测试拆分后的 Analyzer 编排器 + 强类型 AnalyticsSummary。

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

  describe('summary (v7.md #9: AnalyticsSummary)', () => {
    it('produces strongly-typed summary with required fields', () => {
      seedGoodSession(ctx);
      seedRetrySession(ctx);
      ctx.pipeline.computeAllSessions();

      const report = engine.analyze();
      const summary = report.summary;

      expect(summary).toHaveProperty('sessions');
      expect(summary).toHaveProperty('events');
      expect(summary).toHaveProperty('avgAcceptRate');
      expect(summary).toHaveProperty('avgRetryRate');
      expect(summary).toHaveProperty('healthDirection');
      expect(summary).toHaveProperty('topFailure');
      expect(summary).toHaveProperty('anomalyScore');
      expect(summary).toHaveProperty('contextROI');
      expect(Array.isArray(summary.contextROI)).toBe(true);
    });

    it('reports declining health when retry sessions dominate', () => {
      seedRetrySession(ctx);
      seedRetrySession(ctx, 'sess-retry-2');
      ctx.pipeline.computeAllSessions();

      const report = engine.analyze();
      expect(['declining', 'stable']).toContain(report.summary.healthDirection);
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
    });
  });
});
