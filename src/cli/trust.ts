// V5.2 Trustworthy Decision Engine — end-to-end demo.
// Shows: synthetic data → calibration → evaluation → decision fusion →
// explainability → counterfactual → shadow sampling → drift → scorecard.

import { calibrateTemperature } from '../v5/trust/ConfidenceCalibration.js';
import { fusePredictions } from '../v5/trust/DecisionFusion.js';
import { DecisionEngine } from '../v5/trust/DecisionEngine.js';
import { evaluate, buildScorecard } from '../v5/trust/Evaluation.js';
import { permutationImportance } from '../v5/trust/FeatureImportance.js';
import { decideSample } from '../v5/trust/SamplingStrategy.js';
import { detectModelDrift, detectConceptDrift } from '../v5/trust/DriftDetector.js';
import { renderTrustDecision, renderScorecard, renderEvaluationMetrics, renderDrift } from '../v5/trust/TrustRenderer.js';
import type { EvaluationSample, ModelSize } from '../v5/trust/types.js';

const MODELS: ModelSize[] = ['mini', 'medium', 'large'];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Synthetic labeled dataset: features → true label
function generateDataset(n: number, seed: number): { features: Record<string, number>[]; labels: ModelSize[]; baseline: Record<string, number> } {
  const r = rng(seed);
  const features: Record<string, number>[] = [];
  const labels: ModelSize[] = [];
  for (let i = 0; i < n; i++) {
    const label = r() < 0.5 ? 'mini' : r() < 0.6 ? 'medium' : 'large';
    const j = () => 0.7 + r() * 0.6;
    if (label === 'mini') {
      features.push({ promptTokens: 2500 * j(), toolCalls: 3 * j(), edits: 1 * j(), retries: 0, contextUtilization: 0.05 * j(), hasLoop: 0, subAgents: 0 });
    } else if (label === 'medium') {
      features.push({ promptTokens: 15000 * j(), toolCalls: 12 * j(), edits: 4 * j(), retries: 1 * j(), contextUtilization: 0.25 * j(), hasLoop: 0, subAgents: 0 });
    } else {
      features.push({ promptTokens: 60000 * j(), toolCalls: 40 * j(), edits: 10 * j(), retries: 5 * j(), contextUtilization: 0.7 * j(), hasLoop: 1, subAgents: 2 * j() });
    }
    labels.push(label);
  }
  // Baseline = mean per feature
  const names = Object.keys(features[0]);
  const baseline: Record<string, number> = {};
  for (const name of names) {
    baseline[name] = features.reduce((s, f) => s + f[name], 0) / features.length;
  }
  return { features, labels, baseline };
}

// A toy predictor: nearest-class-by-feature-means. Returns calibrated-ish probabilities.
function makePredictor(featureMeans: Record<ModelSize, Record<string, number>>) {
  return (f: Record<string, number>): Record<ModelSize, number> => {
    const dists: Record<ModelSize, number> = { mini: 0, medium: 0, large: 0 };
    for (const m of MODELS) {
      let d = 0;
      for (const k of Object.keys(f)) {
        const diff = f[k] - (featureMeans[m][k] ?? 0);
        d += diff * diff;
      }
      dists[m] = Math.sqrt(d);
    }
    // Inverse distance → probability
    const inv = MODELS.map((m) => 1 / (dists[m] + 1e-3));
    const sum = inv.reduce((a, b) => a + b, 0);
    const out = {} as Record<ModelSize, number>;
    MODELS.forEach((m, i) => { out[m] = inv[i] / sum; });
    return out;
  };
}

