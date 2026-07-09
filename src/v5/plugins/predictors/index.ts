// Built-in predictors and the PredictionEngine with voting/fusion.

import type { PredictionContext, Predictor, Recommendation } from '../../runtime/types.js';

const SAVING: Record<string, number> = { mini: 60, medium: 25, large: 0 };

export class RulePredictor implements Predictor {
  id = 'rule';

  predict(ctx: PredictionContext): Recommendation {
    const snap = ctx.snapshot;
    const reasons: string[] = [];

    const isMini =
      snap.promptTokens < 8000 &&
      snap.toolCalls <= 5 &&
      snap.filesEdited.length <= 2 &&
      snap.retries === 0 &&
      snap.subAgents === 0;

    if (isMini) {
      reasons.push('small prompt, few tools, no retries');
      return { model: 'mini', confidence: 0.8, estimatedSavingPercent: SAVING.mini, reasons, source: this.id };
    }

    const isLarge =
      snap.contextTokens > 60000 ||
      snap.toolCalls > 30 ||
      snap.subAgents > 1 ||
      ctx.health.overall < 50;

    if (isLarge) {
      reasons.push(`high context (${snap.contextTokens}) or low health (${ctx.health.overall})`);
      return { model: 'large', confidence: 0.75, estimatedSavingPercent: SAVING.large, reasons, source: this.id };
    }

    reasons.push('medium complexity profile');
    return { model: 'medium', confidence: 0.7, estimatedSavingPercent: SAVING.medium, reasons, source: this.id };
  }
}

export class HeuristicPredictor implements Predictor {
  id = 'heuristic';

  predict(ctx: PredictionContext): Recommendation {
    const snap = ctx.snapshot;
    const complexity =
      Math.min(snap.promptTokens / 80000, 1) * 30 +
      Math.min(snap.toolCalls / 40, 1) * 25 +
      Math.min(snap.filesEdited.length / 10, 1) * 15 +
      Math.min(snap.retries / 5, 1) * 15 +
      Math.min(snap.subAgents / 3, 1) * 15;

    const reasons = [`heuristic complexity ${complexity.toFixed(0)}/100`];
    let model: Recommendation['model'] = 'large';
    if (complexity < 30) model = 'mini';
    else if (complexity < 65) model = 'medium';

    return {
      model,
      confidence: 0.6 + Math.min(complexity / 200, 0.2),
      estimatedSavingPercent: SAVING[model],
      reasons,
      source: this.id,
    };
  }
}

export interface PredictionEngineOptions {
  predictors: Predictor[];
}

export interface FusedPrediction {
  recommendations: Recommendation[];
  fused: Recommendation;
}

export class PredictionEngine {
  constructor(private options: PredictionEngineOptions) {}

  async predict(ctx: PredictionContext): Promise<FusedPrediction> {
    const recs = await Promise.all(this.options.predictors.map((p) => Promise.resolve(p.predict(ctx))));
    const fused = this.fuse(recs);
    return { recommendations: recs, fused };
  }

  // Confidence-weighted voting across predictors.
  private fuse(recs: Recommendation[]): Recommendation {
    const tally: Record<string, { weight: number; reasons: string[] }> = {
      mini: { weight: 0, reasons: [] },
      medium: { weight: 0, reasons: [] },
      large: { weight: 0, reasons: [] },
    };

    for (const r of recs) {
      tally[r.model].weight += r.confidence;
      tally[r.model].reasons.push(...r.reasons);
    }

    let best: Recommendation['model'] = 'medium';
    let bestWeight = -1;
    for (const m of ['mini', 'medium', 'large'] as const) {
      if (tally[m].weight > bestWeight) {
        bestWeight = tally[m].weight;
        best = m;
      }
    }

    const total = recs.reduce((s, r) => s + r.confidence, 0) || 1;
    const confidence = tally[best].weight / total;

    return {
      model: best,
      confidence: Math.round(confidence * 100) / 100,
      estimatedSavingPercent: SAVING[best],
      reasons: Array.from(new Set(tally[best].reasons)).slice(0, 5),
      source: `fusion(${recs.map((r) => r.source).join('+')})`,
    };
  }
}
