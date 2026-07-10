// Confidence Calibration — Temperature Scaling + ECE + Brier Score.
// Implements the classic Platt/temperature scaling approach for multiclass.

import type { EvaluationSample, ModelSize } from './types.js';

const MODELS: ModelSize[] = ['mini', 'medium', 'large'];

export interface CalibrationResult {
  temperature: number;
  preEce: number;
  postEce: number;
  brierScore: number;
}

/**
 * Fit a single temperature parameter T on validation logits→softmax to
 * minimize NLL. Uses a simple grid + binary search since we have no autograd.
 * Inputs are predicted probabilities (already softmaxed); we convert to logits
 * via logit(p)=log(p/(1-p)) on the top class as an approximation.
 */
export function calibrateTemperature(
  samples: EvaluationSample[],
  iterations = 50
): CalibrationResult {
  if (samples.length === 0) {
    return { temperature: 1, preEce: 0, postEce: 0, brierScore: 0 };
  }

  const preEce = computeEce(samples);
  const brierScore = computeBrierScore(samples);

  // Grid search T in [0.1, 5] then refine.
  let bestT = 1;
  let bestNll = computeNll(samples, 1);
  for (let t = 0.1; t <= 5; t += 0.1) {
    const nll = computeNll(samples, t);
    if (nll < bestNll) {
      bestNll = nll;
      bestT = t;
    }
  }

  // Refine around bestT
  let lo = Math.max(0.05, bestT - 0.1);
  let hi = bestT + 0.1;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const nllLo = computeNll(samples, lo);
    const nllHi = computeNll(samples, hi);
    if (nllLo < nllHi) hi = mid;
    else lo = mid;
  }
  bestT = (lo + hi) / 2;

  const calibratedSamples = samples.map((s) => ({
    ...s,
    probabilities: applyTemperature(s.probabilities, bestT),
  }));
  const postEce = computeEce(calibratedSamples);

  return { temperature: bestT, preEce, postEce, brierScore };
}

export function applyTemperature(probs: Record<ModelSize, number>, t: number): Record<ModelSize, number> {
  const logits = MODELS.map((m) => Math.log(Math.max(probs[m] ?? 0, 1e-9)) / t);
  const maxLogit = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - maxLogit));
  const sum = exps.reduce((a, b) => a + b, 0);
  const out = {} as Record<ModelSize, number>;
  MODELS.forEach((m, i) => {
    out[m] = exps[i] / sum;
  });
  return out;
}

function computeNll(samples: EvaluationSample[], t: number): number {
  let nll = 0;
  for (const s of samples) {
    const cal = applyTemperature(s.probabilities, t);
    nll -= Math.log(Math.max(cal[s.trueLabel] ?? 0, 1e-9));
  }
  return nll / samples.length;
}

/**
 * Expected Calibration Error — bin predictions by confidence, compare
 * accuracy vs confidence in each bin.
 */
export function computeEce(samples: EvaluationSample[], numBins = 10): number {
  if (samples.length === 0) return 0;
  const bins = Array.from({ length: numBins }, () => ({ count: 0, confSum: 0, accSum: 0 }));
  for (const s of samples) {
    const pred = MODELS.reduce((best, m) => ((s.probabilities[m] ?? 0) > (s.probabilities[best] ?? 0) ? m : best), 'mini' as ModelSize);
    const conf = s.probabilities[pred] ?? 0;
    const binIdx = Math.min(numBins - 1, Math.floor(conf * numBins));
    bins[binIdx].count++;
    bins[binIdx].confSum += conf;
    bins[binIdx].accSum += pred === s.trueLabel ? 1 : 0;
  }
  let ece = 0;
  for (const b of bins) {
    if (b.count === 0) continue;
    const avgConf = b.confSum / b.count;
    const avgAcc = b.accSum / b.count;
    ece += (b.count / samples.length) * Math.abs(avgConf - avgAcc);
  }
  return ece;
}

/**
 * Brier Score — mean squared error between probabilities and one-hot labels.
 */
export function computeBrierScore(samples: EvaluationSample[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) {
    for (const m of MODELS) {
      const target = s.trueLabel === m ? 1 : 0;
      const diff = (s.probabilities[m] ?? 0) - target;
      sum += diff * diff;
    }
  }
  return sum / (samples.length * MODELS.length);
}
