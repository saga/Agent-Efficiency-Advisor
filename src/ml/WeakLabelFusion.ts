// WeakLabelFusion — Snorkel 风格的多弱标签源融合。
//
// 核心思想：我们有多个标签源，每个都不完美：
//   1. behavior  — accept/retry reward（最可靠，但覆盖率低）
//   2. heuristic — 规则启发式（覆盖率高，但准确率一般）
//   3. autoMode  — Copilot 内部 ML（覆盖中等，准确率未知）
//   4. propagated— Label Propagation 图传播（依赖相似度）
//
// Snorkel 方法：
//   - 估计每个源的准确率（通过源间一致性）
//   - 加权融合所有源的标签概率
//   - 输出：每个样本的软标签概率分布 [p_mini, p_medium, p_large]
//
// 这比硬切换（"有行为信号就用行为标签，否则用启发式"）更稳健，
// 因为当多个源一致时置信度更高，源间矛盾时置信度降低。

import type { ModelSizeFeatures, ModelSizeLabel } from './features.js';
import { LABEL_INDEX, INDEX_LABEL } from './features.js';

const NUM_CLASSES = 3;

export type LabelSourceName = 'behavior' | 'heuristic' | 'autoMode' | 'propagated';

export interface WeakLabel {
  source: LabelSourceName;
  /** 标签概率分布 [p_mini, p_medium, p_large]，如果只有一个标签则 one-hot */
  probabilities: number[];
}

export interface FusedLabel {
  /** 融合后的概率分布 */
  probabilities: number[];
  /** 最终标签 */
  label: ModelSizeLabel;
  /** 置信度（最大概率） */
  confidence: number;
  /** 贡献的源及权重 */
  sources: Array<{ name: LabelSourceName; weight: number; label: ModelSizeLabel }>;
}

export interface SourceAccuracy {
  behavior: number;
  heuristic: number;
  autoMode: number;
  propagated: number;
}

const DEFAULT_ACCURACY: SourceAccuracy = {
  behavior: 0.85,
  heuristic: 0.65,
  autoMode: 0.70,
  propagated: 0.60,
};

/**
 * 弱标签融合器。
 *
 * 用法：
 *   const fusion = new WeakLabelFusion();
 *   const result = fusion.fuse([
 *     { source: 'behavior', probabilities: [0.8, 0.15, 0.05] },
 *     { source: 'heuristic', probabilities: [0.1, 0.8, 0.1] },
 *   ]);
 *   // result.label, result.confidence, result.probabilities
 */
export class WeakLabelFusion {
  private accuracy: SourceAccuracy;

  constructor(accuracy?: Partial<SourceAccuracy>) {
    this.accuracy = { ...DEFAULT_ACCURACY, ...accuracy };
  }

  /**
   * 融合多个弱标签源的预测。
   *
   * 权重 = source_accuracy / (1 - source_accuracy)
   * 这使得高准确率的源权重远高于低准确率的源。
   */
  fuse(labels: WeakLabel[]): FusedLabel {
    if (labels.length === 0) {
      return {
        probabilities: [1 / 3, 1 / 3, 1 / 3],
        label: 'medium',
        confidence: 1 / 3,
        sources: [],
      };
    }

    // 计算每个源的权重
    const weights = labels.map((l) => {
      const acc = this.accuracy[l.source] ?? 0.5;
      // 使用 odds ratio: w = acc / (1 - acc)
      // acc=0.85 → w≈5.67, acc=0.65 → w≈1.86, acc=0.5 → w=1.0
      return acc / (1 - acc + 1e-8);
    });

    const totalWeight = weights.reduce((a, b) => a + b, 0);

    // 加权平均概率
    const fusedProbs = Array(NUM_CLASSES).fill(0);
    for (let i = 0; i < labels.length; i++) {
      for (let c = 0; c < NUM_CLASSES; c++) {
        fusedProbs[c] += weights[i] * labels[i].probabilities[c];
      }
    }
    for (let c = 0; c < NUM_CLASSES; c++) {
      fusedProbs[c] /= totalWeight;
    }

    const maxIdx = fusedProbs.indexOf(Math.max(...fusedProbs));

    return {
      probabilities: fusedProbs,
      label: INDEX_LABEL[maxIdx],
      confidence: fusedProbs[maxIdx],
      sources: labels.map((l, i) => ({
        name: l.source,
        weight: weights[i] / totalWeight,
        label: INDEX_LABEL[l.probabilities.indexOf(Math.max(...l.probabilities))],
      })),
    };
  }

  /**
   * 批量估计源准确率（Snorkel 风格）。
   *
   * 对于每对源 (A, B)，计算它们在相同样本上一致的比例。
   * 如果 A 和 B 独立，则 P(A=B) = P(A正确) * P(B正确) + P(A错误) * P(B错误)
   * 通过多对源的一致性矩阵，可以解出每个源的准确率。
   *
   * 这里用简化版本：用多数投票作为伪真值，估计每个源与多数投票的一致率。
   */
  estimateAccuracy(
    allLabels: Map<string, WeakLabel[]>,
  ): SourceAccuracy {
    const sourceNames: LabelSourceName[] = ['behavior', 'heuristic', 'autoMode', 'propagated'];
    const sourceCorrect: Record<LabelSourceName, number> = {
      behavior: 0, heuristic: 0, autoMode: 0, propagated: 0,
    };
    const sourceTotal: Record<LabelSourceName, number> = {
      behavior: 0, heuristic: 0, autoMode: 0, propagated: 0,
    };

    for (const [, labels] of allLabels) {
      if (labels.length < 2) continue;

      // 多数投票
      const votes = Array(NUM_CLASSES).fill(0);
      for (const l of labels) {
        const idx = l.probabilities.indexOf(Math.max(...l.probabilities));
        votes[idx]++;
      }
      const majorityIdx = votes.indexOf(Math.max(...votes));

      // 每个源与多数投票的一致性
      for (const l of labels) {
        sourceTotal[l.source]++;
        const idx = l.probabilities.indexOf(Math.max(...l.probabilities));
        if (idx === majorityIdx) {
          sourceCorrect[l.source]++;
        }
      }
    }

    const estimated: SourceAccuracy = { ...DEFAULT_ACCURACY };
    for (const name of sourceNames) {
      if (sourceTotal[name] > 0) {
        estimated[name] = sourceCorrect[name] / sourceTotal[name];
      }
    }

    this.accuracy = estimated;
    return estimated;
  }

  /**
   * 从标签和概率分布创建 WeakLabel。
   */
  static fromLabel(source: LabelSourceName, label: ModelSizeLabel): WeakLabel {
    const probs = Array(NUM_CLASSES).fill(0.1 / (NUM_CLASSES - 1));
    probs[LABEL_INDEX[label]] = 0.9;
    return { source, probabilities: probs };
  }

  static fromProbabilities(source: LabelSourceName, probabilities: number[]): WeakLabel {
    return { source, probabilities };
  }
}
