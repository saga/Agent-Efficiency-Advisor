// Shadow Sampling Strategies — Random, Confidence-based, Uncertainty, Active.

import type { ModelSize, SamplingStrategy } from './types.js';

export interface SampleDecision {
  shouldSample: boolean;
  reason: string;
}

export interface SamplingContext {
  predictedModel: ModelSize;
  confidence: number;
  probabilities: Record<ModelSize, number>;
  history: SamplingOutcome[];
  budgetRemaining: number;
}

export interface SamplingOutcome {
  sampled: boolean;
  correct: boolean;
  confidence: number;
  model: ModelSize;
}

export interface SamplingStrategyOptions {
  strategy: SamplingStrategy;
  rate: number; // baseline rate for random
  // Confidence-based: sample more when confidence is low.
  minConfidence?: number; // sample fully below this, none above 1
  // Uncertainty: sample when entropy is high.
  entropyThreshold?: number;
  // Active: focus on boundary cases between two top classes.
  marginThreshold?: number;
}

export function decideSample(ctx: SamplingContext, opts: SamplingStrategyOptions): SampleDecision {
  if (ctx.budgetRemaining <= 0) return { shouldSample: false, reason: 'budget exhausted' };

  switch (opts.strategy) {
    case 'random':
      return randomSample(ctx, opts.rate);
    case 'confidence':
      return confidenceSample(ctx, opts.minConfidence ?? 0.7, opts.rate);
    case 'uncertainty':
      return uncertaintySample(ctx, opts.entropyThreshold ?? 0.9, opts.rate);
    case 'active':
      return activeSample(ctx, opts.marginThreshold ?? 0.15, opts.rate);
  }
}

function randomSample(ctx: SamplingContext, rate: number): SampleDecision {
  const draw = Math.random();
  return draw < rate
    ? { shouldSample: true, reason: `random draw ${draw.toFixed(2)} < ${rate}` }
    : { shouldSample: false, reason: 'random below rate' };
}

function confidenceSample(ctx: SamplingContext, minConf: number, maxRate: number): SampleDecision {
  // Lower confidence → higher sample probability.
  const sampleProb = Math.min(maxRate * 2, Math.max(0, (minConf - ctx.confidence) / minConf) * maxRate * 2);
  const draw = Math.random();
  return draw < sampleProb
    ? { shouldSample: true, reason: `confidence ${ctx.confidence.toFixed(2)} → p=${sampleProb.toFixed(2)}` }
    : { shouldSample: false, reason: `confidence too high (${ctx.confidence.toFixed(2)})` };
}

function uncertaintySample(ctx: SamplingContext, entropyThreshold: number, maxRate: number): SampleDecision {
  const entropy = shannonEntropy(ctx.probabilities);
  const normalized = entropy / Math.log(3); // max entropy for 3 classes
  if (normalized < entropyThreshold) {
    return { shouldSample: false, reason: `entropy ${normalized.toFixed(2)} below threshold` };
  }
  const draw = Math.random();
  return draw < maxRate
    ? { shouldSample: true, reason: `high entropy ${normalized.toFixed(2)}` }
    : { shouldSample: false, reason: 'entropy ok, below rate' };
}

function activeSample(ctx: SamplingContext, marginThreshold: number, maxRate: number): SampleDecision {
  const sorted = Object.values(ctx.probabilities).sort((a, b) => b - a);
  const margin = sorted[0] - (sorted[1] ?? 0);
  if (margin > marginThreshold) {
    return { shouldSample: false, reason: `margin ${margin.toFixed(2)} too large` };
  }
  const draw = Math.random();
  return draw < maxRate
    ? { shouldSample: true, reason: `small margin ${margin.toFixed(2)}` }
    : { shouldSample: false, reason: 'boundary case, below rate' };
}

function shannonEntropy(probs: Record<ModelSize, number>): number {
  let h = 0;
  for (const m of ['mini', 'medium', 'large'] as ModelSize[]) {
    const p = probs[m] ?? 0;
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}
