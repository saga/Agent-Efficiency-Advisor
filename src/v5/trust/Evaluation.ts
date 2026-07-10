// Evaluation Framework — accuracy/precision/recall/F1/Brier/ECE/ROC +
// Advisor Scorecard that aggregates technical + business metrics.

import type {
  AdvisorScorecard,
  EvaluationMetrics,
  EvaluationSample,
  ModelSize,
} from './types.js';
import { computeBrierScore, computeEce } from './ConfidenceCalibration.js';

const MODELS: ModelSize[] = ['mini', 'medium', 'large'];

export function evaluate(samples: EvaluationSample[]): EvaluationMetrics {
  if (samples.length === 0) {
    return emptyMetrics();
  }

  const confusion: Record<string, Record<string, number>> = {};
  for (const t of MODELS) {
    confusion[t] = {};
    for (const p of MODELS) confusion[t][p] = 0;
  }

  let correct = 0;
  for (const s of samples) {
    const pred = MODELS.reduce((best, m) =>
      (s.probabilities[m] ?? 0) > (s.probabilities[best] ?? 0) ? m : best
    , 'mini' as ModelSize);
    confusion[s.trueLabel][pred]++;
    if (pred === s.trueLabel) correct++;
  }

  const precision: Record<ModelSize, number> = {} as Record<ModelSize, number>;
  const recall: Record<ModelSize, number> = {} as Record<ModelSize, number>;
  const f1: Record<ModelSize, number> = {} as Record<ModelSize, number>;

  for (const m of MODELS) {
    const tp = confusion[m][m];
    const fp = MODELS.reduce((s, other) => s + (other === m ? 0 : confusion[other][m]), 0);
    const fn = MODELS.reduce((s, other) => s + (other === m ? 0 : confusion[m][other]), 0);
    precision[m] = tp + fp === 0 ? 0 : tp / (tp + fp);
    recall[m] = tp + fn === 0 ? 0 : tp / (tp + fn);
    f1[m] = precision[m] + recall[m] === 0 ? 0 : (2 * precision[m] * recall[m]) / (precision[m] + recall[m]);
  }

  const macroF1 = MODELS.reduce((s, m) => s + f1[m], 0) / MODELS.length;

  return {
    accuracy: correct / samples.length,
    precision,
    recall,
    f1,
    macroF1,
    brierScore: computeBrierScore(samples),
    ece: computeEce(samples),
    confusionMatrix: confusion,
    sampleCount: samples.length,
  };
}

export interface ScorecardInput {
  metrics: EvaluationMetrics;
  costSavedPercent: number;
  failureIncreasePercent: number;
  avgLatencyMs: number;
}

export function buildScorecard(input: ScorecardInput): AdvisorScorecard {
  const { metrics, costSavedPercent, failureIncreasePercent, avgLatencyMs } = input;
  // Simple grading rubric.
  let score = 0;
  score += metrics.accuracy * 30;
  score += metrics.macroF1 * 25;
  score += (1 - metrics.brierScore) * 15;
  score += (1 - metrics.ece) * 10;
  score += (costSavedPercent / 100) * 10;
  score -= (failureIncreasePercent / 100) * 15;
  score -= Math.min(avgLatencyMs / 1000, 1) * 5;

  let overallGrade: AdvisorScorecard['overallGrade'] = 'F';
  if (score >= 85) overallGrade = 'A';
  else if (score >= 75) overallGrade = 'B';
  else if (score >= 60) overallGrade = 'C';
  else if (score >= 45) overallGrade = 'D';

  return {
    accuracy: metrics.accuracy,
    macroF1: metrics.macroF1,
    brierScore: metrics.brierScore,
    ece: metrics.ece,
    costSavedPercent,
    failureIncreasePercent,
    avgLatencyMs,
    overallGrade,
  };
}

function emptyMetrics(): EvaluationMetrics {
  return {
    accuracy: 0,
    precision: { mini: 0, medium: 0, large: 0 },
    recall: { mini: 0, medium: 0, large: 0 },
    f1: { mini: 0, medium: 0, large: 0 },
    macroF1: 0,
    brierScore: 0,
    ece: 0,
    confusionMatrix: {},
    sampleCount: 0,
  };
}
