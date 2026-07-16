// KnnModel — K 最近邻 + 距离倒数加权投票
//
// 纯 TS 实现,零训练成本,预测时找最近的 K 个样本。
// 天然增量:新 session 直接加入参考集,无需重训。
// 适合冷启动阶段(样本 < 10)。

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

interface KnnModelData {
  referenceX: number[][];
  referenceY: number[];
  featureMeans: number[];
  featureStds: number[];
  k: number;
}

export class KnnModel implements TrainableModel {
  readonly name = 'KNN Distance-Weighted';
  readonly type = 'knn' as const;

  private referenceX: number[][] = [];
  private referenceY: number[] = [];
  private featureMeans: number[] = [];
  private featureStds: number[] = [];
  private k: number;

  constructor(k?: number) {
    // 默认 K = max(3, floor(sqrt(n))),但不超过样本数
    this.k = k ?? 3;
  }

  async train(samples: TrainingSample[], modelPath: string): Promise<TrainedModelInfo> {
    if (samples.length === 0) throw new Error('No training samples');

    this.referenceX = samples.map((s) => FEATURE_COLUMNS.map((c) => Number(s.features[c])));
    this.referenceY = samples.map((s) => LABEL_INDEX[s.label]);

    // 标准化
    this.computeNormalization(this.referenceX);
    this.referenceX = this.normalizeAll(this.referenceX);

    // 动态调整 K
    this.k = Math.min(Math.max(3, Math.floor(Math.sqrt(samples.length))), samples.length);

    // 持久化
    const modelData: KnnModelData = {
      referenceX: this.referenceX,
      referenceY: this.referenceY,
      featureMeans: this.featureMeans,
      featureStds: this.featureStds,
      k: this.k,
    };
    fs.writeFileSync(modelPath, JSON.stringify(modelData), 'utf-8');

    // 训练准确率(leave-one-out)
    let correct = 0;
    for (let i = 0; i < this.referenceX.length; i++) {
      const pred = this.predictClass(this.referenceX[i], i);
      if (pred === this.referenceY[i]) correct++;
    }

    return {
      modelName: this.name,
      modelType: this.type,
      modelPath,
      trainSamples: samples.length,
      accuracy: correct / samples.length,
    };
  }

  async load(modelPath: string): Promise<void> {
    const raw = fs.readFileSync(modelPath, 'utf-8');
    const data = JSON.parse(raw) as KnnModelData;
    this.referenceX = data.referenceX;
    this.referenceY = data.referenceY;
    this.featureMeans = data.featureMeans;
    this.featureStds = data.featureStds;
    this.k = data.k;
  }

  async predict(features: ModelSizeFeatures): Promise<ModelPrediction> {
    const x = FEATURE_COLUMNS.map((c) => Number(features[c]));
    const xNorm = this.normalizeRow(x);
    const classIndex = this.predictClass(xNorm);
    const probs = this.computeProbabilities(xNorm);

    return {
      label: INDEX_LABEL[classIndex],
      classIndex,
      probabilities: probs,
      confidence: probs[classIndex],
    };
  }

  private predictClass(xNorm: number[], excludeIndex = -1): number {
    const probs = this.computeProbabilities(xNorm, excludeIndex);
    return probs.indexOf(Math.max(...probs));
  }

  private computeProbabilities(xNorm: number[], excludeIndex = -1): number[] {
    // Cosine distance is more robust for features with different magnitudes
    // (promptTokens vs retryRate vs hasLoop have very different scales).
    const distances: Array<{ dist: number; label: number }> = [];
    for (let i = 0; i < this.referenceX.length; i++) {
      if (i === excludeIndex) continue;
      const dist = this.cosineDistance(xNorm, this.referenceX[i]);
      distances.push({ dist: dist || 1e-10, label: this.referenceY[i] });
    }

    // 取最近的 K 个
    distances.sort((a, b) => a.dist - b.dist);
    const knn = distances.slice(0, Math.min(this.k, distances.length));

    // Exponential distance weighting: exp(-d²/σ²) is much more stable than 1/d.
    // σ is set to the median distance of the K nearest neighbors.
    const sortedDists = knn.map((n) => n.dist).sort((a, b) => a - b);
    const sigma = sortedDists[Math.floor(sortedDists.length / 2)] || 1;
    const sigmaSq = sigma * sigma;

    const votes = Array(NUM_CLASSES).fill(0);
    for (const neighbor of knn) {
      votes[neighbor.label] += Math.exp(-(neighbor.dist * neighbor.dist) / sigmaSq);
    }

    const sum = votes.reduce((a, b) => a + b, 0);
    return votes.map((v) => (sum > 0 ? v / sum : 1 / NUM_CLASSES));
  }

  private cosineDistance(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 1; // maximum distance for zero vectors
    return 1 - dot / denom;
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

  private normalizeAll(X: number[][]): number[][] {
    return X.map((row) => this.normalizeRow(row));
  }

  private normalizeRow(x: number[]): number[] {
    return x.map((v, f) => (v - this.featureMeans[f]) / (this.featureStds[f] || 1));
  }
}
