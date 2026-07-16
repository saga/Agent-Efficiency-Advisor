// OnlineLogisticRegression — SGD-based softmax regression with online updates.
//
// Unlike the batch LogisticRegressionModel, this supports partial_fit():
// each new session updates the model incrementally without retraining.
// Uses AdaGrad learning rate scheduling for stable online learning.
//
// Architecture: softmax(Wx + b) with L2 regularization
// Update: AdaGrad per-feature adaptive learning rate
// Loss: cross-entropy

import fs from 'node:fs';
import type { ModelPrediction, TrainableModel, TrainedModelInfo } from './ModelInterface.js';
import type { TrainingSample } from './dataset.js';
import {
  FEATURE_COLUMNS,
  INDEX_LABEL,
  LABEL_INDEX,
  type ModelSizeFeatures,
} from './features.js';

const NUM_CLASSES = 3;

interface OnlineLRModelData {
  weights: number[][];
  biases: number[];
  featureMeans: number[];
  featureStds: number[];
  gradientHistory: number[][]; // AdaGrad G_t per (class, feature)
  biasGradientHistory: number[];
  samplesSeen: number;
  learningRate: number;
  l2Reg: number;
}

export class OnlineLogisticRegression implements TrainableModel {
  readonly name = 'Online Logistic Regression (AdaGrad)';
  readonly type = 'logistic' as const;

  private weights: number[][] = [];
  private biases: number[] = [0, 0, 0];
  private featureMeans: number[] = [];
  private featureStds: number[] = [];
  private gradientHistory: number[][] = [];
  private biasGradientHistory: number[] = [1e-8, 1e-8, 1e-8];
  private samplesSeen = 0;
  private learningRate: number;
  private l2Reg: number;
  private initialized = false;

  constructor(learningRate = 0.1, l2Reg = 0.001) {
    this.learningRate = learningRate;
    this.l2Reg = l2Reg;
  }

  async train(samples: TrainingSample[], modelPath: string): Promise<TrainedModelInfo> {
    if (samples.length === 0) throw new Error('No training samples');

    const X = samples.map((s) => FEATURE_COLUMNS.map((c) => Number(s.features[c])));
    const y = samples.map((s) => LABEL_INDEX[s.label]);

    // Initialize normalization from first batch
    if (!this.initialized) {
      this.computeNormalization(X);
      this.initWeights();
      this.initialized = true;
    }

    // Online training: process one sample at a time
    for (let i = 0; i < X.length; i++) {
      this.partialFit(X[i], y[i]);
    }

    // Compute training accuracy
    let correct = 0;
    for (let i = 0; i < X.length; i++) {
      const xNorm = this.normalizeRow(X[i]);
      const pred = this.predictClass(xNorm);
      if (pred === y[i]) correct++;
    }

    this.save(modelPath);

    return {
      modelName: this.name,
      modelType: this.type,
      modelPath,
      trainSamples: this.samplesSeen,
      accuracy: correct / X.length,
    };
  }

  /**
   * Online update: process a single sample.
   * Can be called after initial training to incrementally update the model.
   */
  partialFit(features: ModelSizeFeatures | number[], label: number): void {
    const x = Array.isArray(features)
      ? features
      : FEATURE_COLUMNS.map((c) => Number(features[c]));

    if (!this.initialized) {
      this.computeNormalization([x]);
      this.initWeights();
      this.initialized = true;
    }

    const xNorm = this.normalizeRow(x);
    const probs = this.softmax(this.forward(xNorm));

    // Gradient of cross-entropy loss
    const grad = probs.map((p, c) => p - (label === c ? 1 : 0));

    // AdaGrad update
    const numFeatures = xNorm.length;
    for (let c = 0; c < NUM_CLASSES; c++) {
      for (let f = 0; f < numFeatures; f++) {
        const g = grad[c] * xNorm[f] + this.l2Reg * this.weights[c][f];
        this.gradientHistory[c][f] += g * g;
        const adaptiveLr = this.learningRate / Math.sqrt(this.gradientHistory[c][f]);
        this.weights[c][f] -= adaptiveLr * g;
      }
      this.biasGradientHistory[c] += grad[c] * grad[c];
      const adaptiveLr = this.learningRate / Math.sqrt(this.biasGradientHistory[c]);
      this.biases[c] -= adaptiveLr * grad[c];
    }

    this.samplesSeen++;
  }

  async load(modelPath: string): Promise<void> {
    const raw = fs.readFileSync(modelPath, 'utf-8');
    const data = JSON.parse(raw) as OnlineLRModelData;
    this.weights = data.weights;
    this.biases = data.biases;
    this.featureMeans = data.featureMeans;
    this.featureStds = data.featureStds;
    this.gradientHistory = data.gradientHistory;
    this.biasGradientHistory = data.biasGradientHistory;
    this.samplesSeen = data.samplesSeen;
    this.learningRate = data.learningRate;
    this.l2Reg = data.l2Reg;
    this.initialized = true;
  }

  save(modelPath: string): void {
    const modelData: OnlineLRModelData = {
      weights: this.weights,
      biases: this.biases,
      featureMeans: this.featureMeans,
      featureStds: this.featureStds,
      gradientHistory: this.gradientHistory,
      biasGradientHistory: this.biasGradientHistory,
      samplesSeen: this.samplesSeen,
      learningRate: this.learningRate,
      l2Reg: this.l2Reg,
    };
    fs.writeFileSync(modelPath, JSON.stringify(modelData), 'utf-8');
  }

  async predict(features: ModelSizeFeatures): Promise<ModelPrediction> {
    const x = FEATURE_COLUMNS.map((c) => Number(features[c]));
    const xNorm = this.normalizeRow(x);
    const logits = this.forward(xNorm);
    const probs = this.softmax(logits);
    const classIndex = probs.indexOf(Math.max(...probs));
    return {
      label: INDEX_LABEL[classIndex],
      classIndex,
      probabilities: probs,
      confidence: probs[classIndex],
    };
  }

  private initWeights(): void {
    const n = FEATURE_COLUMNS.length;
    this.weights = Array.from({ length: NUM_CLASSES }, () =>
      Array.from({ length: n }, () => (Math.random() - 0.5) * 0.01),
    );
    this.biases = [0, 0, 0];
    this.gradientHistory = Array.from({ length: NUM_CLASSES }, () =>
      Array(n).fill(1e-8),
    );
    this.biasGradientHistory = [1e-8, 1e-8, 1e-8];
  }

  private forward(x: number[]): number[] {
    return this.biases.map((b, c) =>
      b + this.weights[c].reduce((sum, w, f) => sum + w * x[f], 0),
    );
  }

  private softmax(logits: number[]): number[] {
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  }

  private predictClass(xNorm: number[]): number {
    const probs = this.softmax(this.forward(xNorm));
    return probs.indexOf(Math.max(...probs));
  }

  private computeNormalization(X: number[][]): void {
    const n = X.length;
    const d = FEATURE_COLUMNS.length;
    this.featureMeans = Array(d).fill(0);
    this.featureStds = Array(d).fill(1);

    for (let f = 0; f < d; f++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += X[i][f];
      this.featureMeans[f] = sum / n;

      let varSum = 0;
      for (let i = 0; i < n; i++) {
        const diff = X[i][f] - this.featureMeans[f];
        varSum += diff * diff;
      }
      this.featureStds[f] = Math.sqrt(varSum / n) || 1;
    }
  }

  private normalizeRow(x: number[]): number[] {
    return x.map((v, f) => (v - this.featureMeans[f]) / (this.featureStds[f] || 1));
  }
}
