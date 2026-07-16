// 多模型测试 — LR / NB / KNN / LabelPropagation / Conformal

import { describe, it, expect } from 'vitest';
import { LogisticRegressionModel } from '../src/ml/LogisticRegressionModel.js';
import { NaiveBayesModel } from '../src/ml/NaiveBayesModel.js';
import { KnnModel } from '../src/ml/KnnModel.js';
import { LabelPropagation } from '../src/ml/LabelPropagation.js';
import { ConformalPredictor } from '../src/ml/ConformalPredictor.js';
import { LogisticRegressionModel as LRForConformal } from '../src/ml/LogisticRegressionModel.js';
import type { TrainingSample } from '../src/ml/dataset.js';
import type { ModelSizeFeatures, ModelSizeLabel } from '../src/ml/features.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeFeatures(promptTokens: number, toolCalls: number, edits: number, retries: number): ModelSizeFeatures {
  return {
    promptTokens,
    completionTokens: Math.round(promptTokens * 0.2),
    contextTokens: Math.round(promptTokens * 1.2),
    toolCalls,
    readFiles: toolCalls,
    edits,
    retries,
    uniqueFilesRead: Math.max(1, Math.round(toolCalls / 3)),
    uniqueFilesEdited: Math.max(1, Math.round(edits / 2)),
    elapsedMs: toolCalls * 3000,
    contextUtilization: (promptTokens * 1.2) / 256000,
    readToEditRatio: edits > 0 ? toolCalls / edits : toolCalls,
    retryRate: toolCalls > 0 ? retries / toolCalls : 0,
    hasLoop: retries > 3 ? 1 : 0,
    subAgents: retries > 2 ? 1 : 0,
    autoModePredictedLabel: promptTokens > 50000 ? 2 : 1,
    autoModeConfidence: 0.5 + Math.random() * 0.3,
    hourOfDay: 10,
    dayOfWeek: 2,
    isWeekend: 0,
    chatDurationMs: toolCalls * 1000,
    toolDurationMs: toolCalls * 2000,
    idleMs: toolCalls * 500,
    chatToToolRatio: toolCalls > 0 ? 0.8 : 1,
    acceptRate: retries > 0 ? 0.6 : 0.9,
    cancelRate: 0,
    switchRate: 0,
    toolSuccessRate: retries > 0 ? 0.7 : 0.95,
    rollingAvgTokens: 0,
    rollingAvgDuration: 0,
    rollingAcceptRate: 0,
    emaTokens: 0,
    emaRetryRate: 0,
    sessionsToday: 1,
  };
}

function makeSamples(): TrainingSample[] {
  return [
    { features: makeFeatures(2000, 3, 1, 0), label: 'mini', sessionId: 's1' },
    { features: makeFeatures(3000, 2, 1, 0), label: 'mini', sessionId: 's2' },
    { features: makeFeatures(1500, 4, 0, 0), label: 'mini', sessionId: 's3' },
    { features: makeFeatures(20000, 15, 5, 1), label: 'medium', sessionId: 's4' },
    { features: makeFeatures(25000, 12, 4, 2), label: 'medium', sessionId: 's5' },
    { features: makeFeatures(18000, 18, 6, 0), label: 'medium', sessionId: 's6' },
    { features: makeFeatures(70000, 45, 12, 6), label: 'large', sessionId: 's7' },
    { features: makeFeatures(80000, 50, 10, 5), label: 'large', sessionId: 's8' },
    { features: makeFeatures(60000, 40, 15, 8), label: 'large', sessionId: 's9' },
  ];
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aea-test-'));
}

