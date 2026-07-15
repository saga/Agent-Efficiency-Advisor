// BehaviorAnalyzer — v7.md #8: 从 AnalyticsEngine 拆分。
// 负责一阶 Markov 链训练 + 行为模式报告。

import type { Analyzer, AnalyzerContext } from './types.js';
import { BehaviorModel, type BehaviorReport } from '../BehaviorModel.js';

export class BehaviorAnalyzer implements Analyzer<BehaviorReport> {
  readonly id = 'behavior';

  analyze(ctx: AnalyzerContext): BehaviorReport {
    const model = new BehaviorModel();
    model.train(ctx.sessions);
    return model.report();
  }
}
