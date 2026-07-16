// GaussianNaiveBayes — 高斯朴素贝叶斯分类器
//
// 训练由 Python sklearn 完成(见 scripts/train_sklearn_models.py),导出均值/方差/先验。
// 预测纯 TS 实现,无跨进程开销 (<0.1ms)。
// 16 个计数特征做 log(1+x) 变换,防止长尾分布导致方差爆炸。

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

/** 需要做 log(1+x) 变换的计数/大范围特征(必须与 train_sklearn_models.py 一致) */
const LOG_TRANSFORM_COLS = new Set([
  'promptTokens', 'completionTokens', 'contextTokens',
  'toolCalls', 'readFiles', 'edits', 'retries',
  'uniqueFilesRead', 'uniqueFilesEdited', 'elapsedMs',
  'chatDurationMs', 'toolDurationMs', 'idleMs',
  'rollingAvgTokens', 'rollingAvgDuration', 'emaTokens',
]);

/** 对指定特征做 log(1+x) 变换,压缩大范围计数特征的动态范围 */
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

    // 保存 CSV,调用 Python sklearn 训练
    const outDir = path.dirname(modelPath);
    const { csvPath } = saveDataset(samples, outDir);
    const scriptPath = path.resolve(process.cwd(), 'scripts/train_sklearn_models.py');
    const stdout = await execPython(scriptPath, ['--train-csv', csvPath, '--nb-out', modelPath, '--model', 'nb']);
    const result = JSON.parse(stdout) as { naivebayes: { accuracy: number; featureImportance: Record<string, number> } };

    await this.load(modelPath);

    return {
      modelName: this.name,
      modelType: this.type,
      modelPath,
      trainSamples: samples.length,
      accuracy: result.naivebayes.accuracy,
      featureImportance: result.naivebayes.featureImportance,
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
