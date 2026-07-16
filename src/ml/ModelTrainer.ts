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
import { TorchModel } from './TorchModel.js';
import { ConformalPredictor } from './ConformalPredictor.js';
import { LabelPropagation, type AutoModeSignal } from './LabelPropagation.js';
import { StackingMetaLearner } from './StackingMetaLearner.js';
import { PseudoLabeler } from './PseudoLabeler.js';
import { detectFeatureDrift } from './DriftDetector.js';
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
  pseudoLabels?: {
    totalGenerated: number;
    rounds: number;
    avgConfidence: number;
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
        const trainAcc = (info.accuracy ?? 0).toFixed(3);
        const cvAcc = info.cvAccuracy !== undefined && info.cvAccuracy !== null
          ? info.cvAccuracy.toFixed(3)
          : 'n/a';
        console.log(`  ✓ ${info.modelName}: train=${trainAcc}, cv=${cvAcc}, samples=${info.trainSamples}`);
      } catch (err) {
        console.error(`  ✗ ${model.name} failed: ${err}`);
      }
    }

    // 4. 训练 CatBoost(通过适配器,Python 子进程)
    try {
      const catboostInfo = await this.trainCatBoost(samples, outDir);
      trainResults.push(catboostInfo);
      const trainAcc = catboostInfo.accuracy !== undefined ? (catboostInfo.accuracy * 100).toFixed(1) + '%' : 'n/a';
      const cvAcc = catboostInfo.cvAccuracy !== undefined && catboostInfo.cvAccuracy !== null
        ? (catboostInfo.cvAccuracy * 100).toFixed(1) + '%'
        : 'n/a';
      console.log(`  ✓ ${catboostInfo.modelName}: train=${trainAcc}, cv=${cvAcc}, samples=${catboostInfo.trainSamples}`);
    } catch (err) {
      console.error(`  ✗ CatBoost failed: ${err}`);
    }

    // 5. Pseudo-labeling — 用已训练模型为低置信标签生成伪标签
    let pseudoLabelInfo: MultiModelTrainResult['pseudoLabels'] = undefined;
    const pseudoCandidates = samples.filter(
      (s) => s.sessionId.startsWith('heuristic:') || s.sessionId.startsWith('unlabeled:'),
    );

    if (pseudoCandidates.length > 0 && trainResults.length > 0) {
      console.log('\n───────── Pseudo-labeling ─────────\n');
      try {
        const pseudoModel = new LogisticRegressionModel(500, 0.01, 0.01);
        const labeler = new PseudoLabeler(pseudoModel, {
          confidenceThreshold: 0.80,
          maxRounds: 2,
          maxPseudoPerRound: 30,
        });
        const labeledSamples = samples.filter(
          (s) => !s.sessionId.startsWith('heuristic:') && !s.sessionId.startsWith('unlabeled:'),
        );
        const pseudoResult = await labeler.generate(
          labeledSamples,
          pseudoCandidates,
          path.join(outDir, 'pseudo-model.json'),
        );

        if (pseudoResult.pseudoLabels.length > 0) {
          // 将伪标签样本加入训练集
          const pseudoSamples = pseudoResult.samples.filter(
            (s) => s.sessionId.startsWith('pseudo:'),
          );
          samples = [...samples, ...pseudoSamples];

          const avgConf = pseudoResult.pseudoLabels.reduce((s, p) => s + p.confidence, 0)
            / pseudoResult.pseudoLabels.length;
          pseudoLabelInfo = {
            totalGenerated: pseudoResult.pseudoLabels.length,
            rounds: pseudoResult.rounds.length,
            avgConfidence: avgConf,
          };
          console.log(`  Generated ${pseudoResult.pseudoLabels.length} pseudo-label(s) in ${pseudoResult.rounds.length} round(s)`);
          console.log(`  Average confidence: ${avgConf.toFixed(3)}`);
          for (const r of pseudoResult.rounds) {
            console.log(`    Round ${r.round}: ${r.pseudoCount} labels, avg conf=${r.avgConfidence.toFixed(3)}`);
          }
        }
      } catch (err) {
        console.error(`  Pseudo-labeling failed: ${err}`);
      }
    }

    // 6. 训练 Stacking Meta Learner（在线 LR + KNN + NB → Meta LR）
    try {
      const stackingInfo = await this.trainStacking(samples, outDir);
      trainResults.push(stackingInfo);
      console.log(`  ✓ ${stackingInfo.modelName}: accuracy=${(stackingInfo.accuracy ?? 0).toFixed(3)}, samples=${stackingInfo.trainSamples}`);
    } catch (err) {
      console.error(`  ✗ Stacking Meta Learner failed: ${err}`);
    }

    // 7. Drift Detection — compare current features vs previous training baseline
    this.checkDrift(samples, outDir);

    return {
      models: trainResults,
      totalSamples: samples.length,
      realSamples,
      syntheticSamples: samples.length - realSamples,
      labelPropagation: labelPropInfo,
      pseudoLabels: pseudoLabelInfo,
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
      new TorchModel(),
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
      accuracy: result.accuracy,
      cvAccuracy: result.cvAccuracy,
      cvFolds: result.cvFolds,
      featureImportance: result.featureImportance,
    };
  }

  /**
   * Drift Detection — compare current training features vs previous baseline.
   * Saves current features as new baseline for next training run.
   */
  private checkDrift(samples: TrainingSample[], outDir: string): void {
    const baselinePath = path.join(outDir, 'drift-baseline.json');
    const currentFeatures = samples.map((s) => s.features);

    // Load previous baseline if it exists
    if (fs.existsSync(baselinePath)) {
      try {
        const raw = fs.readFileSync(baselinePath, 'utf-8');
        const baselineFeatures = JSON.parse(raw) as ModelSizeFeatures[];
        if (baselineFeatures.length > 0) {
          const report = detectFeatureDrift(baselineFeatures, currentFeatures);
          console.log('\n───────── Drift Detection ─────────');
          console.log(`  Baseline: ${baselineFeatures.length} samples | Current: ${currentFeatures.length} samples`);
          console.log(`  Max PSI: ${report.maxPsi.toFixed(4)} | Avg PSI: ${report.avgPsi.toFixed(4)}`);
          console.log(`  Recommendation: ${report.recommendation}`);
          if (report.driftedFeatures.length > 0) {
            console.log(`  Drifted features (${report.driftedFeatures.length}):`);
            const top = report.results
              .filter((r) => r.drifted)
              .sort((a, b) => b.psi - a.psi)
              .slice(0, 5);
            for (const r of top) {
              console.log(`    ${r.feature}: PSI=${r.psi.toFixed(4)}`);
            }
          } else {
            console.log('  No significant drift detected.');
          }
        }
      } catch {
        // Baseline file corrupted, skip drift detection
      }
    }

    // Save current features as new baseline
    fs.writeFileSync(baselinePath, JSON.stringify(currentFeatures));
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