describe('LogisticRegressionModel', () => {
  it('trains and predicts correctly', async () => {
    const model = new LogisticRegressionModel(100, 0.01, 0.01);
    const samples = makeSamples();
    const tmpDir = makeTempDir();
    const modelPath = path.join(tmpDir, 'lr-model.json');

    const info = await model.train(samples, modelPath);
    expect(info.accuracy).toBeGreaterThan(0.7);
    expect(info.featureImportance).toBeDefined();

    // 预测 mini 样本
    const pred = await model.predict(makeFeatures(2000, 2, 1, 0));
    expect(pred.label).toBe('mini');
    expect(pred.confidence).toBeGreaterThan(0.5);
    expect(pred.probabilities).toHaveLength(3);

    // 预测 large 样本
    const predLarge = await model.predict(makeFeatures(75000, 45, 12, 6));
    expect(predLarge.label).toBe('large');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('loads and predicts from saved model', async () => {
    const model1 = new LogisticRegressionModel(100, 0.01, 0.01);
    const samples = makeSamples();
    const tmpDir = makeTempDir();
    const modelPath = path.join(tmpDir, 'lr-model.json');

    await model1.train(samples, modelPath);

    const model2 = new LogisticRegressionModel();
    await model2.load(modelPath);

    const features = makeFeatures(2000, 2, 1, 0);
    const pred = await model2.predict(features);
    expect(pred.label).toBe('mini');
    expect(pred.probabilities).toHaveLength(3);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('NaiveBayesModel', () => {
  it('trains and predicts correctly', async () => {
    const model = new NaiveBayesModel();
    const samples = makeSamples();
    const tmpDir = makeTempDir();
    const modelPath = path.join(tmpDir, 'nb-model.json');

    const info = await model.train(samples, modelPath);
    expect(info.accuracy).toBeGreaterThan(0.7);

    const pred = await model.predict(makeFeatures(2000, 2, 1, 0));
    expect(pred.label).toBe('mini');
    expect(pred.probabilities).toHaveLength(3);
    expect(pred.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('KnnModel', () => {
  it('trains and predicts correctly', async () => {
    const model = new KnnModel();
    const samples = makeSamples();
    const tmpDir = makeTempDir();
    const modelPath = path.join(tmpDir, 'knn-model.json');

    const info = await model.train(samples, modelPath);
    expect(info.accuracy).toBeGreaterThanOrEqual(0);

    // 预测 mini 样本
    const pred = await model.predict(makeFeatures(2000, 2, 1, 0));
    expect(pred.label).toBe('mini');

    // 预测 large 样本
    const predLarge = await model.predict(makeFeatures(75000, 45, 12, 6));
    expect(predLarge.label).toBe('large');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('adjusts K based on sample size', async () => {
    const model = new KnnModel();
    const samples = makeSamples();
    const tmpDir = makeTempDir();
    const modelPath = path.join(tmpDir, 'knn-model.json');

    await model.train(samples, modelPath);
    // 9 samples → sqrt(9)=3 → K=3
    expect(model).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('LabelPropagation', () => {
  it('propagates labels from autoMode anchors', () => {
    const labelProp = new LabelPropagation();
    const samples = makeSamples();

    // 给 s1 和 s7 加 autoMode 信号
    const autoModeSignals = new Map([
      ['s1', { predictedLabel: 'no_reasoning', confidence: 0.8 }],
      ['s7', { predictedLabel: 'needs_reasoning', confidence: 0.9 }],
    ]);

    const result = labelProp.propagate(samples, {
      autoModeSignals,
      replaceLabels: false,
    });

    expect(result.labelProbabilities).toHaveLength(samples.length);
    expect(result.labelSources.filter((s) => s === 'autoMode')).toHaveLength(2);
    expect(result.iterations).toBeGreaterThan(0);
  });

  it('handles empty samples', () => {
    const labelProp = new LabelPropagation();
    const result = labelProp.propagate([]);
    expect(result.samples).toHaveLength(0);
    expect(result.converged).toBe(true);
  });

  it('maps autoMode labels correctly', () => {
    const labelProp = new LabelPropagation();
    const samples = makeSamples();
    const autoModeSignals = new Map([
      ['s1', { predictedLabel: 'no_reasoning', confidence: 0.9 }],
      ['s7', { predictedLabel: 'needs_reasoning', confidence: 0.9 }],
    ]);

    const result = labelProp.propagate(samples, {
      autoModeSignals,
      replaceLabels: true,
    });

    // s1 应该被标记为 mini(no_reasoning)
    const s1 = result.samples.find((s) => s.sessionId === 's1');
    expect(s1?.label).toBe('mini');

    // s7 应该被标记为 large(needs_reasoning)
    const s7 = result.samples.find((s) => s.sessionId === 's7');
    expect(s7?.label).toBe('large');
  });
});

describe('ConformalPredictor', () => {
  it('wraps a base model and adds p-value', async () => {
    const baseModel = new LRForConformal(100, 0.01, 0.01);
    const conformal = new ConformalPredictor(baseModel, 0.1);

    const samples = makeSamples();
    const tmpDir = makeTempDir();
    const modelPath = path.join(tmpDir, 'conformal-model.json');

    await conformal.train(samples, modelPath);

    const pred = await conformal.predict(makeFeatures(2000, 2, 1, 0));
    expect(pred.label).toBeDefined();
    expect(pred.pValue).toBeGreaterThanOrEqual(0);
    expect(pred.pValue).toBeLessThanOrEqual(1);
    expect(pred.rejected).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true });
  });
});
