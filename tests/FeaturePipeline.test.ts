// FeaturePipeline tests — verify session + behavior feature computation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, dispose, seedGoodSession, seedRetrySession, seedExplodeSession, type TestContext } from './helpers.js';

describe('FeaturePipeline', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    dispose(ctx);
  });

  describe('computeSession (session features)', () => {
    it('computes correct acceptRate and retryRate for good session', () => {
      seedGoodSession(ctx);
      ctx.pipeline.computeSession('sess-good');

      const feat = ctx.featureStore.read('session', 'sess-good');
      expect(feat).toBeDefined();
      expect(feat!.features.completionCount).toBe(1);
      expect(feat!.features.acceptCount).toBe(1);
      expect(feat!.features.rejectCount).toBe(0);
      expect(feat!.features.retryCount).toBe(0);
      expect(feat!.features.acceptRate).toBe(1);
      expect(feat!.features.retryRate).toBe(0);
    });

    it('computes correct retryRate for retry session', () => {
      seedRetrySession(ctx);
      ctx.pipeline.computeSession('sess-retry');

      const feat = ctx.featureStore.read('session', 'sess-retry');
      expect(feat).toBeDefined();
      expect(feat!.features.retryCount).toBe(3);
      expect(feat!.features.completionCount).toBe(1);
      expect(feat!.features.retryRate).toBe(3); // 3 retries / 1 completion
    });

    it('computes correct acceptRate for explode session (0 accepts, 1 reject)', () => {
      seedExplodeSession(ctx);
      ctx.pipeline.computeSession('sess-explode');

      const feat = ctx.featureStore.read('session', 'sess-explode');
      expect(feat).toBeDefined();
      expect(feat!.features.acceptCount).toBe(0);
      expect(feat!.features.rejectCount).toBe(1);
      expect(feat!.features.acceptRate).toBe(0);
    });
  });

  describe('computeSession (behavior features)', () => {
    it('computes workflowEntropy in [0, 1] range', () => {
      seedGoodSession(ctx);
      ctx.pipeline.computeSession('sess-good');

      const feat = ctx.featureStore.read('behavior', 'sess-good');
      expect(feat).toBeDefined();
      const entropy = feat!.features.workflowEntropy;
      expect(entropy).toBeGreaterThanOrEqual(0);
      expect(entropy).toBeLessThanOrEqual(1);
    });

    it('computes retryBurstScore = 1.0 for consecutive retries', () => {
      seedRetrySession(ctx);
      ctx.pipeline.computeSession('sess-retry');

      const feat = ctx.featureStore.read('behavior', 'sess-retry');
      expect(feat).toBeDefined();
      // 3 consecutive retries out of 3 total → burst score = 1.0
      expect(feat!.features.retryBurstScore).toBe(1);
    });

    it('computes avgReadBeforeAsk > 0 when files are read before chat', () => {
      seedGoodSession(ctx);
      ctx.pipeline.computeSession('sess-good');

      const feat = ctx.featureStore.read('behavior', 'sess-good');
      expect(feat).toBeDefined();
      // Good session reads 2 files before 1 chat → avg = 2
      expect(feat!.features.avgReadBeforeAsk).toBeGreaterThan(0);
    });

    it('computes workflowLength matching event count', () => {
      seedExplodeSession(ctx);
      ctx.pipeline.computeSession('sess-explode');

      const feat = ctx.featureStore.read('behavior', 'sess-explode');
      expect(feat).toBeDefined();
      // Explode session has 10 events
      expect(feat!.features.workflowLength).toBe(10);
    });

    it('computes contextExpansionSpeed > 0 when tokens grow', () => {
      seedExplodeSession(ctx);
      ctx.pipeline.computeSession('sess-explode');

      const feat = ctx.featureStore.read('behavior', 'sess-explode');
      expect(feat).toBeDefined();
      // Explode session has 12000 context tokens → speed > 0
      expect(feat!.features.contextExpansionSpeed).toBeGreaterThan(0);
    });
  });

  describe('computeAllSessions', () => {
    it('computes features for all sessions in the store', () => {
      seedGoodSession(ctx);
      seedRetrySession(ctx);
      seedExplodeSession(ctx);

      const result = ctx.pipeline.computeAllSessions();
      expect(result.sessions).toBe(3);

      expect(ctx.featureStore.read('session', 'sess-good')).toBeDefined();
      expect(ctx.featureStore.read('session', 'sess-retry')).toBeDefined();
      expect(ctx.featureStore.read('session', 'sess-explode')).toBeDefined();
    });
  });
});
