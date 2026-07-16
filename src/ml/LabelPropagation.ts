// LabelPropagation — 半监督标签传播
//
// 不是独立分类器,而是标签增强层:
// 1. 有弱标签 session(autoModeResolution)→ 初始标签
// 2. 无标签 session → 通过特征相似度从有标签 session 传播标签
// 3. 收敛后:所有 session 获得软标签(概率分布)
//
// 用法:在训练前调用,把启发式标签替换为传播后的软标签。

import type { TrainingSample } from './dataset.js';
import {
  FEATURE_COLUMNS,
  INDEX_LABEL,
  LABEL_INDEX,
  type ModelSizeFeatures,
  type ModelSizeLabel,
} from './features.js';

const NUM_CLASSES = 3;
const MAX_ITERATIONS = 50;
const CONVERGENCE_THRESHOLD = 1e-4;
const SIGMA = 1.0; // RBF 核宽度

export interface AutoModeSignal {
  predictedLabel: string; // "no_reasoning" | "needs_reasoning"
  confidence: number;
}

export interface LabelPropagationOptions {
  /** autoModeResolution 信号,按 sessionId 索引 */
  autoModeSignals?: Map<string, AutoModeSignal>;
  /** 是否用传播后的软标签替换启发式标签 */
  replaceLabels?: boolean;
  /** 传播阈值:置信度低于此值的样本保留原标签 */
  confidenceThreshold?: number;
}

export interface PropagationResult {
  samples: TrainingSample[];
  /** 传播后的软标签概率 [n][numClasses] */
  labelProbabilities: number[][];
  /** 每个样本的标签来源:'autoMode' | 'propagated' | 'heuristic' */
  labelSources: string[];
  iterations: number;
  converged: boolean;
}

export class LabelPropagation {
  /**
   * 对训练样本执行标签传播。
   * 如果提供了 autoModeSignals,优先用 Copilot 的弱标签作为锚点;
   * 否则用启发式标签作为初始标签,通过特征相似度传播。
   */
  propagate(
    samples: TrainingSample[],
    options: LabelPropagationOptions = {},
  ): PropagationResult {
    const n = samples.length;
    if (n === 0) {
      return {
        samples,
        labelProbabilities: [],
        labelSources: [],
        iterations: 0,
        converged: true,
      };
    }

    const { autoModeSignals, replaceLabels = true, confidenceThreshold = 0.5 } = options;

    // 1. 提取特征矩阵并标准化
    const X = samples.map((s) => FEATURE_COLUMNS.map((c) => Number(s.features[c])));
    const { normalized, means, stds } = this.standardize(X);

    // 2. 构建相似度矩阵(RBF 核)
    const W = this.buildAffinityMatrix(normalized);

    // 3. 初始化标签矩阵
    // Y[i][c] = 1 if sample i has label c, else 0
    // clamp[i] = true if sample i has a "known" label(autoMode 或高置信度启发式)
    const Y = Array.from({ length: n }, () => Array(NUM_CLASSES).fill(0));
    const clamp = Array(n).fill(false);
    const labelSources: string[] = Array(n).fill('heuristic');

    for (let i = 0; i < n; i++) {
      const sessionId = samples[i].sessionId;
      const autoMode = autoModeSignals?.get(sessionId);

      if (autoMode && autoMode.confidence >= confidenceThreshold) {
        // 用 Copilot 的 autoModeResolution 作为锚点
        const label = this.mapAutoModeToLabel(autoMode.predictedLabel);
        Y[i][LABEL_INDEX[label]] = 1;
        clamp[i] = true;
        labelSources[i] = 'autoMode';
      } else {
        // 用启发式标签作为初始值(但不 clamp,允许传播调整)
        Y[i][LABEL_INDEX[samples[i].label]] = 1;
      }
    }

    // 4. 标签传播迭代
    const Y_new = Y.map((row) => [...row]);
    let converged = false;
    let iterations = 0;

    for (iterations = 1; iterations <= MAX_ITERATIONS; iterations++) {
      // 计算行归一化的转移矩阵 T = D^{-1} W
      // Y_new = T * Y
      for (let i = 0; i < n; i++) {
        if (clamp[i]) continue; // clamped 样本保持不变

        const rowSum = W[i].reduce((a, b) => a + b, 0) || 1;
        for (let c = 0; c < NUM_CLASSES; c++) {
          let sum = 0;
          for (let j = 0; j < n; j++) {
            sum += (W[i][j] / rowSum) * Y[j][c];
          }
          Y_new[i][c] = sum;
        }
      }

      // 检查收敛
      let maxDiff = 0;
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < NUM_CLASSES; c++) {
          maxDiff = Math.max(maxDiff, Math.abs(Y_new[i][c] - Y[i][c]));
          Y[i][c] = Y_new[i][c];
        }
      }

      if (maxDiff < CONVERGENCE_THRESHOLD) {
        converged = true;
        break;
      }
    }

    // 5. 归一化为概率分布
    const labelProbabilities = Y.map((row) => {
      const sum = row.reduce((a, b) => a + b, 0) || 1;
      return row.map((v) => v / sum);
    });

    // 6. 可选:用传播后的软标签替换启发式标签
    let resultSamples = samples;
    if (replaceLabels) {
      resultSamples = samples.map((s, i) => {
        if (clamp[i]) return s; // autoMode 锚点不替换
        const newLabel = INDEX_LABEL[labelProbabilities[i].indexOf(Math.max(...labelProbabilities[i]))];
        return { ...s, label: newLabel };
      });
    }

    return {
      samples: resultSamples,
      labelProbabilities,
      labelSources,
      iterations,
      converged,
    };
  }

  /**
   * 把 Copilot autoModeResolution 的 predictedLabel 映射到 ModelSizeLabel。
   * - "no_reasoning" → mini(简单任务不需要推理,小模型即可)
   * - "needs_reasoning" → large(需要推理,用大模型)
   * - 其他 → medium
   */
  private mapAutoModeToLabel(predictedLabel: string): ModelSizeLabel {
    if (predictedLabel === 'no_reasoning') return 'mini';
    if (predictedLabel === 'needs_reasoning') return 'large';
    return 'medium';
  }

  /**
   * 构建 RBF 核相似度矩阵。
   */
  private buildAffinityMatrix(X: number[][]): number[][] {
    const n = X.length;
    const W: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dist = this.squaredDistance(X[i], X[j]);
        const affinity = Math.exp(-dist / (2 * SIGMA * SIGMA));
        W[i][j] = affinity;
        W[j][i] = affinity;
      }
    }

    return W;
  }

  private squaredDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return sum;
  }

  private standardize(X: number[][]): {
    normalized: number[][];
    means: number[];
    stds: number[];
  } {
    const n = X.length;
    const d = X[0].length;
    const means = Array(d).fill(0);
    const stds = Array(d).fill(1);

    for (let f = 0; f < d; f++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += X[i][f];
      means[f] = sum / n;

      let varSum = 0;
      for (let i = 0; i < n; i++) {
        const diff = X[i][f] - means[f];
        varSum += diff * diff;
      }
      stds[f] = Math.sqrt(varSum / n) || 1;
    }

    const normalized = X.map((row) => row.map((v, f) => (v - means[f]) / (stds[f] || 1)));

    return { normalized, means, stds };
  }
}
