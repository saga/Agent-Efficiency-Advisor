// TrendAnalyzer — v7.md #8: 从 AnalyticsEngine 拆分。
// 负责线性回归 + 7 日滚动平均趋势检测。

import type { Analyzer, AnalyzerContext } from './types.js';
import { TrendAnalysis, type TrendReport } from '../TrendAnalysis.js';

export class TrendAnalyzer implements Analyzer<TrendReport> {
  readonly id = 'trend';

  analyze(ctx: AnalyzerContext): TrendReport {
    const analysis = new TrendAnalysis();
    return analysis.analyze(ctx.allEvents);
  }
}
