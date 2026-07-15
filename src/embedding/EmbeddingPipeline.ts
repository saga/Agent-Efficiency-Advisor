// EmbeddingPipeline — v7.md #3: Plugin 化的 Embedding 编排器。
// Pipeline 不再硬编码 feature-v1 逻辑，而是通过 EmbeddingProvider 接口委托。
//
// 以后增加 text-embedding-3-small / nomic / bge-m3：
//   const pipeline = new EmbeddingPipeline(...);
//   pipeline.registerProvider(new OpenAIEmbeddingProvider());
//   pipeline.registerProvider(new NomicEmbeddingProvider());
// 不用修改 Pipeline 任何代码。

import type { EventStore } from '../store/EventStore.js';
import type { FeatureStore } from '../store/FeatureStore.js';
import type { EmbeddingStore } from './EmbeddingStore.js';
import type { EmbeddingProvider } from './EmbeddingProvider.js';
import { FeatureEmbeddingProvider } from './FeatureEmbeddingProvider.js';

export class EmbeddingPipeline {
  // v7.md #3: Provider 注册表，支持多个 Provider 共存。
  private providers = new Map<string, EmbeddingProvider>();

  constructor(
    private eventStore: EventStore,
    private featureStore: FeatureStore,
    private embeddingStore: EmbeddingStore
  ) {
    // 默认注册 feature-v1 Provider（零 API 成本，离线可运行）
    this.registerProvider(new FeatureEmbeddingProvider());
  }

  /**
   * 注册一个 EmbeddingProvider。v7.md #3: 允许多个 Provider 共存。
   */
  registerProvider(provider: EmbeddingProvider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * 获取已注册的 Provider 列表。
   */
  getProviders(): EmbeddingProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Generate and persist a session embedding using the specified provider
   * (defaults to the first registered provider).
   */
  generateSessionEmbedding(sessionId: string, providerId?: string): number[] | undefined {
    const behavior = this.featureStore.read('behavior', sessionId);
    const session = this.featureStore.read('session', sessionId);
    if (!behavior) return undefined;

    const merged: Record<string, number> = { ...behavior.features };
    if (session) Object.assign(merged, session.features);

    const provider = this.resolveProvider(providerId);
    if (!provider) return undefined;

    const vec = provider.generateSession(merged);
    const arr = Array.from(vec);
    this.embeddingStore.write(sessionId, 'session', provider.id, arr);
    return arr;
  }

  /**
   * Generate and persist a prompt embedding.
   */
  generatePromptEmbedding(promptId: string, providerId?: string): number[] | undefined {
    const prompt = this.featureStore.read('prompt', promptId);
    if (!prompt) return undefined;

    const provider = this.resolveProvider(providerId);
    if (!provider) return undefined;

    const vec = provider.generatePrompt(prompt.features);
    const arr = Array.from(vec);
    this.embeddingStore.write(promptId, 'prompt', provider.id, arr);
    return arr;
  }

  /**
   * Generate embeddings for all sessions and prompts using all registered providers.
   */
  computeAll(): { sessions: number; prompts: number } {
    const sessionIds = this.eventStore.getSessionIds();
    let sessions = 0, prompts = 0;

    for (const sid of sessionIds) {
      // Use the first provider for each entity (feature-v1 by default)
      if (this.generateSessionEmbedding(sid)) sessions++;

      const events = this.eventStore.getBySession(sid).filter((e) => e.eventType === 'chat');
      const promptIds = new Set<string>();
      for (const e of events) {
        const pid = String(e.metadata.promptId ?? '');
        if (pid) promptIds.add(pid);
      }
      for (const pid of promptIds) {
        if (this.generatePromptEmbedding(pid)) prompts++;
      }
    }

    return { sessions, prompts };
  }

  /**
   * Find similar sessions to a query session.
   */
  findSimilarSessions(sessionId: string, topK = 5, providerId?: string): { entityId: string; similarity: number }[] {
    const provider = this.resolveProvider(providerId);
    if (!provider) return [];
    const query = this.embeddingStore.read(sessionId, 'session', provider.id);
    if (!query) return [];
    const results = this.embeddingStore.search(query.vector, 'session', topK + 1, provider.id);
    return results.filter((r) => r.entityId !== sessionId).slice(0, topK);
  }

  private resolveProvider(providerId?: string): EmbeddingProvider | undefined {
    if (providerId) return this.providers.get(providerId);
    // Default: first registered provider (feature-v1)
    return this.providers.values().next().value;
  }
}
