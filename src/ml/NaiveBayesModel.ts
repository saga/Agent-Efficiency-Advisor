// GaussianNaiveBayes — 高斯朴素贝叶斯分类器
//
// 纯 TS 实现,无 Python 依赖。预测 <0.1ms。
// 6 个样本即可估计每类的均值/方差,天然处理缺失特征(独立假设下)。
// 作为 LR 的 baseline,防止过拟合。

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

const NUM_CLASSES = 3;
const VARIANCE_SMOOTHING = 1e-6; // 防止方差为 0

/** 需要做 log(1+x) 变换的计数/大范围特征 */
const LOG_TRANSFORM_COLS = new Set([
  'promptTokens', 'completionTokens', 'contextTokens',
  'toolCalls', 'readFiles', 'edits', 'retries',
  'uniqueFilesRead', 'uniqueFilesEdited', 'elapsedMs',
  'chatDurationMs', 'toolDurationMs', 'idleMs',
  'rollingAvgTokens', 'rollingAvgDuration', 'emaTokens',
]);

/** 对指定特征做 log(1+x) 变换，压缩大范围计数特征的动态范围 */
function applyLogTransform(features: ModelSizeFeatures): number[] {
  return FEATURE_COLUMNS.map((c) => {
    const v = Number(features[c]);
    return LOG_TRANSFORM_COLS.has(c) ? Math.log1p(v) : v;
  });
}

interface NBModelData {
  means: number[][]; // [numClasses][numFeatures]
  variances: number[][]; // [numClasses][numFeatures]
  priors: number[]; // [numClasses]
}

export class NaiveBayesModel implements TrainableModel {
  readonly name = 'Gaussian Naive Bayes';
  readonly type = 'naivebayes' as const;

  private means: number[][] = [];
  private variances: number[][] = [];
  private priors: number[] = [1 / 3, 1 / 3, 1 / 3];

  async train(samples: TrainingSample[], modelPath: string): Promise<TrainedModelInfo> {
    if (samples.length === 0) throw new Error('No training samples');

    const X = samples.map((s) => applyLogTransform(s.features));
    const y = samples.map((s) => LABEL_INDEX[s.label]);
    const numFeatures = FEATURE_COLUMNS.length;

    // 按类别分组
    this.means = Array.from({ length: NUM_CLASSES }, () => Array(numFeatures).fill(0));
    this.variances = Array.from({ length: NUM_CLASSES }, () => Array(numFeatures).fill(0));
    const classCounts = Array(NUM_CLASSES).fill(0);

    // 计算均值
    for (let i = 0; i < X.length; i++) {
      const c = y[i];
      classCounts[c]++;
      for (let f = 0; f < numFeatures; f++) {
        this.means[c][f] += X[i][f];
      }
    }
    for (let c = 0; c < NUM_CLASSES; c++) {
      if (classCounts[c] > 0) {
        for (let f = 0; f < numFeatures; f++) {
          this.means[c][f] /= classCounts[c];
        }
      }
    }

    // 计算方差
    for (let i = 0; i < X.length; i++) {
      const c = y[i];
      for (let f = 0; f < numFeatures; f++) {
        const diff = X[i][f] - this.means[c][f];
        this.variances[c][f] += diff * diff;
      }
    }
    for (let c = 0; c < NUM_CLASSES; c++) {
      if (classCounts[c] > 1) {
        for (let f = 0; f < numFeatures; f++) {
          this.variances[c][f] = this.variances[c][f] / classCounts[c] + VARIANCE_SMOOTHING;
        }
      } else {
        // 只有一个样本的类:用全局方差
        this.variances[c] = Array(numFeatures).fill(VARIANCE_SMOOTHING);
      }
    }

    // 先验概率
    this.priors = classCounts.map((c) => c / samples.length);

    // 持久化
    const modelData: NBModelData = {
      means: this.means,
      variances: this.variances,
      priors: this.priors,
    };
    fs.writeFileSync(modelPath, JSON.stringify(modelData), 'utf-8');

    // 计算准确率
    let correct = 0;
    for (let i = 0; i < X.length; i++) {
      const pred = this.predictClass(X[i]);
      if (pred === y[i]) correct++;
    }

    // 特征重要性:用类间均值差/方差作为区分度
    const featureImportance: Record<string, number> = {};
    for (let f = 0; f < numFeatures; f++) {
      let separation = 0;
      for (let c1 = 0; c1 < NUM_CLASSES; c1++) {
        for (let c2 = c1 + 1; c2 < NUM_CLASSES; c2++) {
          const diff = Math.abs(this.means[c1][f] - this.means[c2][f]);
          const avgStd = (Math.sqrt(this.variances[c1][f]) + Math.sqrt(this.variances[c2][f])) / 2 || 1;
          separation += diff / avgStd;
        }
      }
      featureImportance[FEATURE_COLUMNS[f]] = separation;
    }

    return {
      modelName: this.name,
      modelType: this.type,
      modelPath,
      trainSamples: samples.length,
      accuracy: correct / samples.length,
      featureImportance,
    };
  }

  async load(modelPath: string): Promise<void> {
    const raw = fs.readFileSync(modelPath, 'utf-8');
    const data = JSON.parse(raw) as NBModelData;
    this.means = data.means;
    this.variances = data.variances;
    this.priors = data.priors;
  }

  async predict(features: ModelSizeFeatures): Promise<ModelPrediction> {
    const x = applyLogTransform(features);
    const logProbs = this.computeLogProbs(x);

    // 归一化为概率
    const maxLog = Math.max(...logProbs);
    const exps = logProbs.map((l) => Math.exp(l - maxLog));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map((e) => e / sum);

    const classIndex = probs.indexOf(Math.max(...probs));
    return {
      label: INDEX_LABEL[classIndex],
      classIndex,
      probabilities: probs,
      confidence: probs[classIndex],
    };
  }

  private predictClass(x: number[]): number {
    const logProbs = this.computeLogProbs(x);
    return logProbs.indexOf(Math.max(...logProbs));
  }

  private computeLogProbs(x: number[]): number[] {
    const logProbs: number[] = [];
    for (let c = 0; c < NUM_CLASSES; c++) {
      let logProb = Math.log(this.priors[c]);
      for (let f = 0; f < x.length; f++) {
        const mean = this.means[c][f];
        const variance = this.variances[c][f];
        // 高斯对数似然
        logProb += -0.5 * Math.log(2 * Math.PI * variance) - ((x[f] - mean) ** 2) / (2 * variance);
      }
      logProbs[c] = logProb;
    }
    return logProbs;
  }
}
