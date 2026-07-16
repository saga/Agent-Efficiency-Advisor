// TemperatureScaler — 轻量概率校准。
//
// 核心思想：softmax(logits / T) 中，温度 T 控制概率分布的"锐度"。
//   T > 1 → 概率更平滑（降低过自信）
//   T < 1 → 概率更尖锐（增强自信）
//   T = 1 → 原始概率
//
// 训练：在验证集上优化 T，最小化 NLL (Negative Log-Likelihood)。
// 这只需要学一个标量参数，极其轻量，但能显著改善概率校准。
//
// 应用：在 StackingMetaLearner 中，每个 base model 的概率先经过
// TemperatureScaler 校准，再输入 meta-learner，使 meta-features 更可靠。

import fs from 'node:fs';
import type { ModelPrediction, TrainableModel, TrainedModelInfo } from './ModelInterface.js';
import type { TrainingSample } from './dataset.js';
import type { ModelSizeFeatures } from './features.js';
import { LABEL_INDEX } from './features.js';

const NUM_CLASSES = 3;

interface TempScalerData {
  temperature: number;
  baseModelPath: string;
}

/**
 * 温度缩放校准器。
 *
 * 用法：
 *   const scaler = new TemperatureScaler(baseModel);
 *   await scaler.train(samples, modelPath); // 先训练 base model，再学 T
 *   const pred = await scaler.predict(features); // base model 预测 → 温度校准
 */
export class TemperatureScaler implements TrainableModel {
  readonly name = 'Temperature Scaled';
  readonly type = 'logistic' as const;

  private temperature = 1.0;
  private baseModel: TrainableModel;
  private baseModelPath = '';

  constructor(baseModel: TrainableModel) {
    this.baseModel = baseModel;
  }

  async train(samples: TrainingSample[], modelPath: string): Promise<TrainedModelInfo> {
    if (samples.length === 0) throw new Error('No training samples');

    // 1. 训练基础模型（用 70% 数据）
    const splitIdx = Math.max(2, Math.floor(samples.length * 0.7));
    const trainSamples = samples.slice(0, splitIdx);
    const valSamples = samples.slice(splitIdx);

    this.baseModelPath = modelPath.replace('.json', '-base.json').replace('.cbm', '-base.cbm');
    const baseInfo = await this.baseModel.train(trainSamples, this.baseModelPath);
    await this.baseModel.load(this.baseModelPath);

    // 2. 在验证集上收集 logits（通过反 softmax 推断）
    if (valSamples.length > 0) {
      const valLogits: number[][] = [];
      const valLabels: number[] = [];

      for (const sample of valSamples) {
        const pred = await this.baseModel.predict(sample.features);
        // 从概率反推 logits: logit_c = log(p_c) + C (C 是任意常数，温度缩放不变)
        // 我们只需要相对 logits，所以取 log(p) 即可
        const logits = pred.probabilities.map((p) => Math.log(p + 1e-10));
        valLogits.push(logits);
        valLabels.push(LABEL_INDEX[sample.label]);
      }

      // 3. 优化温度 T（梯度下降，最小化 NLL）
      this.temperature = this.optimizeTemperature(valLogits, valLabels);
    }

    // 4. 持久化
    const data: TempScalerData = {
      temperature: this.temperature,
      baseModelPath: this.baseModelPath,
    };
    fs.writeFileSync(modelPath, JSON.stringify(data), 'utf-8');

    return {
      ...baseInfo,
      modelName: `${this.name} (${baseInfo.modelName})`,
      modelPath,
      accuracy: baseInfo.accuracy,
    };
  }

  async load(modelPath: string): Promise<void> {
    const raw = fs.readFileSync(modelPath, 'utf-8');
    const data = JSON.parse(raw) as TempScalerData;
    this.temperature = data.temperature;
    this.baseModelPath = data.baseModelPath;
    await this.baseModel.load(this.baseModelPath);
  }

  async predict(features: ModelSizeFeatures): Promise<ModelPrediction> {
    const basePred = await this.baseModel.predict(features);

    // 从概率反推 logits，应用温度缩放
    const logits = basePred.probabilities.map((p) => Math.log(p + 1e-10));
    const scaledLogits = logits.map((l) => l / this.temperature);
    const calibratedProbs = this.softmax(scaledLogits);

    const maxIdx = calibratedProbs.indexOf(Math.max(...calibratedProbs));

    return {
      ...basePred,
      probabilities: calibratedProbs,
      confidence: calibratedProbs[maxIdx],
    };
  }

  /**
   * 获取当前温度值。
   */
  getTemperature(): number {
    return this.temperature;
  }

  /**
   * 对已有概率分布进行温度校准（静态方法，不需要 base model）。
   */
  static calibrate(probabilities: number[], temperature: number): number[] {
    const logits = probabilities.map((p) => Math.log(p + 1e-10));
    const scaledLogits = logits.map((l) => l / temperature);
    const max = Math.max(...scaledLogits);
    const exps = scaledLogits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  }

  /**
   * 在验证集上优化温度 T。
   * 目标：最小化 NLL = -Σ log(p_true_label)
   * 方法：梯度下降
   *   dNLL/dT = Σ (p_c * logit_c - logit_true) / T²
   */
  private optimizeTemperature(logits: number[][], labels: number[]): number {
    let T = 1.0;
    const lr = 0.05;
    const maxIter = 200;

    for (let iter = 0; iter < maxIter; iter++) {
      let gradient = 0;
      let nll = 0;

      for (let i = 0; i < logits.length; i++) {
        const scaledLogits = logits[i].map((l) => l / T);
        const probs = this.softmax(scaledLogits);
        const trueLabel = labels[i];

        // NLL = -log(p_true)
        nll -= Math.log(probs[trueLabel] + 1e-10);

        // dNLL/dT = Σ_c (p_c * logit_c / T²) - logit_true / T²
        // = (Σ_c p_c * logit_c - logit_true) / T²
        let sumPLogit = 0;
        for (let c = 0; c < NUM_CLASSES; c++) {
          sumPLogit += probs[c] * logits[i][c];
        }
        gradient += (sumPLogit - logits[i][trueLabel]) / (T * T);
      }

      gradient /= logits.length;

      // 梯度下降（T 应 > 0，所以用 exp 移动）
      T = T * Math.exp(-lr * gradient);

      // 限制 T 的范围
      T = Math.max(0.1, Math.min(T, 10.0));
    }

    return T;
  }

  private softmax(logits: number[]): number[] {
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  }
}
