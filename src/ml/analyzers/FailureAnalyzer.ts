// FailureAnalyzer — v7.md #8: 从 AnalyticsEngine 拆分。
// 负责规则驱动的失败分类（CatBoost 可后续插入）。
// v6.md Section 7: categories = wrong_context, retry_loop, context_explosion, tool_error, user_cancel.

import type { Analyzer, AnalyzerContext } from './types.js';
import type { FailureClassification } from '../AnalyticsEngine.js';

export class FailureAnalyzer implements Analyzer<FailureClassification[]> {
  readonly id = 'failure';

  analyze(ctx: AnalyzerContext): FailureClassification[] {
    const results: FailureClassification[] = [];

    for (const sid of ctx.sessionIds) {
      const events = ctx.eventStore.getBySession(sid);
      const behavior = ctx.featureStore.read('behavior', sid);
      const session = ctx.featureStore.read('session', sid);
      if (!events.length) continue;

      const bf = behavior?.features ?? {};
      const sf = session?.features ?? {};
      const evidence: string[] = [];
      let failureType = 'none';
      let confidence = 0;

      if (bf.retryBurstScore > 0.5 && sf.retryRate > 0.3) {
        failureType = 'retry_loop';
        confidence = Math.min(1, bf.retryBurstScore + sf.retryRate);
        evidence.push(`retryBurstScore=${bf.retryBurstScore.toFixed(2)}`);
        evidence.push(`retryRate=${sf.retryRate.toFixed(2)}`);
      } else if (bf.contextExpansionSpeed > 500 || (sf.retryRate > 0.3 && bf.contextExpansionSpeed > 200)) {
        failureType = 'context_explosion';
        confidence = Math.min(1, bf.contextExpansionSpeed / 1000);
        evidence.push(`contextExpansionSpeed=${bf.contextExpansionSpeed.toFixed(0)}`);
      } else if (bf.workflowEntropy < 0.7 && sf.retryRate > 0.2) {
        failureType = 'wrong_context';
        confidence = 0.6;
        evidence.push(`workflowEntropy=${bf.workflowEntropy.toFixed(2)}`);
        evidence.push(`retryRate=${sf.retryRate.toFixed(2)}`);
      } else if (events[events.length - 1]?.eventType === 'reject' && sf.acceptCount === 0) {
        failureType = 'user_cancel';
        confidence = 0.8;
        evidence.push('session ends with reject, no accepts');
      }

      results.push({ sessionId: sid, failureType, confidence: Number(confidence.toFixed(3)), evidence });
    }

    return results;
  }
}
