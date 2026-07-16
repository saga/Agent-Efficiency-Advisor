// StackingMetaLearner — combine base model predictions via a meta logistic regression.
//
// Instead of hard-switching between KNN/LR/NB based on sample count, the
// meta-learner automatically learns which base model to trust in different
// regions of feature space.
//
// Architecture:
//   Base models: [OnlineLR, KNN, NaiveBayes] → each outputs P(class|features)
//   Meta features: concatenation of base model probabilities (9 dims for 3 classes)
//   Meta model: softmax regression on meta features → final P(class|features)
//
// Training: use cross-validation to generate out-of-fold base model predictions
// as meta-features, then train meta-model on those.

import fs from 'node:fs';
import type { ModelPrediction, TrainableModel, TrainedModelInfo } from './ModelInterface.js';
import type { TrainingSample } from './dataset.js';
import type { ModelSizeFeatures, ModelSizeLabel } from './features.js';
import { FEATURE_COLUMNS, INDEX_LABEL, LABEL_INDEX } from './features.js';
import { OnlineLogisticRegression } from './OnlineLogisticRegression.js';
import { KnnModel } from './KnnModel.js';
import { NaiveBayesModel } from './NaiveBayesModel.js';
import { TemperatureScaler } from './TemperatureScaler.js';

const NUM_CLASSES = 3;
const NUM_BASE_MODELS = 3;

interface MetaModelData {
  metaWeights: number[][];
  metaBiases: number[];
  baseModelPaths: string[];
  metaAccuracy: number;
  samplesSeen: number;
  /** 每个基础模型的温度参数（Temperature Scaling 校准） */
  temperatures: number[];
}

export class StackingMetaLearner implements TrainableModel {
  readonly name = 'Stacking Meta Learner';
  readonly type = 'logistic' as const;

  private metaWeights: number[][] = [];
  private metaBiases: number[] = [0, 0, 0];
  private baseModels: TrainableModel[] = [];
  private baseModelPaths: string[] = [];
  private temperatures: number[] = [1.0, 1.0, 1.0];
  private metaAccuracy = 0;
  private samplesSeen = 0;
  private trained = false;

  constructor(
    private modelDir: string = './data/ml',
  ) {
    this.baseModels = [
      new OnlineLogisticRegression(0.1, 0.001),
      new KnnModel(),
      new NaiveBayesModel(),
    ];
    this.baseModelPaths = [
      `${modelDir}/online_lr.json`,
      `${modelDir}/knn.json`,
      `${modelDir}/nb.json`,
    ];
    this.metaWeights = Array.from({ length: NUM_CLASSES }, () =>
      Array(NUM_CLASSES * NUM_BASE_MODELS).fill(0),
    );
  }

  async train(samples: TrainingSample[], modelPath: string): Promise<TrainedModelInfo> {
    if (samples.length === 0) throw new Error('No training samples');

    // K-fold cross-validation for out-of-fold predictions
    const k = Math.min(5, samples.length);
    const folds = this.createFolds(samples, k);

    // Generate meta-features via cross-validation
    const metaFeatures: number[][] = [];
    const metaLabels: number[] = [];

    for (let foldIdx = 0; foldIdx < k; foldIdx++) {
      const trainSamples = folds.filter((_, i) => i !== foldIdx).flat();
      const valSamples = folds[foldIdx];

      if (trainSamples.length === 0 || valSamples.length === 0) continue;

      // Train base models on this fold's training set
      const foldBaseModels = [
        new OnlineLogisticRegression(0.1, 0.001),
        new KnnModel(),
        new NaiveBayesModel(),
      ];

      for (const model of foldBaseModels) {
        await model.train(trainSamples, `${this.modelDir}/_tmp_${model.type}.json`);
      }

      // Generate predictions on validation set
      for (const sample of valSamples) {
        const probs: number[] = [];
        for (const model of foldBaseModels) {
          const pred = await model.predict(sample.features);
          probs.push(...pred.probabilities);
        }
        metaFeatures.push(probs);
        metaLabels.push(LABEL_INDEX[sample.label]);
      }
    }

    // Train base models on full dataset
    for (let i = 0; i < this.baseModels.length; i++) {
      await this.baseModels[i].train(samples, this.baseModelPaths[i]);
    }

    // Temperature Scaling — 学习每个 base model 的温度参数
    // 用 out-of-fold 预测的 logits 反推，在 metaLabels 上优化 NLL
    this.temperatures = this.learnTemperatures(metaFeatures, metaLabels);

    // 应用温度校准到 meta-features
    const calibratedMetaFeatures = metaFeatures.map((mf) => this.applyTemperature(mf));

    // Train meta-model on calibrated out-of-fold predictions
    this.trainMetaModel(calibratedMetaFeatures, metaLabels);
    this.samplesSeen = samples.length;
    this.trained = true;

    // Compute meta accuracy
    let correct = 0;
    for (let i = 0; i < calibratedMetaFeatures.length; i++) {
      const probs = this.metaForward(calibratedMetaFeatures[i]);
      const pred = probs.indexOf(Math.max(...probs));
      if (pred === metaLabels[i]) correct++;
    }
    this.metaAccuracy = calibratedMetaFeatures.length > 0 ? correct / calibratedMetaFeatures.length : 0;

    // Save
    this.save(modelPath);

    return {
      modelName: this.name,
      modelType: this.type,
      modelPath,
      trainSamples: samples.length,
      accuracy: this.metaAccuracy,
    };
  }

