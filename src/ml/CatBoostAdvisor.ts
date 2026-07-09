import type { Recommendation, SessionState } from '../types.js';
import type { ModelSizeFeatures } from './features.js';
import { extractModelSizeFeatures } from './features.js';
import { CatBoostModel } from './CatBoostModel.js';

export interface CatBoostAdvisorOptions {
  modelPath: string;
  pythonScript?: string;
}

const SAVING_ESTIMATE: Record<string, number> = {
  mini: 60,
  medium: 25,
  large: 0,
};

export class CatBoostAdvisor {
  private model: CatBoostModel;

  constructor(options: CatBoostAdvisorOptions) {
    this.model = new CatBoostModel({ modelPath: options.modelPath, pythonScript: options.pythonScript });
  }

  async recommend(state: SessionState): Promise<Recommendation> {
    const features = extractModelSizeFeatures(state);
    const result = await this.model.predict(features);

    return {
      model: result.label,
      confidence: result.confidence,
      estimatedSavingPercent: SAVING_ESTIMATE[result.label],
      reasons: buildReasons(features, result.label, result.probabilities),
    };
  }

  async recommendFromFeatures(features: ModelSizeFeatures): Promise<Recommendation> {
    const result = await this.model.predict(features);
    return {
      model: result.label,
      confidence: result.confidence,
      estimatedSavingPercent: SAVING_ESTIMATE[result.label],
      reasons: buildReasons(features, result.label, result.probabilities),
    };
  }
}

function buildReasons(features: ModelSizeFeatures, label: string, probs: number[]): string[] {
  const reasons: string[] = [];
  reasons.push(`CatBoost predicts ${label} (prob ${(Math.max(...probs) * 100).toFixed(0)}%)`);
  if (features.promptTokens < 8000) reasons.push(`prompt ${features.promptTokens} tokens`);
  if (features.toolCalls <= 5) reasons.push(`${features.toolCalls} tool calls`);
  if (features.edits <= 2) reasons.push(`${features.edits} files edited`);
  if (features.retries > 0) reasons.push(`${features.retries} retries`);
  if (features.subAgents > 0) reasons.push(`${features.subAgents} sub agents`);
  if (features.contextUtilization > 0.5) reasons.push(`context ${(features.contextUtilization * 100).toFixed(0)}%`);
  return reasons;
}
