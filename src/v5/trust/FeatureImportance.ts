// Feature Importance via Permutation Importance.
// Given a trained model + a labeled dataset, shuffle each feature column and
// measure the drop in accuracy. Larger drop → more important feature.

import type { ModelSize } from './types.js';

export interface PermutationImportanceInput {
  features: Record<string, number>[];
  labels: ModelSize[];
  predict: (features: Record<string, number>) => ModelSize;
  iterations?: number;
  seed?: number;
}

export interface FeatureImportanceResult {
  feature: string;
  importance: number; // mean accuracy drop
  std: number;
}

export function permutationImportance(input: PermutationImportanceInput): FeatureImportanceResult[] {
  const { features, labels, predict, iterations = 5 } = input;
  if (features.length === 0) return [];

  const baselineAcc = accuracy(features, labels, predict);
  const featureNames = Object.keys(features[0]);
  const rng = mulberry32(input.seed ?? 42);

  const results: FeatureImportanceResult[] = [];
  for (const name of featureNames) {
    const drops: number[] = [];
    for (let it = 0; it < iterations; it++) {
      const shuffled = features.map((f, i) => ({
        ...f,
        [name]: features[Math.floor(rng() * features.length)][name],
      }));
      const acc = accuracy(shuffled, labels, predict);
      drops.push(baselineAcc - acc);
    }
    const mean = drops.reduce((a, b) => a + b, 0) / drops.length;
    const variance = drops.reduce((s, d) => s + (d - mean) ** 2, 0) / drops.length;
    results.push({ feature: name, importance: mean, std: Math.sqrt(variance) });
  }

  results.sort((a, b) => b.importance - a.importance);
  return results;
}

function accuracy(
  features: Record<string, number>[],
  labels: ModelSize[],
  predict: (f: Record<string, number>) => ModelSize
): number {
  if (features.length === 0) return 0;
  let correct = 0;
  for (let i = 0; i < features.length; i++) {
    if (predict(features[i]) === labels[i]) correct++;
  }
  return correct / features.length;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
