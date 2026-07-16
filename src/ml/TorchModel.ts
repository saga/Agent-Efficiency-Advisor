// TorchMLP — 用 PyTorch 训练的 MLP 神经网络分类器
//
// 训练由 Python torch 完成(见 scripts/train_torch_model.py),导出权重为 JSON。
// 预测纯 TS 实现(矩阵乘法 + ReLU + softmax),无跨进程开销。
// 结构: input(34) → hidden(64) → ReLU → output(3) → softmax

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

interface TorchModelData {
  W1: number[][]; // [features, hidden]
  b1: number[];   // [hidden]
  W2: number[][]; // [hidden, classes]
  b2: number[];   // [classes]
  featureMeans: number[];
  featureStds: number[];
  hiddenSize: number;
  epochs: number;
}

export class TorchModel implements TrainableModel {
  readonly name = 'Torch MLP';
  readonly type = 'torch' as const;

  private W1: number[][] = [];
  private b1: number[] = [];
  private W2: number[][] = [];
  private b2: number[] = [];
  private featureMeans: number[] = [];
  private featureStds: number[] = [];
  private hiddenSize = 64;

  async train(samples: TrainingSample[], modelPath: string): Promise<TrainedModelInfo> {
    if (samples.length === 0) throw new Error('No training samples');

    const outDir = path.dirname(modelPath);
    const { csvPath } = saveDataset(samples, outDir);
    const scriptPath = path.resolve(process.cwd(), 'scripts/train_torch_model.py');
    const stdout = await execPython(scriptPath, ['--train-csv', csvPath, '--model-out', modelPath]);
    const result = JSON.parse(stdout) as { accuracy: number; featureImportance: Record<string, number>; trainSamples: number };

    await this.load(modelPath);

    return {
      modelName: this.name,
      modelType: this.type,
      modelPath,
      trainSamples: samples.length,
      accuracy: result.accuracy,
      featureImportance: result.featureImportance,
    };
  }

  async load(modelPath: string): Promise<void> {
    const raw = fs.readFileSync(modelPath, 'utf-8');
    const data = JSON.parse(raw) as TorchModelData;
    this.W1 = data.W1;
    this.b1 = data.b1;
    this.W2 = data.W2;
    this.b2 = data.b2;
    this.featureMeans = data.featureMeans;
    this.featureStds = data.featureStds;
    this.hiddenSize = data.hiddenSize;
  }

  async predict(features: ModelSizeFeatures): Promise<ModelPrediction> {
    const x = this.normalizeRow(FEATURE_COLUMNS.map((c) => Number(features[c])));
    const logits = this.forward(x);
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
    // Hidden layer: h = relu(x @ W1 + b1)
    // W1: [features, hidden]
    const h = new Array(this.hiddenSize).fill(0);
    for (let j = 0; j < this.hiddenSize; j++) {
      let sum = this.b1[j];
      for (let i = 0; i < x.length; i++) {
        sum += x[i] * this.W1[i][j];
      }
      h[j] = Math.max(0, sum); // ReLU
    }

    // Output layer: logits = h @ W2 + b2
    // W2: [hidden, classes]
    const logits = new Array(NUM_CLASSES).fill(0);
    for (let c = 0; c < NUM_CLASSES; c++) {
      let sum = this.b2[c];
      for (let j = 0; j < this.hiddenSize; j++) {
        sum += h[j] * this.W2[j][c];
      }
      logits[c] = sum;
    }
    return logits;
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
