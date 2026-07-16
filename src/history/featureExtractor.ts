/**
 * @legacy V1/V2 历史分析模块
 *
 * 此模块属于 V1/V2 遗留代码,保留用于离线训练数据参考。
 * 新代码应使用 V6/V7 的 src/store/ (EventStore/FeatureStore) 和 src/ml/ 模块。
 * 详见 docs/ARCHITECTURE.md 和 IMPROVEMENT_PLAN.md。
 */
import type { AgentTrace, FeatureVector } from '../types.js';

export function extractFeatures(trace: AgentTrace): FeatureVector {
  const totalTokens = trace.inputTokens + trace.outputTokens;
  const inputOutputRatio = trace.inputTokens > 0 ? trace.outputTokens / trace.inputTokens : 0;

  return {
    contextTokens: trace.contextTokens,
    toolCallCount: trace.toolCalls.length,
    uniqueFileCount: new Set(trace.filesChanged).size,
    diffLineCount: trace.finalDiff.split('\n').length,
    reasoningStepCount: trace.reasoningSteps.length,
    totalTokens,
    inputOutputRatio,
    hasTests: detectTests(trace),
  };
}

function detectTests(trace: AgentTrace): boolean {
  const testPatterns = /\.(test|spec)\.(ts|tsx|js|jsx|py|go|rs)|\/_tests_\/|\/test_/i;
  return (
    trace.filesChanged.some((f) => testPatterns.test(f)) ||
    testPatterns.test(trace.finalDiff)
  );
}

export function featureSummary(features: FeatureVector): string {
  return (
    `context=${features.contextTokens} ` +
    `tools=${features.toolCallCount} ` +
    `files=${features.uniqueFileCount} ` +
    `diffLines=${features.diffLineCount} ` +
    `steps=${features.reasoningStepCount} ` +
    `totalTokens=${features.totalTokens} ` +
    `hasTests=${features.hasTests}`
  );
}
