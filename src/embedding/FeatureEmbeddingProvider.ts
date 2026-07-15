// FeatureEmbeddingProvider — 基于 Feature 的 EmbeddingProvider 实现。
// v7.md #3: 这是 feature-v1 Provider，将结构化特征转为归一化向量。
// 离线可运行、零 API 成本、可随时重建。
//
// 以后增加 text-embedding-3-small / nomic / bge-m3 只需实现 EmbeddingProvider 接口，
// 不用修改 EmbeddingPipeline。

import type { EmbeddingProvider } from './EmbeddingProvider.js';
import { normalize } from './EmbeddingStore.js';

// Canonical feature ordering for session embeddings (behavior + session).
const SESSION_VECTOR_KEYS = [
  'workflowEntropy',
  'retryBurstScore',
  'toolSwitchFrequency',
  'editAfterAcceptRatio',
  'avgReadBeforeAsk',
  'avgRetryDistance',
  'contextExpansionSpeed',
  'workflowLength',
  'acceptRate',
  'retryRate',
] as const;

// Indices that need log-scaling (count-like features with large range).
const SESSION_LOG_INDICES = new Set([4, 5, 6, 7, 9]);

// Canonical feature ordering for prompt embeddings.
const PROMPT_VECTOR_KEYS = [
  'promptDensity',
  'historyRatio',
  'tokenCount',
  'retrievedFiles',
  'retrievedSymbols',
] as const;

const PROMPT_LOG_INDICES = new Set([2, 3, 4]);

export class FeatureEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'feature-v1';
  readonly supportedEntities = ['session', 'prompt'] as const;

  generateSession(features: Record<string, number>): Float32Array {
    const vec = SESSION_VECTOR_KEYS.map((key, idx) => {
      const val = features[key] ?? 0;
      if (SESSION_LOG_INDICES.has(idx)) {
        return val > 0 ? Math.log1p(val) : 0;
      }
      return val;
    });
    return new Float32Array(normalize(vec));
  }

  generatePrompt(features: Record<string, number>): Float32Array {
    const vec = PROMPT_VECTOR_KEYS.map((key, idx) => {
      const val = features[key] ?? 0;
      if (PROMPT_LOG_INDICES.has(idx)) {
        return val > 0 ? Math.log1p(val) : 0;
      }
      return val;
    });
    return new Float32Array(normalize(vec));
  }
}