async function main() {
  console.log('════════ V5.2 Trustworthy Decision Engine ══════\n');

  // 1. Generate data
  const { features, labels, baseline } = generateDataset(500, 42);
  const splitIdx = Math.floor(features.length * 0.8);
  const trainFeats = features.slice(0, splitIdx);
  const trainLabels = labels.slice(0, splitIdx);
  const testFeats = features.slice(splitIdx);
  const testLabels = labels.slice(splitIdx);

  // 2. Compute feature means per class from training data
  const featureMeans: Record<ModelSize, Record<string, number>> = { mini: {}, medium: {}, large: {} };
  for (const m of MODELS) {
    const samples = trainFeats.filter((_, i) => trainLabels[i] === m);
    for (const name of Object.keys(trainFeats[0])) {
      featureMeans[m][name] = samples.reduce((s, f) => s + f[name], 0) / Math.max(samples.length, 1);
    }
  }
  const predict = makePredictor(featureMeans);

  // 3. Build EvaluationSamples
  const testSamples: EvaluationSample[] = testFeats.map((f, i) => {
    const probs = predict(f);
    const pred = MODELS.reduce((best, m) => (probs[m] > probs[best] ? m : best), 'mini' as ModelSize);
    return {
      features: f,
      trueLabel: testLabels[i],
      predictedLabel: pred,
      probabilities: probs,
      correct: pred === testLabels[i],
    };
  });

  // 4. Evaluation metrics
  const metrics = evaluate(testSamples);
  console.log(renderEvaluationMetrics(metrics));
  console.log();

  // 5. Confidence calibration
  const calib = calibrateTemperature(testSamples);
  console.log(`Confidence calibration:`);
  console.log(`  temperature: ${calib.temperature.toFixed(2)}`);
  console.log(`  ECE before:  ${calib.preEce.toFixed(3)}`);
  console.log(`  ECE after:   ${calib.postEce.toFixed(3)}`);
  console.log(`  Brier:       ${calib.brierScore.toFixed(3)}`);
  console.log();

  // 6. Permutation importance
  const importance = permutationImportance({
    features: trainFeats,
    labels: trainLabels,
    predict: (f) => {
      const probs = predict(f);
      return MODELS.reduce((best, m) => (probs[m] > probs[best] ? m : best), 'mini' as ModelSize);
    },
    iterations: 5,
  });
  console.log('Permutation importance:');
  for (const r of importance) {
    console.log(`  ${r.feature.padEnd(20)} ${r.importance.toFixed(3)} (±${r.std.toFixed(3)})`);
  }
  console.log();

  // 7. Decision fusion comparison
  const sampleFeatures = testFeats[0];
  const probs = predict(sampleFeatures);
  const samplePredictions = MODELS.map((m) => ({ model: m, confidence: probs[m], source: 'knn' }));
  // Add a second noisy predictor
  samplePredictions.push({ model: labels[0], confidence: 0.7, source: 'rule' });

  console.log('Decision fusion comparison (Weighted vs Bayesian vs Stacking):');
  for (const strategy of ['weighted', 'bayesian', 'stacking'] as const) {
    const fused = fusePredictions({ predictions: samplePredictions }, strategy);
    console.log(`  ${strategy.padEnd(9)} → ${fused.model} (conf ${fused.confidence.toFixed(2)})  probs mini=${fused.perModel.mini.toFixed(2)} med=${fused.perModel.medium.toFixed(2)} lg=${fused.perModel.large.toFixed(2)}`);
  }
  console.log();

  // 8. Full Decision Engine on one sample
  const engine = new DecisionEngine({
    fusion: 'bayesian',
    temperature: calib.temperature,
    costPer1MInput: { mini: 0.15, medium: 3, large: 5 },
    costPer1MOutput: { mini: 0.6, medium: 15, large: 15 },
  });
  const decision = engine.decide({
    predictions: samplePredictions,
    features: sampleFeatures,
    baseline,
    predict,
    promptTokens: sampleFeatures.promptTokens,
    expectedOutputTokens: sampleFeatures.promptTokens / 4,
  });
  console.log(renderTrustDecision(decision));
  console.log();

  // 9. Shadow sampling strategies comparison
  console.log('Shadow sampling strategies (on a low-confidence sample):');
  const lowConfSample = testSamples.find((s) => Math.max(...MODELS.map((m) => s.probabilities[m])) < 0.6) ?? testSamples[0];
  for (const strategy of ['random', 'confidence', 'uncertainty', 'active'] as const) {
    const decision = decideSample(
      {
        predictedModel: lowConfSample.predictedLabel,
        confidence: Math.max(...MODELS.map((m) => lowConfSample.probabilities[m])),
        probabilities: lowConfSample.probabilities,
        history: [],
        budgetRemaining: 100,
      },
      { strategy, rate: 0.2 }
    );
    console.log(`  ${strategy.padEnd(12)} sample=${decision.shouldSample}  (${decision.reason})`);
  }
  console.log();

  // 10. Drift detection
  // Simulate recent degraded samples
  const recent = testSamples.slice(0, 30).map((s) => ({ ...s, correct: s.correct && Math.random() > 0.2 }));
  const modelDrift = detectModelDrift(recent, { accuracy: metrics.accuracy });
  const conceptDrift = detectConceptDrift(
    recent.map((s) => s.features).slice(0, 20),
    { meanFeatureValues: baseline }
  );
  console.log(renderDrift([modelDrift, conceptDrift]));
  console.log();

  // 11. Advisor Scorecard
  const scorecard = buildScorecard({
    metrics,
    costSavedPercent: 42,
    failureIncreasePercent: 1.2,
    avgLatencyMs: 120,
  });
  console.log(renderScorecard(scorecard));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