  async load(modelPath: string): Promise<void> {
    const raw = fs.readFileSync(modelPath, 'utf-8');
    const data = JSON.parse(raw) as MetaModelData;
    this.metaWeights = data.metaWeights;
    this.metaBiases = data.metaBiases;
    this.baseModelPaths = data.baseModelPaths;
    this.metaAccuracy = data.metaAccuracy;
    this.samplesSeen = data.samplesSeen;
    this.temperatures = data.temperatures ?? [1.0, 1.0, 1.0];
    this.trained = true;

    // Load base models
    for (let i = 0; i < this.baseModels.length; i++) {
      if (fs.existsSync(this.baseModelPaths[i])) {
        await this.baseModels[i].load(this.baseModelPaths[i]);
      }
    }
  }

  save(modelPath: string): void {
    const data: MetaModelData = {
      metaWeights: this.metaWeights,
      metaBiases: this.metaBiases,
      baseModelPaths: this.baseModelPaths,
      metaAccuracy: this.metaAccuracy,
      samplesSeen: this.samplesSeen,
      temperatures: this.temperatures,
    };
    fs.writeFileSync(modelPath, JSON.stringify(data), 'utf-8');
  }

  async predict(features: ModelSizeFeatures): Promise<ModelPrediction> {
    // Get base model predictions
    const metaInput: number[] = [];
    for (const model of this.baseModels) {
      try {
        const pred = await model.predict(features);
        metaInput.push(...pred.probabilities);
      } catch {
        // If a base model fails, use uniform distribution
        metaInput.push(1 / NUM_CLASSES, 1 / NUM_CLASSES, 1 / NUM_CLASSES);
      }
    }

    // Apply temperature scaling to base model predictions
    const calibratedInput = this.applyTemperature(metaInput);

    // Meta-model prediction
    const probs = this.metaForward(calibratedInput);
    const classIndex = probs.indexOf(Math.max(...probs));
    return {
      label: INDEX_LABEL[classIndex],
      classIndex,
      probabilities: probs,
      confidence: probs[classIndex],
    };
  }

  /**
   * Get individual base model predictions for debugging/analysis.
   */
  async predictWithDetails(features: ModelSizeFeatures): Promise<{
    final: ModelPrediction;
    baseModels: Array<{ name: string; prediction: ModelPrediction }>;
  }> {
    const basePredictions: Array<{ name: string; prediction: ModelPrediction }> = [];
    const metaInput: number[] = [];

    for (const model of this.baseModels) {
      try {
        const pred = await model.predict(features);
        metaInput.push(...pred.probabilities);
        basePredictions.push({ name: model.name, prediction: pred });
      } catch {
        const uniform = [1 / NUM_CLASSES, 1 / NUM_CLASSES, 1 / NUM_CLASSES];
        metaInput.push(...uniform);
        basePredictions.push({
          name: model.name,
          prediction: {
            label: 'medium',
            classIndex: 1,
            probabilities: uniform,
            confidence: 1 / NUM_CLASSES,
          },
        });
      }
    }

    const calibratedInput = this.applyTemperature(metaInput);
    const probs = this.metaForward(calibratedInput);
    const classIndex = probs.indexOf(Math.max(...probs));
    const final: ModelPrediction = {
      label: INDEX_LABEL[classIndex],
      classIndex,
      probabilities: probs,
      confidence: probs[classIndex],
    };

    return { final, baseModels: basePredictions };
  }

