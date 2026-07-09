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
