// WorkspaceFeatureCalculator — WorkspaceAggregate → workspace features.
// v7.md #1: Calculator 只负责派生指标计算，不做持久化。
// 输出 6 个 workspace 特征：totalFiles / totalLOC / languageCount /
// dependencyCount / gitBranchCount / workspaceComplexity。

import type { WorkspaceAggregate } from '../aggregators/types.js';

export class WorkspaceFeatureCalculator {
  calculate(agg: WorkspaceAggregate): Record<string, number> {
    const fileCount = agg.files.size || 1;
    const complexity = 0.4 * Math.log(fileCount) + 0.3 * agg.languages.size + 0.3 * agg.maxDependencies;
    return {
      totalFiles: fileCount,
      totalLOC: agg.totalLOC,
      languageCount: agg.languages.size,
      dependencyCount: agg.maxDependencies,
      gitBranchCount: agg.branches.size,
      workspaceComplexity: Number(complexity.toFixed(3)),
    };
  }
}
