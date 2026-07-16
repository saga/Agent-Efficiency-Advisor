// realDataset — load observed sessions from AEA SQLite and produce TrainingSample.
//
// Bridges the V6 Event Store to the model-size classifier. Labels are derived
// from a heuristic (same logic as the rule-based Advisor) because real Copilot
// sessions do not ship with ground-truth model-size labels. As outcome signals
// accumulate in data/ml/feedback.csv, this module can be extended to read them.

import Database from 'better-sqlite3';
import { openDatabase } from '../store/schema.js';
import { EventStore } from '../store/EventStore.js';
import type { IDEEvent } from '../store/types.js';
import type { ModelSizeFeatures, ModelSizeLabel } from './features.js';
import { extractModelSizeFeaturesFromEvents } from './features.js';
import type { TrainingSample } from './dataset.js';

export interface RealDatasetOptions {
  /**
   * Path to an AEA SQLite database written by V6Sink / demo:real-copilot /
   * demo:session-store. Defaults to the real-copilot output DB.
   */
  dbPath?: string;
  /** Minimum events per session to be included. */
  minEvents?: number;
}

/**
 * Heuristic label for a session based on its observed features.
 * Mirrors the rule-based Advisor so we can bootstrap a classifier from
 * real sessions without ground-truth labels.
 */
export function heuristicLabel(features: ModelSizeFeatures): ModelSizeLabel {
  if (
    features.promptTokens < 8000 &&
    features.toolCalls <= 5 &&
    features.edits <= 2 &&
    features.retries === 0 &&
    features.subAgents === 0 &&
    features.hasLoop === 0
  ) {
    return 'mini';
  }

  const complexity =
    features.promptTokens / 1000 +
    features.toolCalls * 10 +
    features.edits * 20 +
    features.retries * 50 +
    features.hasLoop * 100 +
    features.subAgents * 30;

  if (complexity <= 60) return 'medium';
  return 'large';
}

/**
 * Load sessions from an AEA SQLite DB and convert each to a TrainingSample.
 * Returns null feature rows for sessions that cannot be converted.
 */
export function loadRealTrainingSamples(options: RealDatasetOptions = {}): TrainingSample[] {
  const dbPath = options.dbPath ?? './data/aea-real-copilot.db';
  const minEvents = options.minEvents ?? 3;

  if (!require('node:fs').existsSync(dbPath)) {
    return [];
  }

  const db = openDatabase(dbPath);
  const eventStore = new EventStore(db);
  const samples: TrainingSample[] = [];

  for (const sessionId of eventStore.getSessionIds()) {
    const events = eventStore.getBySession(sessionId);
    if (events.length < minEvents) continue;

    const features = extractModelSizeFeaturesFromEvents(events);
    if (!features) continue;

    // Skip degenerate sessions with no meaningful activity.
    if (features.promptTokens === 0 && features.toolCalls === 0 && features.readFiles === 0) {
      continue;
    }

    samples.push({
      sessionId,
      features,
      label: heuristicLabel(features),
    });
  }

  db.close();
  return samples;
}
