// BayesianLogisticRegression — 带 L2 正则的 softmax 回归
//
// 纯 TS 实现,无 Python 依赖。预测 <1ms。
// 适合小样本场景(6-50 样本),比树模型更不容易过拟合。
//
// 训练用 SGD + L2 正则,输出 softmax 概率作为校准置信度。

import fs from 'node:fs';
import type { ModelPrediction, TrainableModel, TrainedModelInfo } from './ModelInterface.js';
import type { TrainingSample } from './dataset.js';
import {
  FEATURE_COLUMNS,
  INDEX_LABEL,
  LABEL_INDEX,
  type ModelSizeFeatures,
  type ModelSizeLabel,
} from './features.js';

const LABELS: ModelSizeLabel[] = ['mini', 'medium', 'large'];
const NUM_CLASSES = 3;

interface LRModelData {
  weights: number[][]; // [numClasses][numFeatures]
  biases: number[]; // [numClasses]
  featureMeans: number[];
  featureStds: number[];
  iterations: number;
  learningRate: number;
  l2Reg: number;
}

export class LogisticRegressionModel implements TrainableModel {
  readonly name = 'Bayesian Logistic Regression';
  readonly type = 'logistic' as const;

  private weights: number[][] = [];
  private biases: number[] = [0, 0, 0];
  private featureMeans: number[] = [];
  private featureStds: number[] = [];

  constructor(
    private iterations = 500,
    private learningRate = 0.01,
    private l2Reg = 0.01,
  ) {}

  async train(samples: TrainingSample[], modelPath: string): Promise<TrainedModelInfo> {
    if (samples.length === 0) throw new Error('No training samples');

    // 提取特征矩阵并标准化
    const X = samples.map((s) => FEATURE_COLUMNS.map((c) => Number(s.features[c])));
    const y = samples.map((s) => LABEL_INDEX[s.label]);

    this.computeNormalization(X);
    const XNorm = this.normalize(X);

    // 初始化权重
    const numFeatures = FEATURE_COLUMNS.length;
    this.weights = Array.from({ length: NUM_CLASSES }, () =>
      Array.from({ length: numFeatures }, () => (Math.random() - 0.5) * 0.01),
    );
    this.biases = [0, 0, 0];

    // SGD 训练
    for (let iter = 0; iter < this.iterations; iter++) {
      for (let i = 0; i < XNorm.length; i++) {
        const probs = this.softmax(this.forward(XNorm[i]));
        const grad = probs.map((p, c) => p - (y[i] === c ? 1 : 0));

        for (let c = 0; c < NUM_CLASSES; c++) {
          for (let f = 0; f < numFeatures; f++) {
            this.weights[c][f] -=
              this.learningRate * (grad[c] * XNorm[i][f] + this.l2Reg * this.weights[c][f]);
          }
          this.biases[c] -= this.learningRate * grad[c];
        }
      }
    }

    // 计算训练准确率
    let correct = 0;
    for (let i = 0; i < XNorm.length; i++) {
      const pred = this.predictLabel(XNorm[i]);
      if (pred === y[i]) correct++;
    }
    const accuracy = correct / XNorm.length;

    // 持久化
    const modelData: LRModelData = {
      weights: this.weights,
      biases: this.biases,
      featureMeans: this.featureMeans,
      featureStds: this.featureStds,
      iterations: this.iterations,
      learningRate: this.learningRate,
      l2Reg: this.l2Reg,
    };
    fs.writeFileSync(modelPath, JSON.stringify(modelData), 'utf-8');

    // 特征重要性:用权重绝对值的均值
    const featureImportance: Record<string, number> = {};
    for (let f = 0; f < FEATURE_COLUMNS.length; f++) {
      let sum = 0;
      for (let c = 0; c < NUM_CLASSES; c++) {
        sum += Math.abs(this.weights[c][f]);
      }
      featureImportance[FEATURE_COLUMNS[f]] = sum / NUM_CLASSES;
    }

    return {
      modelName: this.name,
      modelType: this.type,
      modelPath,
      trainSamples: samples.length,
      accuracy,
      featureImportance,
    };
  }

  async load(modelPath: string): Promise<void> {
    const raw = fs.readFileSync(modelPath, 'utf-8');
    const data = JSON.parse(raw) as LRModelData;
    this.weights = data.weights;
    this.biases = data.biases;
    this.featureMeans = data.featureMeans;
    this.featureStds = data.featureStds;
    this.iterations = data.iterations;
    this.learningRate = data.learningRate;
    this.l2Reg = data.l2Reg;
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

  private forward(x: number[]): number[] {
    return this.biases.map((b, c) => b + this.weights[c].reduce((sum, w, f) => sum + w * x[f], 0));
  }

  private softmax(logits: number[]): number[] {
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  }

  private predictLabel(x: number[]): number {
    const probs = this.softmax(this.forward(x));
    return probs.indexOf(Math.max(...probs));
  }

  private computeNormalization(X: number[][]): void {
    const n = X.length;
    const d = X[0].length;
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

  private normalize(X: number[][]): number[][] {
    return X.map((row) => this.normalizeRow(row));
  }

  private normalizeRow(x: number[]): number[] {
    return x.map((v, f) => (v - this.featureMeans[f]) / (this.featureStds[f] || 1));
  }
}
