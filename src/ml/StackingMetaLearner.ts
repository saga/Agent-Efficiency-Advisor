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

const NUM_CLASSES = 3;
const NUM_BASE_MODELS = 3;

interface MetaModelData {
  metaWeights: number[][];
  metaBiases: number[];
  baseModelPaths: string[];
  metaAccuracy: number;
  samplesSeen: number;
}

export class StackingMetaLearner implements TrainableModel {
  readonly name = 'Stacking Meta Learner';
  readonly type = 'logistic' as const;

  private metaWeights: number[][] = [];
  private metaBiases: number[] = [0, 0, 0];
  private baseModels: TrainableModel[] = [];
  private baseModelPaths: string[] = [];
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

    // Train meta-model on out-of-fold predictions
    this.trainMetaModel(metaFeatures, metaLabels);
    this.samplesSeen = samples.length;
    this.trained = true;

    // Compute meta accuracy
    let correct = 0;
    for (let i = 0; i < metaFeatures.length; i++) {
      const probs = this.metaForward(metaFeatures[i]);
      const pred = probs.indexOf(Math.max(...probs));
      if (pred === metaLabels[i]) correct++;
    }
    this.metaAccuracy = metaFeatures.length > 0 ? correct / metaFeatures.length : 0;

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

    // Meta-model prediction
    const probs = this.metaForward(metaInput);
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

    const probs = this.metaForward(metaInput);
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
