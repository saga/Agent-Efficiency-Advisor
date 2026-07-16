// realDataset — load observed sessions from AEA SQLite and produce TrainingSample.
//
// Bridges the V6 Event Store to the model-size classifier.
// Labels are derived from real user behavior signals (accept/retry/reject)
// via BehaviorLabelExtractor when available, falling back to heuristic labels.

import fs from 'node:fs';
import { openDatabase } from '../store/schema.js';
import { EventStore } from '../store/EventStore.js';
import type { IDEEvent } from '../store/types.js';
import type { ModelSizeFeatures, ModelSizeLabel } from './features.js';
import { extractModelSizeFeaturesFromEvents } from './features.js';
import type { TrainingSample } from './dataset.js';
import { extractBehaviorLabel } from './BehaviorLabelExtractor.js';

export interface RealDatasetOptions {
  /**
   * Path to an AEA SQLite database written by V6Sink / demo:real-copilot /
   * demo:session-store. Defaults to the real-copilot output DB.
   */
  dbPath?: string;
  /** Minimum events per session to be included. */
  minEvents?: number;
  /** If true, use behavior-based labels; if false, use heuristic only. */
  useBehaviorLabels?: boolean;
}

/**
 * Heuristic label for a session based on its observed features.
 * Mirrors the rule-based Advisor so we can bootstrap a classifier from
 * real sessions without ground-truth labels.
 */
export function heuristicLabel(features: ModelSizeFeatures): ModelSizeLabel {
  const complexity =
    features.promptTokens / 1000 +
    features.toolCalls * 2 +
    features.edits * 15 +
    features.retries * 50 +
    features.hasLoop * 100 +
    features.subAgents * 30;

  if (complexity <= 20) return 'mini';
  if (complexity <= 60) return 'medium';
  return 'large';
}

export interface RealSampleWithMeta extends TrainingSample {
  labelSource: 'behavior' | 'heuristic';
  behaviorSignals?: {
    acceptCount: number;
    retryCount: number;
    rewardNormalized: number;
  };
}

/**
 * Load sessions from an AEA SQLite DB and convert each to a TrainingSample.
 * Uses behavior-based labels when accept/retry events are present, otherwise
 * falls back to the heuristic label.
 */
export function loadRealTrainingSamples(options: RealDatasetOptions = {}): TrainingSample[] {
  return loadRealTrainingSamplesWithMeta(options);
}

/**
 * Load sessions with metadata about label source and behavior signals.
 */
export function loadRealTrainingSamplesWithMeta(options: RealDatasetOptions = {}): RealSampleWithMeta[] {
  const dbPath = options.dbPath ?? './data/aea-real.db';
  const minEvents = options.minEvents ?? 3;
  const useBehaviorLabels = options.useBehaviorLabels ?? true;

  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const db = openDatabase(dbPath);
  const eventStore = new EventStore(db);
  const samples: RealSampleWithMeta[] = [];

  for (const sessionId of eventStore.getSessionIds()) {
    const events = eventStore.getBySession(sessionId);
    if (events.length < minEvents) continue;

    const features = extractModelSizeFeaturesFromEvents(events);
    if (!features) continue;

    // Skip degenerate sessions with no meaningful activity.
    if (
      features.promptTokens === 0 &&
      features.completionTokens === 0 &&
      features.toolCalls === 0 &&
      features.readFiles === 0
    ) {
      continue;
    }

    let label: ModelSizeLabel;
    let labelSource: 'behavior' | 'heuristic' = 'heuristic';
    let behaviorSignals: RealSampleWithMeta['behaviorSignals'];

    if (useBehaviorLabels) {
      const signals = extractBehaviorLabel(events, features);
      label = signals.label;
      labelSource = signals.labelSource;
      behaviorSignals = {
        acceptCount: signals.acceptCount,
        retryCount: signals.retryCount,
        rewardNormalized: signals.rewardNormalized,
      };
    } else {
      label = heuristicLabel(features);
    }

    samples.push({
      // Mark heuristic-only sessions for PseudoLabeler to pick up
      sessionId: labelSource === 'heuristic' ? `heuristic:${sessionId}` : sessionId,
      features,
      label,
      labelSource,
      behaviorSignals,
    });
  }

  db.close();
  return samples;
}
