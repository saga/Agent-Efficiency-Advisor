// ContextFeatureCalculator — PromptAggregate → prompt features.
// v7.md #1: Calculator 只负责派生指标计算。命名为 Context 是因为 prompt 特征
// 本质上描述的是"上下文密度"（v7.md #1 示例：ContextFeatureCalculator）。
// 输出 6 个 prompt 特征：tokenCount / historyLength / retrievedFiles /
// retrievedSymbols / promptDensity / historyRatio。

import type { PromptAggregate } from '../aggregators/types.js';

export class ContextFeatureCalculator {
  calculate(agg: PromptAggregate): Record<string, number> {
    const promptDensity = agg.contextToken > 0
      ? Number((agg.tokenCount / agg.contextToken).toFixed(3))
      : 0;
    const historyRatio = agg.tokenCount > 0
      ? Number((agg.historyToken / agg.tokenCount).toFixed(3))
      : 0;
    return {
      tokenCount: agg.tokenCount,
      historyLength: agg.historyLength,
      retrievedFiles: agg.retrievedFiles,
      retrievedSymbols: agg.retrievedSymbols,
      promptDensity,
      historyRatio,
    };
  }
}
