// Drift Detection — Model Drift (performance degradation) and Concept Drift
// (input feature distribution shift) via simple statistical monitors.

import type { DriftSignal, EvaluationSample, ModelSize } from './types.js';

export interface DriftBaseline {
  accuracy: number;
  meanFeatureValues: Record<string, number>;
}

export function detectModelDrift(
  recentSamples: EvaluationSample[],
  baseline: Pick<DriftBaseline, 'accuracy'>,
  threshold = 0.05
): DriftSignal {
  if (recentSamples.length === 0) {
    return {
      type: 'model',
      detected: false,
      severity: 'none',
      metric: 'accuracy',
      currentValue: 0,
      baselineValue: baseline.accuracy,
      recommendation: 'insufficient samples',
    };
  }
  const correct = recentSamples.filter((s) => s.correct).length;
  const currentAcc = correct / recentSamples.length;
  const drop = baseline.accuracy - currentAcc;

  let severity: DriftSignal['severity'] = 'none';
  if (drop >= threshold * 2) severity = 'high';
  else if (drop >= threshold) severity = 'medium';
  else if (drop >= threshold * 0.5) severity = 'low';

  return {
    type: 'model',
    detected: severity !== 'none',
    severity,
    metric: 'accuracy',
    currentValue: currentAcc,
    baselineValue: baseline.accuracy,
    recommendation: severity === 'none'
      ? 'no retrain needed'
      : `accuracy dropped ${drop.toFixed(3)}; retrain recommended`,
  };
}

export function detectConceptDrift(
  recentFeatures: Record<string, number>[],
  baseline: Pick<DriftBaseline, 'meanFeatureValues'>,
  threshold = 0.3
): DriftSignal {
  if (recentFeatures.length === 0) {
    return {
      type: 'concept',
      detected: false,
      severity: 'none',
      metric: 'mean_shift',
      currentValue: 0,
      baselineValue: 0,
      recommendation: 'insufficient samples',
    };
  }
  const featureNames = Object.keys(recentFeatures[0]);
  let totalShift = 0;
  let worstFeature = '';
  let worstShift = 0;
  for (const name of featureNames) {
    const mean = recentFeatures.reduce((s, f) => s + (f[name] ?? 0), 0) / recentFeatures.length;
    const base = baseline.meanFeatureValues[name] ?? 0;
    const shift = base !== 0 ? Math.abs(mean - base) / Math.abs(base) : Math.abs(mean);
    totalShift += shift;
    if (shift > worstShift) {
      worstShift = shift;
      worstFeature = name;
    }
  }
  const avgShift = totalShift / Math.max(featureNames.length, 1);

  let severity: DriftSignal['severity'] = 'none';
  if (avgShift >= threshold * 2) severity = 'high';
  else if (avgShift >= threshold) severity = 'medium';
  else if (avgShift >= threshold * 0.5) severity = 'low';

  return {
    type: 'concept',
    detected: severity !== 'none',
    severity,
    metric: `mean_shift (worst: ${worstFeature})`,
    currentValue: Number(avgShift.toFixed(3)),
    baselineValue: 0,
    recommendation: severity === 'none'
      ? 'distribution stable'
      : `feature distribution shifted (${worstFeature}); retrain recommended`,
  };
}
