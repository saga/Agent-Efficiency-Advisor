// Explainability — SHAP-like feature contributions + counterfactual.
// Uses a simple perturbation-based attribution (shuffle a feature across a
// reference set and measure the prediction shift) as a lightweight SHAP proxy.

import type { CounterfactualExplanation, ModelSize, Reason } from './types.js';

export interface FeatureContributionInput {
  features: Record<string, number>;
  baseline: Record<string, number>; // reference values
  predict: (features: Record<string, number>) => Record<ModelSize, number>;
}

/**
 * Compute per-feature contributions to the top-class probability.
 * A feature's contribution = P(top | actual) - P(top | baseline).
 * Positive means it pushes toward the top class.
 */
export function featureContributions(input: FeatureContributionInput): Reason[] {
  const { features, baseline, predict } = input;
  const actualProbs = predict(features);
  const top = pickTop(actualProbs);
  const topProbActual = actualProbs[top];

  const reasons: Reason[] = [];
  for (const key of Object.keys(features)) {
    const ablated = { ...features, [key]: baseline[key] ?? 0 };
    const ablatedProbs = predict(ablated);
    const contribution = topProbActual - (ablatedProbs[top] ?? 0);
    const direction = contribution >= 0 ? 'increases' : 'decreases';
    reasons.push({
      feature: key,
      contribution: Math.round(contribution * 1000) / 1000,
      description: `${key}=${features[key]} ${direction} ${top} by ${Math.abs(contribution).toFixed(3)}`,
    });
  }
  reasons.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return reasons;
}

/**
 * Counterfactual: find the single feature change that would flip the
 * recommendation to a smaller model. Linear search over features, decreasing
 * the value toward baseline until a smaller model wins.
 */
export function findCounterfactual(
  features: Record<string, number>,
  currentModel: ModelSize,
  predict: (features: Record<string, number>) => Record<ModelSize, number>,
  targetModel: ModelSize
): CounterfactualExplanation | undefined {
  if (currentModel === 'mini') return undefined;
  const order = rankByDecreasingValue(features);

  for (const feature of order) {
    const current = features[feature];
    const step = current / 10;
    for (let i = 1; i <= 10; i++) {
      const candidate = { ...features, [feature]: current - step * i };
      const probs = predict(candidate);
      const top = pickTop(probs);
      if (top === targetModel) {
        return {
          feature,
          currentValue: current,
          requiredValue: candidate[feature],
          currentModel,
          achievableModel: targetModel,
          description: `If ${feature} decreases from ${current.toFixed(0)} to ${candidate[feature].toFixed(0)}, recommendation becomes ${targetModel}.`,
        };
      }
      if (candidate[feature] <= 0) break;
    }
  }
  return undefined;
}

function pickTop(probs: Record<ModelSize, number>): ModelSize {
  let top: ModelSize = 'medium';
  let best = -1;
  for (const m of ['mini', 'medium', 'large'] as ModelSize[]) {
    if ((probs[m] ?? 0) > best) {
      best = probs[m] ?? 0;
      top = m;
    }
  }
  return top;
}

function rankByDecreasingValue(features: Record<string, number>): string[] {
  return Object.keys(features).sort((a, b) => features[b] - features[a]);
}