  private trainMetaModel(metaFeatures: number[][], metaLabels: number[]): void {
    const numMetaFeatures = NUM_CLASSES * NUM_BASE_MODELS;
    this.metaWeights = Array.from({ length: NUM_CLASSES }, () =>
      Array(numMetaFeatures).fill(0),
    );
    this.metaBiases = [0, 0, 0];

    const lr = 0.1;
    const l2 = 0.01;
    const iterations = 500;

    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < metaFeatures.length; i++) {
        const logits = this.metaForward(metaFeatures[i]);
        const grad = logits.map((p, c) => p - (metaLabels[i] === c ? 1 : 0));

        for (let c = 0; c < NUM_CLASSES; c++) {
          for (let f = 0; f < numMetaFeatures; f++) {
            this.metaWeights[c][f] -= lr * (grad[c] * metaFeatures[i][f] + l2 * this.metaWeights[c][f]);
          }
          this.metaBiases[c] -= lr * grad[c];
        }
      }
    }
  }

  private metaForward(x: number[]): number[] {
    const logits = this.metaBiases.map((b, c) =>
      b + this.metaWeights[c].reduce((sum, w, f) => sum + w * x[f], 0),
    );
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  }

  /**
   * 学习每个 base model 的温度参数。
   * meta-features 是 [model1_p0, model1_p1, model1_p2, model2_p0, ...] 的拼接，
   * 对每个 base model 的 3 个概率反推 logits，优化温度 T 使 NLL 最小。
   */
  private learnTemperatures(metaFeatures: number[][], metaLabels: number[]): number[] {
    const temperatures: number[] = [];

    for (let m = 0; m < NUM_BASE_MODELS; m++) {
      const start = m * NUM_CLASSES;
      // 收集该 base model 的 logits 和真实标签
      const logits: number[][] = [];
      const labels: number[] = [];

      for (let i = 0; i < metaFeatures.length; i++) {
        const probs = metaFeatures[i].slice(start, start + NUM_CLASSES);
        logits.push(probs.map((p) => Math.log(p + 1e-10)));
        labels.push(metaLabels[i]);
      }

      // 优化温度
      let T = 1.0;
      const lr = 0.05;
      const maxIter = 200;

      for (let iter = 0; iter < maxIter; iter++) {
        let gradient = 0;
        for (let i = 0; i < logits.length; i++) {
          const scaledLogits = logits[i].map((l) => l / T);
          const probs = this.softmax(scaledLogits);
          let sumPLogit = 0;
          for (let c = 0; c < NUM_CLASSES; c++) {
            sumPLogit += probs[c] * logits[i][c];
          }
          gradient += (sumPLogit - logits[i][labels[i]]) / (T * T);
        }
        gradient /= logits.length;
        T = T * Math.exp(-lr * gradient);
        T = Math.max(0.1, Math.min(T, 10.0));
      }

      temperatures.push(T);
    }

    return temperatures;
  }

  /**
   * 对 meta-features 应用温度校准。
   * 每个 base model 的概率分布独立校准。
   */
  private applyTemperature(metaInput: number[]): number[] {
    const calibrated: number[] = [];
    for (let m = 0; m < NUM_BASE_MODELS; m++) {
      const start = m * NUM_CLASSES;
      const probs = metaInput.slice(start, start + NUM_CLASSES);
      const T = this.temperatures[m] ?? 1.0;
      const logits = probs.map((p) => Math.log(p + 1e-10));
      const scaledLogits = logits.map((l) => l / T);
      const calibratedProbs = this.softmax(scaledLogits);
      calibrated.push(...calibratedProbs);
    }
    return calibrated;
  }

  private softmax(logits: number[]): number[] {
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  }

  private createFolds(samples: TrainingSample[], k: number): TrainingSample[][] {
    const shuffled = [...samples].sort(() => Math.random() - 0.5);
    const foldSize = Math.ceil(shuffled.length / k);
    const folds: TrainingSample[][] = [];
    for (let i = 0; i < k; i++) {
      folds.push(shuffled.slice(i * foldSize, (i + 1) * foldSize));
    }
    return folds;
  }
}
