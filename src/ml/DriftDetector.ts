// DriftDetector — detect feature/label/prediction distribution drift.
//
// When Copilot updates (new version, new Auto Mode, new model), the feature
// distribution changes. This module detects such shifts using:
//   - PSI (Population Stability Index) for continuous features
//   - KL Divergence for label/prediction distributions
//
// If drift exceeds threshold, the system should trigger offline retraining.

import type { ModelSizeFeatures } from './features.js';
import { FEATURE_COLUMNS } from './features.js';

export interface DriftResult {
  feature: string;
  psi: number;
  drifted: boolean;
}

export interface DriftReport {
  results: DriftResult[];
  overallDrift: boolean;
  maxPsi: number;
  avgPsi: number;
  driftedFeatures: string[];
  recommendation: 'no_action' | 'monitor' | 'retrain';
}

const PSI_BINS = 10;
const PSI_THRESHOLD_MONITOR = 0.1;
const PSI_THRESHOLD_RETRAIN = 0.25;

/**
 * Compute PSI between a baseline (training) distribution and a current distribution.
 *
 * PSI = Σ (p_current - p_baseline) * ln(p_current / p_baseline)
 *
 * Interpretation:
 *   PSI < 0.1  → no significant drift
 *   PSI 0.1-0.25 → monitor, slight drift
 *   PSI > 0.25 → retrain needed
 */
export function computePSI(baseline: number[], current: number[], bins: number = PSI_BINS): number {
  if (baseline.length === 0 || current.length === 0) return 0;

  // Use baseline to define bin edges
  const min = Math.min(...baseline, ...current);
  const max = Math.max(...baseline, ...current);
  if (min === max) return 0;

  const binWidth = (max - min) / bins;
  const binEdges = Array.from({ length: bins + 1 }, (_, i) => min + i * binWidth);
  binEdges[0] = -Infinity;
  binEdges[bins] = Infinity;

  // Count baseline and current in each bin
  const baselineCounts = Array(bins).fill(0);
  const currentCounts = Array(bins).fill(0);

  for (const v of baseline) {
    const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
    baselineCounts[idx]++;
  }
  for (const v of current) {
    const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
    currentCounts[idx]++;
  }

  // Convert to proportions with smoothing
  const baselineProps = baselineCounts.map((c) => (c + 0.5) / (baseline.length + bins * 0.5));
  const currentProps = currentCounts.map((c) => (c + 0.5) / (current.length + bins * 0.5));

  // PSI = Σ (p_c - p_b) * ln(p_c / p_b)
  let psi = 0;
  for (let i = 0; i < bins; i++) {
    if (baselineProps[i] > 0 && currentProps[i] > 0) {
      psi += (currentProps[i] - baselineProps[i]) * Math.log(currentProps[i] / baselineProps[i]);
    }
  }

  return Math.abs(psi);
}

/**
 * Compute KL divergence between two discrete distributions.
 * KL(P || Q) = Σ P(i) * ln(P(i) / Q(i))
 */
export function computeKLDivergence(p: number[], q: number[]): number {
  if (p.length !== q.length || p.length === 0) return 0;
  let kl = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0 && q[i] > 0) {
      kl += p[i] * Math.log(p[i] / q[i]);
    }
  }
  return Math.abs(kl);
}

/**
 * Detect drift across all features.
 *
 * @param baselineFeatures Features from the training set
 * @param currentFeatures Features from recent sessions
 */
export function detectFeatureDrift(
  baselineFeatures: ModelSizeFeatures[],
  currentFeatures: ModelSizeFeatures[],
): DriftReport {
  const results: DriftResult[] = [];

  for (const col of FEATURE_COLUMNS) {
    const baseline = baselineFeatures.map((f) => Number(f[col]));
    const current = currentFeatures.map((f) => Number(f[col]));
    const psi = computePSI(baseline, current);
    results.push({
      feature: col,
      psi,
      drifted: psi > PSI_THRESHOLD_MONITOR,
    });
  }

  const maxPsi = Math.max(...results.map((r) => r.psi));
  const avgPsi = results.reduce((sum, r) => sum + r.psi, 0) / results.length;
  const driftedFeatures = results.filter((r) => r.drifted).map((r) => r.feature);
  const overallDrift = maxPsi > PSI_THRESHOLD_MONITOR;

  let recommendation: DriftReport['recommendation'] = 'no_action';
  if (maxPsi > PSI_THRESHOLD_RETRAIN || avgPsi > PSI_THRESHOLD_MONITOR) {
    recommendation = 'retrain';
  } else if (overallDrift) {
    recommendation = 'monitor';
  }

  return {
    results,
    overallDrift,
    maxPsi,
    avgPsi,
    driftedFeatures,
    recommendation,
  };
}

/**
 * Detect label distribution drift using KL divergence.
 *
 * @param baselineLabels Label distribution from training [p_mini, p_medium, p_large]
 * @param currentLabels Label distribution from recent predictions
 */
export function detectLabelDrift(baselineLabels: number[], currentLabels: number[]): {
  kl: number;
  drifted: boolean;
  recommendation: string;
} {
  const kl = computeKLDivergence(baselineLabels, currentLabels);
  return {
    kl,
    drifted: kl > 0.1,
    recommendation: kl > 0.5 ? 'retrain' : kl > 0.1 ? 'monitor' : 'no_action',
  };
}

/**
 * Detect prediction drift — compares model's recent prediction distribution
 * to its expected (training) distribution.
 */
export function detectPredictionDrift(
  baselinePredictions: number[][],
  currentPredictions: number[][],
): DriftReport {
  // Average predictions to get distribution
  const baselineAvg = averageDistributions(baselinePredictions);
  const currentAvg = averageDistributions(currentPredictions);

  const kl = computeKLDivergence(currentAvg, baselineAvg);

  return {
    results: [
      { feature: 'mini_prob', psi: kl, drifted: kl > 0.1 },
      { feature: 'medium_prob', psi: kl, drifted: kl > 0.1 },
      { feature: 'large_prob', psi: kl, drifted: kl > 0.1 },
    ],
    overallDrift: kl > 0.1,
    maxPsi: kl,
    avgPsi: kl,
    driftedFeatures: kl > 0.1 ? ['prediction_distribution'] : [],
    recommendation: kl > 0.25 ? 'retrain' : kl > 0.1 ? 'monitor' : 'no_action',
  };
}

function averageDistributions(predictions: number[][]): number[] {
  if (predictions.length === 0) return [1 / 3, 1 / 3, 1 / 3];
  const sum = predictions.reduce(
    (acc, p) => acc.map((v, i) => v + p[i]),
    [0, 0, 0],
  );
  return sum.map((v) => v / predictions.length);
}
