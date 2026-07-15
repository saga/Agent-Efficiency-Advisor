// WorkflowAnalyzer — v7.md #8: 从 AnalyticsEngine 拆分。
// v7.md #6: Workflow Mining 应该直接读取 Event（不走 Feature）。
// Workflow 本来就是 Sequence，Feature 已经损失信息。

import type { Analyzer, AnalyzerContext } from './types.js';
import { WorkflowMiner, type WorkflowGraph } from '../WorkflowMiner.js';

export class WorkflowAnalyzer implements Analyzer<WorkflowGraph> {
  readonly id = 'workflow';

  analyze(ctx: AnalyzerContext): WorkflowGraph {
    // v7.md #6: 直接从 Event 序列挖掘，不读 Feature
    const miner = new WorkflowMiner();
    return miner.mine(ctx.sessions);
  }
}
