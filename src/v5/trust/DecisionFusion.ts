// Decision Fusion — Weighted Voting, Bayesian, and Stacking strategies.
// Each strategy combines multiple predictors' (model, confidence) into a
// single fused decision with per-model probabilities.

import type { FusionInput, FusionResult, ModelSize } from './types.js';

const MODELS: ModelSize[] = ['mini', 'medium', 'large'];

export type FusionStrategy = 'weighted' | 'bayesian' | 'stacking';

export interface StackingModel {
  weights: Record<string, number>; // source → weight
  bias: number;
}

export function fusePredictions(
  input: FusionInput,
  strategy: FusionStrategy,
  stackingModel?: StackingModel
): FusionResult {
  switch (strategy) {
    case 'weighted':
      return weightedVoting(input);
    case 'bayesian':
      return bayesianFusion(input);
    case 'stacking':
      return stackingFusion(input, stackingModel);
  }
}

/**
 * Weighted Voting: confidence-weighted soft vote, then normalize.
 */
export function weightedVoting(input: FusionInput): FusionResult {
  const tally: Record<ModelSize, number> = { mini: 0, medium: 0, large: 0 };
  let total = 0;
  for (const p of input.predictions) {
    tally[p.model] += p.confidence;
    total += p.confidence;
  }
  if (total === 0) total = 1;
  const perModel = {} as Record<ModelSize, number>;
  for (const m of MODELS) perModel[m] = tally[m] / total;

  const top = pickTop(perModel);
  return { model: top, confidence: perModel[top], perModel, strategy: 'weighted' };
}

/**
 * Bayesian Fusion: treat each predictor as independent evidence and multiply
 * normalized probabilities (log-space), then renormalize.
 */
export function bayesianFusion(input: FusionInput): FusionResult {
  const logProbs: Record<ModelSize, number> = { mini: 0, medium: 0, large: 0 };
  for (const p of input.predictions) {
    // Soft evidence: confidence goes to predicted model, (1-conf)/2 to others
    for (const m of MODELS) {
      const evidence = m === p.model ? p.confidence : (1 - p.confidence) / 2;
      logProbs[m] += Math.log(Math.max(evidence, 1e-9));
    }
  }
  const maxLog = Math.max(...MODELS.map((m) => logProbs[m]));
  const exps = MODELS.map((m) => Math.exp(logProbs[m] - maxLog));
  const sum = exps.reduce((a, b) => a + b, 0);
  const perModel = {} as Record<ModelSize, number>;
  MODELS.forEach((m, i) => {
    perModel[m] = exps[i] / sum;
  });
  const top = pickTop(perModel);
  return { model: top, confidence: perModel[top], perModel, strategy: 'bayesian' };
}

/**
 * Stacking: learn per-source weights on a validation set, combine as a
 * weighted sum. Weights provided externally (trained offline).
 */
export function stackingFusion(input: FusionInput, model?: StackingModel): FusionResult {
  const weights = model?.weights ?? {};
  const bias = model?.bias ?? 0;
  const scores: Record<ModelSize, number> = { mini: bias, medium: bias, large: bias };
  let totalWeight = 0;
  for (const p of input.predictions) {
    const w = weights[p.source] ?? 1 / input.predictions.length;
    scores[p.model] += w * p.confidence;
    totalWeight += w;
  }
  if (totalWeight === 0) totalWeight = 1;
  const perModel = {} as Record<ModelSize, number>;
  for (const m of MODELS) perModel[m] = Math.max(0, scores[m]) / (3 * totalWeight);
  // Renormalize
  const sum = MODELS.reduce((s, m) => s + perModel[m], 0) || 1;
  for (const m of MODELS) perModel[m] = perModel[m] / sum;
  const top = pickTop(perModel);
  return { model: top, confidence: perModel[top], perModel, strategy: 'stacking' };
}

function pickTop(perModel: Record<ModelSize, number>): ModelSize {
  let top: ModelSize = 'medium';
  let best = -1;
  for (const m of MODELS) {
    if (perModel[m] > best) {
      best = perModel[m];
      top = m;
    }
  }
  return top;
}
