// Trustworthy Decision Engine — shared types.
// Extends V5 Recommendation into a full Decision with risk, alternatives,
// expected outcome, and calibrated confidence.

import type { Recommendation } from '../runtime/types.js';

export type ModelSize = 'mini' | 'medium' | 'large';

export interface Reason {
  feature: string;
  contribution: number; // signed, e.g. +0.18 or -0.12
  description: string;
}

export interface Alternative {
  model: ModelSize;
  confidence: number;
  rationale: string;
}

export interface RiskAssessment {
  level: 'low' | 'medium' | 'high';
  factors: string[];
  mitigation: string;
  escalationRule?: string;
}

export interface ExpectedOutcome {
  successProbability: number;
  estimatedSavingPercent: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
}

export interface CalibratedProbability {
  model: ModelSize;
  rawProbability: number;
  calibratedProbability: number;
}

export interface TrustDecision {
  recommendation: Recommendation;
  topModel: ModelSize;
  calibratedConfidence: number;
  probabilities: CalibratedProbability[];
  reasons: Reason[];
  alternatives: Alternative[];
  risk: RiskAssessment;
  expectedOutcome: ExpectedOutcome;
  counterfactual?: CounterfactualExplanation;
  fusionStrategy: string;
}

export interface CounterfactualExplanation {
  feature: string;
  currentValue: number;
  requiredValue: number;
  currentModel: ModelSize;
  achievableModel: ModelSize;
  description: string;
}

export interface FusionInput {
  predictions: Array<{ model: ModelSize; confidence: number; source: string }>;
}

export interface FusionResult {
  model: ModelSize;
  confidence: number;
  perModel: Record<ModelSize, number>;
  strategy: string;
}

export interface EvaluationSample {
  features: Record<string, number>;
  trueLabel: ModelSize;
  predictedLabel: ModelSize;
  probabilities: Record<ModelSize, number>;
  correct: boolean;
}

export interface EvaluationMetrics {
  accuracy: number;
  precision: Record<ModelSize, number>;
  recall: Record<ModelSize, number>;
  f1: Record<ModelSize, number>;
  macroF1: number;
  brierScore: number;
  ece: number; // Expected Calibration Error
  confusionMatrix: Record<string, Record<string, number>>;
  sampleCount: number;
}

export interface AdvisorScorecard {
  accuracy: number;
  macroF1: number;
  brierScore: number;
  ece: number;
  costSavedPercent: number;
  failureIncreasePercent: number;
  avgLatencyMs: number;
  overallGrade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export type SamplingStrategy = 'random' | 'confidence' | 'uncertainty' | 'active';

export interface DriftSignal {
  type: 'model' | 'concept';
  detected: boolean;
  severity: 'none' | 'low' | 'medium' | 'high';
  metric: string;
  currentValue: number;
  baselineValue: number;
  recommendation: string;
}
