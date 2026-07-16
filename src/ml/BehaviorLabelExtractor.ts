// BehaviorLabelExtractor — extract real user behavior labels from IDEEvents.
//
// This replaces the heuristic label approach with a reward-based model:
//   accept   → +1.0  (user accepted the tool call / edit / response)
//   retry    → -0.3  (user retried, model wasn't good enough)
//   reject   → -0.5  (user explicitly rejected)
//   abandon  → -0.8  (session ended early with few interactions)
//   cancel   → -1.0  (session was cancelled)
//
// The reward is mapped to a ModelSizeLabel:
//   reward >= 0.5  → mini  (task was simple, model was sufficient)
//   reward >= 0.0  → medium
//   reward < 0.0   → large (task needed retries/rejections, bigger model needed)
//
// When no behavior signals are present (e.g. session-store only has chat/completion),
// falls back to the heuristic label so we never lose a sample.

import type { IDEEvent } from '../store/types.js';
import type { ModelSizeFeatures, ModelSizeLabel } from './features.js';
import { heuristicLabel } from './realDataset.js';

export interface BehaviorSignals {
  acceptCount: number;
  retryCount: number;
  rejectCount: number;
  toolFailures: number;
  toolSuccesses: number;
  turnCount: number;
  sessionAbandoned: boolean;
  sessionCancelled: boolean;
  totalReward: number;
  rewardNormalized: number;
  label: ModelSizeLabel;
  labelSource: 'behavior' | 'heuristic';
}

export interface BehaviorLabelOptions {
  /** Reward values for each signal type. */
  rewards?: Partial<RewardConfig>;
  /** Minimum reward threshold for 'mini' label. */
  miniThreshold?: number;
  /** Minimum reward threshold for 'medium' label. */
  mediumThreshold?: number;
  /** If true, abandon detection requires < 3 events AND < 30s duration. */
  abandonMinEvents?: number;
}

export interface RewardConfig {
  accept: number;
  retry: number;
  reject: number;
  abandon: number;
  cancel: number;
}

const DEFAULT_REWARDS: RewardConfig = {
  accept: 1.0,
  retry: -0.3,
  reject: -0.5,
  abandon: -0.8,
  cancel: -1.0,
};

/**
 * Extract behavior-based labels from a session's IDEEvents.
 *
 * This is the core innovation: instead of using heuristic rules to decide
 * what model size a session "needed", we look at what actually happened —
 * did the user accept the responses, retry, or abandon the session?
 */
export function extractBehaviorLabel(
  events: IDEEvent[],
  features: ModelSizeFeatures,
  options: BehaviorLabelOptions = {},
): BehaviorSignals {
  const rewards = { ...DEFAULT_REWARDS, ...options.rewards };
  const miniThreshold = options.miniThreshold ?? 0.5;
  const mediumThreshold = options.mediumThreshold ?? 0.0;
  const abandonMinEvents = options.abandonMinEvents ?? 3;

  let acceptCount = 0;
  let retryCount = 0;
  let rejectCount = 0;
  let toolFailures = 0;
  let toolSuccesses = 0;
  let turnCount = 0;

  for (const e of events) {
    switch (e.eventType) {
      case 'accept':
        acceptCount++;
        if (e.metadata?.success === false) {
          toolFailures++;
        } else {
          toolSuccesses++;
        }
        break;
      case 'retry':
        retryCount++;
        toolFailures++;
        break;
      case 'reject':
        rejectCount++;
        break;
      case 'chat':
        turnCount++;
        break;
    }
  }

  // Detect session abandonment: very few events, short duration
  const duration = features.elapsedMs;
  const sessionAbandoned = events.length < abandonMinEvents && duration < 30000;

  // Detect cancellation: session_end with very few turns and no accepts
  const sessionCancelled = events.length > 0 && acceptCount === 0 && turnCount <= 1 && retryCount === 0;

  // Compute total reward
  let totalReward = 0;
  totalReward += acceptCount * rewards.accept;
  totalReward += retryCount * rewards.retry;
  totalReward += rejectCount * rewards.reject;
  if (sessionAbandoned) totalReward += rewards.abandon;
  if (sessionCancelled) totalReward += rewards.cancel;

  // Normalize by number of interactions (avoid division by zero)
  const interactionCount = acceptCount + retryCount + rejectCount + turnCount;
  const rewardNormalized = interactionCount > 0
    ? totalReward / interactionCount
    : totalReward;

  // Determine label by combining reward (was the model sufficient?)
  // with complexity (how hard was the task?).
  //
  // Key insight: behavior signals tell us if the model was good enough.
  // If the session failed (low reward), always need a larger model.
  // If the session succeeded, use complexity to determine what was needed.
  //
  //   reward < 0   → large  (model wasn't sufficient, need bigger)
  //   reward >= 0  → use complexity:
  //     low complexity  → mini  (simple task, small model was enough)
  //     medium complexity → medium
  //     high complexity → large (complex task, large model was needed)
  let label: ModelSizeLabel;
  let labelSource: 'behavior' | 'heuristic';

  if (acceptCount > 0 || retryCount > 0 || rejectCount > 0) {
    labelSource = 'behavior';

    if (rewardNormalized < mediumThreshold) {
      // Session had failures (retries/rejects) — model wasn't good enough
      label = 'large';
    } else {
      // Session succeeded — use complexity to determine needed model size.
      // Read-only tool calls (reads, searches) get weight 2; edits get
      // additional weight 15 (total 17) since editing is far more complex.
      const complexity =
        features.promptTokens / 1000 +
        features.toolCalls * 2 +
        features.edits * 15 +
        features.retries * 50 +
        features.hasLoop * 100 +
        features.subAgents * 30;

      if (complexity <= 20) {
        label = 'mini';
      } else if (complexity <= 60) {
        label = 'medium';
      } else {
        label = 'large';
      }
    }
  } else {
    // No behavior signals — fall back to heuristic
    labelSource = 'heuristic';
    label = heuristicLabel(features);
  }

  return {
    acceptCount,
    retryCount,
    rejectCount,
    toolFailures,
    toolSuccesses,
    turnCount,
    sessionAbandoned,
    sessionCancelled,
    totalReward,
    rewardNormalized,
    label,
    labelSource,
  };
}
