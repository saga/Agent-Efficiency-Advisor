// 多模型预测对比 — 同时用所有训练好的模型预测,展示各方案结果
//
// 用法:npm run predict

import { CatBoostModel } from '../ml/CatBoostModel.js';
import { LogisticRegressionModel } from '../ml/LogisticRegressionModel.js';
import { NaiveBayesModel } from '../ml/NaiveBayesModel.js';
import { KnnModel } from '../ml/KnnModel.js';
import type { ModelPrediction, TrainableModel } from '../ml/ModelInterface.js';
import type { ModelSizeFeatures } from '../ml/features.js';

/** CatBoost 适配器 — 让 CatBoostModel 适配 TrainableModel 接口 */
class CatBoostAdapter implements TrainableModel {
  readonly name = 'CatBoost';
  readonly type = 'catboost' as const;
  private model: CatBoostModel;

  constructor(modelPath: string) {
    this.model = new CatBoostModel({ modelPath });
  }

  async train(): Promise<never> {
    throw new Error('Use CatBoostTrainer directly for training');
  }

  async load(): Promise<void> {
    // CatBoostModel 在构造时就准备好了 modelPath,load 是 no-op
  }

  async predict(features: ModelSizeFeatures): Promise<ModelPrediction> {
    return this.model.predict(features);
  }
}

const samples: ModelSizeFeatures[] = [
  // mini-like:简单任务,小 token,少工具
  {
    promptTokens: 2500,
    completionTokens: 600,
    contextTokens: 3100,
    toolCalls: 3,
    readFiles: 3,
    edits: 1,
    retries: 0,
    uniqueFilesRead: 1,
    uniqueFilesEdited: 1,
    elapsedMs: 5000,
    contextUtilization: 0.05,
    readToEditRatio: 3,
    retryRate: 0,
    hasLoop: 0,
    subAgents: 0,
    autoModePredictedLabel: 1,
    autoModeConfidence: 0.7,
  },
  // medium-like:中等复杂度
  {
    promptTokens: 20000,
    completionTokens: 5000,
    contextTokens: 25000,
    toolCalls: 15,
    readFiles: 20,
    edits: 5,
    retries: 1,
    uniqueFilesRead: 8,
    uniqueFilesEdited: 4,
    elapsedMs: 45000,
    contextUtilization: 0.3,
    readToEditRatio: 4,
    retryRate: 0.07,
    hasLoop: 0,
    subAgents: 0,
    autoModePredictedLabel: 1,
    autoModeConfidence: 0.55,
  },
  // large-like:复杂任务,高 token,多工具,有循环
  {
    promptTokens: 70000,
    completionTokens: 25000,
    contextTokens: 95000,
    toolCalls: 45,
    readFiles: 60,
    edits: 12,
    retries: 6,
    uniqueFilesRead: 25,
    uniqueFilesEdited: 10,
    elapsedMs: 150000,
    contextUtilization: 0.8,
    readToEditRatio: 5,
    retryRate: 0.18,
    hasLoop: 1,
    subAgents: 3,
    autoModePredictedLabel: 2,
    autoModeConfidence: 0.85,
  },
];

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Multi-Model Prediction Comparison');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 加载所有模型
  const models: Array<{ name: string; model: TrainableModel; path: string }> = [
    { name: 'Logistic Regression', model: new LogisticRegressionModel(), path: './data/ml/logistic-model.json' },
    { name: 'Naive Bayes', model: new NaiveBayesModel(), path: './data/ml/naivebayes-model.json' },
    { name: 'KNN', model: new KnnModel(), path: './data/ml/knn-model.json' },
    { name: 'CatBoost', model: new CatBoostAdapter('./data/ml/catboost-model.cbm'), path: './data/ml/catboost-model.cbm' },
  ];

  // 加载已训练的模型(跳过不存在的)
  const loaded: Array<{ name: string; model: TrainableModel }> = [];
  for (const { name, model, path } of models) {
    try {
      await model.load(path);
      loaded.push({ name, model });
      console.log(`  loaded: ${name}`);
    } catch {
      console.log(`  skip: ${name} (not trained)`);
    }
  }

  // 对每个样本,用所有模型预测
  for (let i = 0; i < samples.length; i++) {
    console.log(`\n───────── Sample ${i + 1} ─────────`);
    const sample = samples[i];
    console.log(`  promptTokens=${sample.promptTokens}, toolCalls=${sample.toolCalls}, edits=${sample.edits}, retries=${sample.retries}`);
    console.log(`  autoMode: label=${sample.autoModePredictedLabel}, conf=${sample.autoModeConfidence}\n`);

    console.log('  ┌────────────────────────┬──────────┬──────────────┬─────────────────────┐');
    console.log('  │ Model                  │ Label    │ Confidence   │ Probabilities       │');
    console.log('  ├────────────────────────┼──────────┼──────────────┼─────────────────────┤');

    for (const { name, model } of loaded) {
      try {
        const pred = await model.predict(sample);
        const probsStr = pred.probabilities.map((p, idx) => {
          const labels = ['mini', 'medium', 'large'];
          return `${labels[idx]}=${(p * 100).toFixed(1)}%`;
        }).join(' ');
        console.log(`  │ ${name.padEnd(22)} │ ${pred.label.padEnd(8)} │ ${(pred.confidence * 100).toFixed(1).padStart(6)}%      │ ${probsStr.padEnd(19)} │`);
      } catch (err) {
        console.log(`  │ ${name.padEnd(22)} │ ERROR    │              │                     │`);
      }
    }
    console.log('  └────────────────────────┴──────────┴──────────────┴─────────────────────┘');
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
