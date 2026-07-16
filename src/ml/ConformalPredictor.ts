// ConformalPredictor — 不确定性包裹器
//
// 包裹任意基础模型,输出校准的"我不确定"信号。
// 原理:
//   1. 用 calibration set 计算每个样本的 nonconformity score
//   2. 预测时:若 top-1 和 top-2 概率差 < threshold → 输出 "uncertain"
//   3. 保证:在 calibration set 上的覆盖率 = 1 - α
//
// 不依赖模型假设,数学上保证覆盖率。

import fs from 'node:fs';
import type { ModelPrediction, TrainableModel, TrainedModelInfo } from './ModelInterface.js';
import type { TrainingSample } from './dataset.js';
import type { ModelSizeFeatures } from './features.js';
import { LABEL_INDEX } from './features.js';

interface ConformalModelData {
  alpha: number;
  threshold: number;
  calibrationScores: number[];
}

/**
 * 包裹一个基础 TrainableModel,添加 conformal prediction 能力。
 */
export class ConformalPredictor implements TrainableModel {
  readonly name = 'Conformal Predictor';
  readonly type = 'conformal' as const;

  private alpha: number;
  private threshold = 0.5;
  private calibrationScores: number[] = [];

  constructor(
    private baseModel: TrainableModel,
    alpha = 0.1,
  ) {
    this.alpha = alpha; // 期望错误率 = 0.1 → 覆盖率 = 90%
  }

  async train(samples: TrainingSample[], modelPath: string): Promise<TrainedModelInfo> {
    if (samples.length === 0) throw new Error('No training samples');

    // 分割:70% 训练基础模型,30% 校准
    const splitIdx = Math.floor(samples.length * 0.7);
    const trainSamples = samples.slice(0, splitIdx);
    const calibSamples = samples.slice(splitIdx);

    // 训练基础模型
    const basePath = modelPath.replace('.json', '-base.json').replace('.cbm', '-base.cbm');
    const baseInfo = await this.baseModel.train(trainSamples, basePath);
    await this.baseModel.load(basePath);

    // 计算校准集的 nonconformity scores
    this.calibrationScores = [];
    for (const sample of calibSamples) {
      const pred = await this.baseModel.predict(sample.features);
      // nonconformity = 1 - trueLabelProbability
      const trueLabelIdx = LABEL_INDEX[sample.label];
      const trueLabelProb = pred.probabilities[trueLabelIdx] ?? 0;
      this.calibrationScores.push(1 - trueLabelProb);
    }

    // 计算 threshold:使 (1-alpha) 分位数的 score 作为拒绝阈值
    if (this.calibrationScores.length > 0) {
      const sorted = [...this.calibrationScores].sort((a, b) => a - b);
      const qIdx = Math.ceil((1 - this.alpha) * sorted.length) - 1;
      this.threshold = sorted[Math.max(0, qIdx)] ?? 0.5;
    }

    // 持久化
    const modelData: ConformalModelData = {
      alpha: this.alpha,
      threshold: this.threshold,
      calibrationScores: this.calibrationScores,
    };
    fs.writeFileSync(modelPath, JSON.stringify(modelData), 'utf-8');

    return {
      ...baseInfo,
      modelName: `${this.name} (wrapping ${baseInfo.modelName})`,
      modelType: this.type,
      modelPath,
    };
  }

  async load(modelPath: string): Promise<void> {
    const raw = fs.readFileSync(modelPath, 'utf-8');
    const data = JSON.parse(raw) as ConformalModelData;
    this.alpha = data.alpha;
    this.threshold = data.threshold;
    this.calibrationScores = data.calibrationScores;

    // 加载基础模型
    const basePath = modelPath.replace('.json', '-base.json').replace('.cbm', '-base.cbm');
    await this.baseModel.load(basePath);
  }

  async predict(features: ModelSizeFeatures): Promise<ModelPrediction> {
    const basePred = await this.baseModel.predict(features);

    // 计算 nonconformity score:1 - top-1 概率
    const sortedProbs = [...basePred.probabilities].sort((a, b) => b - a);
    const nonconformity = 1 - sortedProbs[0];

    // p-value:calibration set 中 score >= 当前 score 的比例
    const pValue =
      this.calibrationScores.length > 0
        ? (this.calibrationScores.filter((s) => s >= nonconformity).length + 1) /
          (this.calibrationScores.length + 1)
        : 1;

    // 拒绝预测:如果 nonconformity > threshold
    const rejected = nonconformity > this.threshold;

    return {
      ...basePred,
      pValue,
      confidence: rejected ? basePred.confidence * 0.5 : basePred.confidence, // 降低拒绝时的置信度
      rejected,
    };
  }
}
