/**
 * @legacy V1/V2 历史分析模块
 *
 * 此模块属于 V1/V2 遗留代码,保留用于离线训练数据参考。
 * 新代码应使用 V6/V7 的 src/store/ (EventStore/FeatureStore) 和 src/ml/ 模块。
 * 详见 docs/ARCHITECTURE.md 和 IMPROVEMENT_PLAN.md。
 */
import type { OutcomeSignal } from '../types.js';

export const WEIGHTS = {
  testPassed: 0.4,
  committed: 0.3,
  noRetry: 0.2,
  noRevert: 0.1,
};

export function computeSuccessScore(signal: OutcomeSignal): number {
  return (
    Number(signal.testPassed) * WEIGHTS.testPassed +
    Number(signal.committed) * WEIGHTS.committed +
    Number(signal.noRetry) * WEIGHTS.noRetry +
    Number(signal.noRevert) * WEIGHTS.noRevert
  );
}

export function collectOutcomeSignal(
  partial: Partial<OutcomeSignal> & Pick<OutcomeSignal, 'testPassed' | 'committed' | 'noRetry' | 'noRevert'>
): OutcomeSignal {
  return {
    testPassed: partial.testPassed,
    committed: partial.committed,
    noRetry: partial.noRetry,
    noRevert: partial.noRevert,
    followUpEditCount: partial.followUpEditCount,
    timeToNextPromptMs: partial.timeToNextPromptMs,
  };
}
