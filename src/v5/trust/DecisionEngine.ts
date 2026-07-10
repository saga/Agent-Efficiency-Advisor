// Decision Engine — turns predictor outputs into a TrustDecision with
// calibrated confidence, reasons, alternatives, risk, expected outcome,
// and (optionally) a counterfactual explanation.

import type {
  Alternative,
  CalibratedProbability,
  CounterfactualExplanation,
  ExpectedOutcome,
  ModelSize,
  Reason,
  RiskAssessment,
  TrustDecision,
} from './types.js';
import type { Recommendation } from '../runtime/types.js';
import { applyTemperature } from './ConfidenceCalibration.js';
import { fusePredictions, type FusionStrategy, type StackingModel } from './DecisionFusion.js';
import { featureContributions, findCounterfactual } from './Explainability.js';

const MODELS: ModelSize[] = ['mini', 'medium', 'large'];
const SAVING: Record<ModelSize, number> = { mini: 60, medium: 25, large: 0 };

export interface DecisionEngineOptions {
  fusion: FusionStrategy;
  temperature?: number;
  stackingModel?: StackingModel;
  // Cost model: $/1M tokens for each model size.
  costPer1MInput: Record<ModelSize, number>;
  costPer1MOutput: Record<ModelSize, number>;
}

export interface DecisionInput {
  predictions: Array<{ model: ModelSize; confidence: number; source: string }>;
  features: Record<string, number>;
  baseline: Record<string, number>;
  // Predictor function (for SHAP-like + counterfactual)
  predict: (features: Record<string, number>) => Record<ModelSize, number>;
  promptTokens: number;
  expectedOutputTokens: number;
}

export class DecisionEngine {
  constructor(private opts: DecisionEngineOptions) {}

  decide(input: DecisionInput): TrustDecision {
    // 1. Fuse predictions → perModel probabilities
    const fusion = fusePredictions(
      { predictions: input.predictions },
      this.opts.fusion,
      this.opts.stackingModel
    );

    // 2. Apply temperature scaling
    const t = this.opts.temperature ?? 1;
    const calibratedRecord = applyTemperature(fusion.perModel, t);
    const probabilities: CalibratedProbability[] = MODELS.map((m) => ({
      model: m,
      rawProbability: fusion.perModel[m],
      calibratedProbability: calibratedRecord[m],
    }));

    const top = pickTop(probabilities.map((p) => p.calibratedProbability));
    const calibratedConfidence = probabilities.find((p) => p.model === top)!.calibratedProbability;

    // 3. Reasons via SHAP-like contributions
    const reasons: Reason[] = featureContributions({
      features: input.features,
      baseline: input.baseline,
      predict: input.predict,
    }).slice(0, 5);

    // 4. Alternatives — sorted by calibrated probability
    const alternatives: Alternative[] = MODELS
      .filter((m) => m !== top)
      .sort((a, b) => calibratedRecord[b] - calibratedRecord[a])
      .slice(0, 2)
      .map((m) => ({
        model: m,
        confidence: calibratedRecord[m],
        rationale: `alternative with ${(calibratedRecord[m] * 100).toFixed(0)}% probability`,
      }));

    // 5. Risk assessment
    const risk = assessRisk(top, calibratedConfidence, input.features);

    // 6. Expected outcome
    const expectedOutcome = estimateOutcome(top, input.promptTokens, input.expectedOutputTokens, this.opts);

    // 7. Counterfactual — find smallest feature reduction to flip to a smaller model
    let counterfactual: CounterfactualExplanation | undefined;
    if (top !== 'mini') {
      const target = top === 'large' ? 'medium' : 'mini';
      counterfactual = findCounterfactual(input.features, top, input.predict, target);
    }

    // 8. Build a Recommendation (legacy-compatible) and wrap in TrustDecision
    const recommendation: Recommendation = {
      model: top,
      confidence: calibratedConfidence,
      estimatedSavingPercent: SAVING[top],
      reasons: reasons.map((r) => r.description),
      source: `decision-engine:${this.opts.fusion}`,
    };

    return {
      recommendation,
      topModel: top,
      calibratedConfidence,
      probabilities,
      reasons,
      alternatives,
      risk,
      expectedOutcome,
      counterfactual,
      fusionStrategy: this.opts.fusion,
    };
  }
}

function assessRisk(model: ModelSize, confidence: number, features: Record<string, number>): RiskAssessment {
  const factors: string[] = [];
  if (confidence < 0.6) factors.push('low confidence');
  if ((features.retries ?? 0) > 0) factors.push(`${features.retries} retries observed`);
  if ((features.hasLoop ?? 0) > 0) factors.push('tool loop detected');
  if ((features.contextUtilization ?? 0) > 0.7) factors.push('context near limit');

  let level: RiskAssessment['level'] = 'low';
  if (factors.length >= 3) level = 'high';
  else if (factors.length >= 1) level = 'medium';

  const mitigation = level === 'high'
    ? 'monitor closely; consider upgrading immediately on first retry'
    : level === 'medium'
    ? 'watch for the next alert; upgrade if context crosses 80%'
    : 'safe to proceed with this model';

  const escalationRule = model === 'mini'
    ? 'escalate to medium if readFiles > 20 or retries > 0'
    : model === 'medium'
    ? 'escalate to large if context > 60k or subagents > 1'
    : undefined;

  return { level, factors, mitigation, escalationRule };
}

function estimateOutcome(
  model: ModelSize,
  promptTokens: number,
  expectedOutputTokens: number,
  opts: DecisionEngineOptions
): ExpectedOutcome {
  const cost = (promptTokens * opts.costPer1MInput[model] + expectedOutputTokens * opts.costPer1MOutput[model]) / 1e6;
  // Success probability heuristic: smaller models slightly lower success on same task.
  const successBase = 0.92;
  const successAdj = model === 'mini' ? -0.05 : model === 'large' ? 0.03 : 0;
  return {
    successProbability: Math.max(0.5, Math.min(0.99, successBase + successAdj)),
    estimatedSavingPercent: SAVING[model],
    estimatedTokens: promptTokens + expectedOutputTokens,
    estimatedCostUsd: Math.round(cost * 10000) / 10000,
  };
}

function pickTop(probs: number[]): ModelSize {
  let topIdx = 0;
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > probs[topIdx]) topIdx = i;
  }
  return MODELS[topIdx];
}
