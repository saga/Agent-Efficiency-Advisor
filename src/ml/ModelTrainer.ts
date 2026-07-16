// ModelTrainer — 统一训练所有模型方案
//
// 训练流程:
// 1. 加载真实数据(aea-real.db)+ 合成数据(如不足)
// 2. 用 LabelPropagation 增强标签(如果有 autoModeResolution 信号)
// 3. 同时训练 CatBoost / LR / NB / KNN 四个模型
// 4. 用 ConformalPredictor 包裹每个模型
// 5. 输出训练报告(准确率 + 特征重要性对比)

import fs from 'node:fs';
import path from 'node:path';
import type { TrainableModel, TrainedModelInfo } from './ModelInterface.js';
import { TrainingSample } from './dataset.js';
import { CatBoostTrainer } from './CatBoostTrainer.js';
import { LogisticRegressionModel } from './LogisticRegressionModel.js';
import { NaiveBayesModel } from './NaiveBayesModel.js';
import { KnnModel } from './KnnModel.js';
import { ConformalPredictor } from './ConformalPredictor.js';
import { LabelPropagation, type AutoModeSignal } from './LabelPropagation.js';
import { StackingMetaLearner } from './StackingMetaLearner.js';
import type { ModelSizeFeatures } from './features.js';

export interface MultiModelTrainResult {
  models: TrainedModelInfo[];
  totalSamples: number;
  realSamples: number;
  syntheticSamples: number;
  labelPropagation?: {
    iterations: number;
    converged: boolean;
    autoModeAnchors: number;
  };
}

export interface TrainAllOptions {
  samples: TrainingSample[];
  realSamples: number;
  outDir: string;
  /** autoModeResolution 信号,用于标签传播 */
  autoModeSignals?: Map<string, AutoModeSignal>;
  /** 是否启用标签传播 */
  enableLabelPropagation?: boolean;
}

export class ModelTrainer {
  /**
   * 训练所有模型方案,返回每个模型的训练信息。
   */
  async trainAll(options: TrainAllOptions): Promise<MultiModelTrainResult> {
    const { samples: originalSamples, realSamples, outDir, autoModeSignals } = options;
    fs.mkdirSync(outDir, { recursive: true });

    // 1. 标签传播(可选)
    let samples = originalSamples;
    let labelPropInfo: MultiModelTrainResult['labelPropagation'] = undefined;

    if (options.enableLabelPropagation && autoModeSignals && autoModeSignals.size > 0) {
      const labelProp = new LabelPropagation();
      const result = labelProp.propagate(originalSamples, {
        autoModeSignals,
        replaceLabels: false, // 只增强,不替换(保留原标签用于对比)
      });
      // 用传播后的软标签更新 sample 标签(仅对 autoMode 锚点和高置信传播结果)
      samples = result.samples.map((s, i) => {
        if (result.labelSources[i] === 'autoMode') {
          // autoMode 锚点:直接用映射后的标签
          const probs = result.labelProbabilities[i];
          const maxIdx = probs.indexOf(Math.max(...probs));
          const labels: ModelSizeLabel[] = ['mini', 'medium', 'large'];
          return { ...s, label: labels[maxIdx] };
        }
        return s;
      });
      labelPropInfo = {
        iterations: result.iterations,
        converged: result.converged,
        autoModeAnchors: result.labelSources.filter((s) => s === 'autoMode').length,
      };
    }

    // 2. 准备所有模型
    const models = this.createModels();

    // 3. 并行训练所有模型
    const trainResults: TrainedModelInfo[] = [];

    for (const model of models) {
      const modelPath = path.join(outDir, `${model.type}-model.json`);
      try {
        const info = await model.train(samples, modelPath);
        trainResults.push(info);
        console.log(`  ✓ ${info.modelName}: accuracy=${(info.accuracy ?? 0).toFixed(3)}, samples=${info.trainSamples}`);
      } catch (err) {
        console.error(`  ✗ ${model.name} failed: ${err}`);
      }
    }

    // 4. 训练 CatBoost(通过适配器,Python 子进程)
    try {
      const catboostInfo = await this.trainCatBoost(samples, outDir);
      trainResults.push(catboostInfo);
      console.log(`  ✓ ${catboostInfo.modelName}: trees=${(catboostInfo as any).iterations ?? 'n/a'}, samples=${catboostInfo.trainSamples}`);
    } catch (err) {
      console.error(`  ✗ CatBoost failed: ${err}`);
    }

    // 5. 训练 Stacking Meta Learner（在线 LR + KNN + NB → Meta LR）
    try {
      const stackingInfo = await this.trainStacking(samples, outDir);
      trainResults.push(stackingInfo);
      console.log(`  ✓ ${stackingInfo.modelName}: accuracy=${(stackingInfo.accuracy ?? 0).toFixed(3)}, samples=${stackingInfo.trainSamples}`);
    } catch (err) {
      console.error(`  ✗ Stacking Meta Learner failed: ${err}`);
    }

    return {
      models: trainResults,
      totalSamples: samples.length,
      realSamples,
      syntheticSamples: samples.length - realSamples,
      labelPropagation: labelPropInfo,
    };
  }

  /**
   * 创建所有纯 TS 模型实例。
   */
  private createModels(): TrainableModel[] {
    return [
      new LogisticRegressionModel(500, 0.01, 0.01),
      new NaiveBayesModel(),
      new KnnModel(),
    ];
  }

  /**
   * 训练 CatBoost(通过现有 CatBoostTrainer,Python 子进程)。
   */
  private async trainCatBoost(
    samples: TrainingSample[],
    outDir: string,
  ): Promise<TrainedModelInfo> {
    const trainer = new CatBoostTrainer();
    const modelOut = path.join(outDir, 'catboost-model.cbm');
    const featureImportanceOut = path.join(outDir, 'catboost-feature-importance.json');

    const result = await trainer.train({
      samples,
      outDir,
      modelOut,
      featureImportanceOut,
      iterations: 200,
      depth: 6,
      learningRate: 0.1,
    });

    return {
      modelName: 'CatBoost',
      modelType: 'catboost',
      modelPath: result.modelOut,
      trainSamples: samples.length,
      featureImportance: result.featureImportance,
    };
  }

  /**
   * 训练 Stacking Meta Learner（Online LR + KNN + NB → Meta LR）。
   * Base models 使用交叉验证生成 out-of-fold 预测作为 meta features。
   */
  private async trainStacking(
    samples: TrainingSample[],
    outDir: string,
  ): Promise<TrainedModelInfo> {
    const stacker = new StackingMetaLearner(outDir);
    const modelPath = path.join(outDir, 'stacking-model.json');
    const info = await stacker.train(samples, modelPath);
    return info;
  }
}

// 需要导入 ModelSizeLabel 类型用于标签传播
import type { ModelSizeLabel } from './features.js';
