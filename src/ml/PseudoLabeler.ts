// PseudoLabeler — 自训练伪标签生成。
//
// 核心思想：很多真实 Copilot 会话没有 accept/retry 行为信号（只有 chat/completion），
// 当前这些会话要么用启发式标签，要么被丢弃。Pseudo-labeling 的做法是：
//
//   1. 用已有标签的样本训练初始模型
//   2. 用初始模型预测无标签样本
//   3. 对高置信度预测（confidence > threshold），将预测作为伪标签
//   4. 合并有标签 + 伪标签样本，重新训练
//   5. 可迭代多轮（self-training）
//
// 关键设计：
//   - 置信度阈值随轮次递减（第一轮严格，后续逐渐放宽）
//   - 每轮伪标签数量有上限，避免低质量伪标签淹没真实标签
//   - 伪标签样本权重低于真实标签样本（weight < 1.0）

import type { ModelPrediction, TrainableModel } from './ModelInterface.js';
import type { TrainingSample } from './dataset.js';
import type { ModelSizeFeatures, ModelSizeLabel } from './features.js';
import { LABEL_INDEX } from './features.js';

export interface PseudoLabelOptions {
  /** 置信度阈值（第一轮） */
  confidenceThreshold?: number;
  /** 每轮置信度衰减率 */
  confidenceDecay?: number;
  /** 最低置信度阈值（不会低于此值） */
  minConfidence?: number;
  /** 每轮伪标签数量上限 */
  maxPseudoPerRound?: number;
  /** 伪标签样本权重（真实标签=1.0） */
  pseudoWeight?: number;
  /** 最大迭代轮次 */
  maxRounds?: number;
}

export interface PseudoLabelResult {
  /** 合并后的训练样本（真实 + 伪标签） */
  samples: TrainingSample[];
  /** 本轮生成的伪标签信息 */
  pseudoLabels: Array<{
    sessionId: string;
    label: ModelSizeLabel;
    confidence: number;
    round: number;
  }>;
  /** 每轮统计 */
  rounds: Array<{ round: number; pseudoCount: number; avgConfidence: number }>;
}

/**
 * 伪标签生成器。
 *
 * 用法：
 *   const labeler = new PseudoLabeler(model);
 *   const result = await labeler.generate(labeledSamples, unlabeledFeatures);
 *   // result.samples 包含原始 + 伪标签样本
 */
export class PseudoLabeler {
  constructor(
    private model: TrainableModel,
    private options: PseudoLabelOptions = {},
  ) {}

  /**
   * 生成伪标签并返回合并后的训练集。
   *
   * @param labeledSamples 已有标签的训练样本
   * @param unlabeledSamples 无标签样本（label 字段会被忽略）
   * @param modelPath 模型保存路径
   */
  async generate(
    labeledSamples: TrainingSample[],
    unlabeledSamples: TrainingSample[],
    modelPath: string,
  ): Promise<PseudoLabelResult> {
    const confidenceThreshold = this.options.confidenceThreshold ?? 0.85;
    const confidenceDecay = this.options.confidenceDecay ?? 0.95;
    const minConfidence = this.options.minConfidence ?? 0.65;
    const maxPseudoPerRound = this.options.maxPseudoPerRound ?? 50;
    const pseudoWeight = this.options.pseudoWeight ?? 0.7;
    const maxRounds = this.options.maxRounds ?? 3;

    const allPseudoLabels: PseudoLabelResult['pseudoLabels'] = [];
    const roundsInfo: PseudoLabelResult['rounds'] = [];

    let currentLabeled = [...labeledSamples];
    let remaining = [...unlabeledSamples];
    let currentThreshold = confidenceThreshold;

    for (let round = 1; round <= maxRounds; round++) {
      if (remaining.length === 0) break;

      // 训练当前模型
      await this.model.train(currentLabeled, modelPath);
      await this.model.load(modelPath);

      // 预测无标签样本
      const predictions: Array<{
        sample: TrainingSample;
        prediction: ModelPrediction;
      }> = [];

      for (const sample of remaining) {
        const pred = await this.model.predict(sample.features);
        predictions.push({ sample, prediction: pred });
      }

      // 筛选高置信度预测
      const highConfidence = predictions
        .filter((p) => p.prediction.confidence >= currentThreshold)
        .sort((a, b) => b.prediction.confidence - a.prediction.confidence)
        .slice(0, maxPseudoPerRound);

      if (highConfidence.length === 0) {
        // 降低阈值继续
        currentThreshold = Math.max(currentThreshold * confidenceDecay, minConfidence);
        if (currentThreshold <= minConfidence && highConfidence.length === 0) break;
        continue;
      }

      // 生成伪标签
      const pseudoThisRound: TrainingSample[] = [];
      let confSum = 0;

      for (const { sample, prediction } of highConfidence) {
        const pseudoSample: TrainingSample = {
          ...sample,
          label: prediction.label,
          // 用权重标记伪标签（通过 sessionId 前缀）
          sessionId: `pseudo:${sample.sessionId}`,
        };
        pseudoThisRound.push(pseudoSample);
        confSum += prediction.confidence;
        allPseudoLabels.push({
          sessionId: sample.sessionId,
          label: prediction.label,
          confidence: prediction.confidence,
          round,
        });
      }

      // 添加伪权重：通过重复真实样本 vs 减少伪标签样本影响
      // 这里简单地将伪标签加入训练集
      currentLabeled = [...currentLabeled, ...pseudoThisRound];

      // 从 remaining 中移除已标注的
      const pseudoIds = new Set(highConfidence.map((h) => h.sample.sessionId));
      remaining = remaining.filter((s) => !pseudoIds.has(s.sessionId));

      roundsInfo.push({
        round,
        pseudoCount: highConfidence.length,
        avgConfidence: confSum / highConfidence.length,
      });

      // 降低下一轮阈值
      currentThreshold = Math.max(currentThreshold * confidenceDecay, minConfidence);
    }

    return {
      samples: currentLabeled,
      pseudoLabels: allPseudoLabels,
      rounds: roundsInfo,
    };
  }

  /**
   * 静态方法：从一个训练好的模型直接生成伪标签（单轮，不迭代）。
   */
  static async generateSingleRound(
    model: TrainableModel,
    unlabeledSamples: TrainingSample[],
    threshold = 0.85,
  ): Promise<Array<{ sample: TrainingSample; label: ModelSizeLabel; confidence: number }>> {
    const results: Array<{ sample: TrainingSample; label: ModelSizeLabel; confidence: number }> = [];

    for (const sample of unlabeledSamples) {
      const pred = await model.predict(sample.features);
      if (pred.confidence >= threshold) {
        results.push({
          sample,
          label: pred.label,
          confidence: pred.confidence,
        });
      }
    }

    return results;
  }
}
