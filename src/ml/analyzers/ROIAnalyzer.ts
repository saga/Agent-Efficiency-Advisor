// ROIAnalyzer — v7.md #8: 从 AnalyticsEngine 拆分。
// 负责 Context ROI（SHAP-like 特征贡献度）分析。
// v6.md Section 8: which context features actually contribute to success?

import type { Analyzer, AnalyzerContext } from './types.js';
import type { ContextROI } from '../AnalyticsEngine.js';

export class ROIAnalyzer implements Analyzer<ContextROI[]> {
  readonly id = 'roi';

  analyze(ctx: AnalyzerContext): ContextROI[] {
    const data: { features: Record<string, number>; acceptRate: number }[] = [];

    for (const sid of ctx.sessionIds) {
      const behavior = ctx.featureStore.read('behavior', sid);
      const session = ctx.featureStore.read('session', sid);
      if (!behavior || !session) continue;
      data.push({
        features: { ...behavior.features, ...session.features },
        acceptRate: session.features.acceptRate ?? 0,
      });
    }

    if (data.length < 2) return [];

    const allKeys = new Set<string>();
    for (const d of data) for (const k of Object.keys(d.features)) allKeys.add(k);

    const roi: ContextROI[] = [];
    for (const key of allKeys) {
      const corr = this.correlation(
        data.map((d) => d.features[key] ?? 0),
        data.map((d) => d.acceptRate)
      );
      if (Math.abs(corr) > 0.1) {
        roi.push({ feature: key, contribution: Number(corr.toFixed(3)) });
      }
    }
    roi.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    return roi.slice(0, 8);
  }

  private correlation(xs: number[], ys: number[]): number {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    const denom = Math.sqrt(dx * dy);
    return denom === 0 ? 0 : num / denom;
  }
}
