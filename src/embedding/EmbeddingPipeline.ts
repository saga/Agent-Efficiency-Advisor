// EmbeddingPipeline — generate feature-based embeddings for sessions and prompts.
// v6.md Section 4: embeddings for Prompt, Session, Workflow, Error, Workspace Snapshot.
//
// Design: feature-based embedding (model='feature-v1') converts structured features
// into a normalized vector. This works offline and captures behavioral similarity.
// If OPENAI_API_KEY is set, an optional API-based text embedding can be added later.

import type { EventStore } from '../store/EventStore.js';
import type { FeatureStore } from '../store/FeatureStore.js';
import type { EmbeddingStore } from './EmbeddingStore.js';
import { normalize } from './EmbeddingStore.js';

const MODEL = 'feature-v1';

// Canonical feature ordering for session embeddings (behavior + session).
// These 10 dimensions form the "behavioral fingerprint" of a session.
const SESSION_VECTOR_KEYS = [
  'workflowEntropy',       // 0..1 — workflow regularity
  'retryBurstScore',       // 0..1 — retry clustering
  'toolSwitchFrequency',   // 0..1 — tool churn
  'editAfterAcceptRatio',  // 0..1 — post-accept editing
  'avgReadBeforeAsk',      // 0..N — context gathering (log-scaled)
  'avgRetryDistance',      // 0..N — retry spacing (log-scaled)
  'contextExpansionSpeed', // 0..N — token growth (log-scaled)
  'workflowLength',        // 1..N — session length (log-scaled)
  'acceptRate',            // 0..1 — completion quality
  'retryRate',             // 0..N — retry frequency (log-scaled)
] as const;

// Canonical feature ordering for prompt embeddings.
const PROMPT_VECTOR_KEYS = [
  'promptDensity',    // 0..1
  'historyRatio',     // 0..1
  'tokenCount',       // log-scaled
  'retrievedFiles',   // log-scaled
  'retrievedSymbols', // log-scaled
] as const;

export class EmbeddingPipeline {
  constructor(
    private eventStore: EventStore,
    private featureStore: FeatureStore,
    private embeddingStore: EmbeddingStore
  ) {}

  /**
   * Generate and persist a session embedding from behavior + session features.
   * Returns the vector, or undefined if no features found.
   */
  generateSessionEmbedding(sessionId: string): number[] | undefined {
    const behavior = this.featureStore.read('behavior', sessionId);
    const session = this.featureStore.read('session', sessionId);
    if (!behavior) return undefined;

    // Merge behavior + session features
    const merged: Record<string, number> = { ...behavior.features };
    if (session) Object.assign(merged, session.features);

    // Build vector with log-scaling for large-range features
    const vec = SESSION_VECTOR_KEYS.map((key) => {
      const val = merged[key] ?? 0;
      // Log-scale count-like features (indices 4..7, 9)
      const idx = SESSION_VECTOR_KEYS.indexOf(key);
      if ([4, 5, 6, 7, 9].includes(idx)) {
        return val > 0 ? Math.log1p(val) : 0;
      }
      return val;
    });

    const normalized = normalize(vec);
    this.embeddingStore.write(sessionId, 'session', MODEL, normalized);
    return normalized;
  }

  /**
   * Generate and persist a prompt embedding from prompt features.
   */
  generatePromptEmbedding(promptId: string): number[] | undefined {
    const prompt = this.featureStore.read('prompt', promptId);
    if (!prompt) return undefined;

    const vec = PROMPT_VECTOR_KEYS.map((key) => {
      const val = prompt.features[key] ?? 0;
      // Log-scale count-like features (indices 2..4)
      const idx = PROMPT_VECTOR_KEYS.indexOf(key);
      if ([2, 3, 4].includes(idx)) {
        return val > 0 ? Math.log1p(val) : 0;
      }
      return val;
    });

    const normalized = normalize(vec);
    this.embeddingStore.write(promptId, 'prompt', MODEL, normalized);
    return normalized;
  }

  /**
   * Generate embeddings for all sessions and prompts in the store.
   */
  computeAll(): { sessions: number; prompts: number } {
    const sessionIds = this.eventStore.getSessionIds();
    let sessions = 0, prompts = 0;

    for (const sid of sessionIds) {
      if (this.generateSessionEmbedding(sid)) sessions++;

      // Find promptIds for this session
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
  findSimilarSessions(sessionId: string, topK = 5): { entityId: string; similarity: number }[] {
    const query = this.embeddingStore.read(sessionId, 'session', MODEL);
    if (!query) return [];
    const results = this.embeddingStore.search(query.vector, 'session', topK + 1, MODEL);
    // Exclude self
    return results.filter((r) => r.entityId !== sessionId).slice(0, topK);
  }
}
