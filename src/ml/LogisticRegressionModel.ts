// BayesianLogisticRegression — 带 L2 正则的 softmax 回归
//
// 训练由 Python sklearn 完成(见 scripts/train_sklearn_models.py),导出权重/偏置/标准化参数。
// 预测纯 TS 实现,无跨进程开销 (<1ms)。
// sklearn 用 lbfgs 优化器 + multinomial softmax,比 TS 手写 SGD 更稳定。

import fs from 'node:fs';
import path from 'node:path';
import type { ModelPrediction, TrainableModel, TrainedModelInfo } from './ModelInterface.js';
import type { TrainingSample } from './dataset.js';
import { saveDataset } from './dataset.js';
import {
  FEATURE_COLUMNS,
  INDEX_LABEL,
  type ModelSizeFeatures,
} from './features.js';
import { execPython } from './pythonExec.js';

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

    // 保存 CSV,调用 Python sklearn 训练
    const outDir = path.dirname(modelPath);
    const { csvPath } = saveDataset(samples, outDir);
    const scriptPath = path.resolve(process.cwd(), 'scripts/train_sklearn_models.py');
    const stdout = await execPython(scriptPath, ['--train-csv', csvPath, '--lr-out', modelPath, '--model', 'lr']);
    const result = JSON.parse(stdout) as { logistic: { accuracy: number; featureImportance: Record<string, number> } };

    await this.load(modelPath);

    return {
      modelName: this.name,
      modelType: this.type,
      modelPath,
      trainSamples: samples.length,
      accuracy: result.logistic.accuracy,
      featureImportance: result.logistic.featureImportance,
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

  private normalizeRow(x: number[]): number[] {
    return x.map((v, f) => (v - this.featureMeans[f]) / (this.featureStds[f] || 1));
  }
}
