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

  // Determine label
  let label: ModelSizeLabel;
  let labelSource: 'behavior' | 'heuristic';

  if (acceptCount > 0 || retryCount > 0 || rejectCount > 0) {
    // We have real behavior signals — use reward-based label
    labelSource = 'behavior';
    if (rewardNormalized >= miniThreshold) {
      label = 'mini';
    } else if (rewardNormalized >= mediumThreshold) {
      label = 'medium';
    } else {
      label = 'large';
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
