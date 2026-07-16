// 统一模型接口 — 所有分类器实现此接口,便于训练时统一调度和预测时切换。
//
// 设计原则:
// - 纯 TS 模型实现 train() 和 predict(),持久化用 JSON
// - CatBoost 仍走 Python 子进程,但通过适配器实现同接口
// - 预测输出统一为 ModelPrediction(含概率分布和置信度)

import type { ModelSizeFeatures, ModelSizeLabel } from './features.js';

export interface ModelPrediction {
  label: ModelSizeLabel;
  classIndex: number;
  probabilities: number[];
  /** 校准后的置信度(0-1),top-1 概率 */
  confidence: number;
  /** Conformal 预测的 p-value(可选) */
  pValue?: number;
  /** 是否拒绝预测(置信度不足) */
  rejected?: boolean;
}

export interface TrainedModelInfo {
  modelName: string;
  modelType: ModelType;
  modelPath: string;
  trainSamples: number;
  accuracy?: number;
  featureImportance?: Record<string, number>;
}

export type ModelType = 'catboost' | 'logistic' | 'naivebayes' | 'knn' | 'conformal' | 'torch';

/**
 * 可训练的模型接口 — 所有分类器实现此接口。
 */
export interface TrainableModel {
  readonly name: string;
  readonly type: ModelType;
  /** 训练模型并持久化到 modelPath */
  train(samples: TrainingSample[], modelPath: string): Promise<TrainedModelInfo>;
  /** 从文件加载模型 */
  load(modelPath: string): Promise<void>;
  /** 预测单个样本 */
  predict(features: ModelSizeFeatures): Promise<ModelPrediction>;
}

export interface TrainingSample {
  features: ModelSizeFeatures;
  label: ModelSizeLabel;
  sessionId: string;
}

// 复用 features.ts 的常量
export { FEATURE_COLUMNS, LABEL_INDEX, INDEX_LABEL } from './features.js';
export type { ModelSizeFeatures, ModelSizeLabel } from './features.js';
