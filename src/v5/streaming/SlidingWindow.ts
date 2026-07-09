// Sliding window for streaming predictions: trigger prediction when
// time or event count crosses a threshold, instead of waiting for session_end.

import type { RuntimeEvent, RuntimeSnapshot } from '../runtime/types.js';

export interface SlidingWindowOptions {
  maxEvents: number;
  maxMs: number;
  maxTokenDelta: number;
}

export interface WindowCheck {
  shouldPredict: boolean;
  reason: string;
}

export class SlidingWindow {
  private lastPredictAt = 0;
  private lastPredictEventCount = 0;
  private lastPredictTokens = 0;

  constructor(private options: SlidingWindowOptions) {}

  check(snapshot: RuntimeSnapshot): WindowCheck {
    const now = Date.now();
    const eventDelta = snapshot.events.length - this.lastPredictEventCount;
    const tokenDelta = snapshot.contextTokens - this.lastPredictTokens;
    const timeDelta = now - this.lastPredictAt;

    if (eventDelta >= this.options.maxEvents) {
      return { shouldPredict: true, reason: `${eventDelta} new events` };
    }
    if (tokenDelta >= this.options.maxTokenDelta) {
      return { shouldPredict: true, reason: `${tokenDelta} new tokens` };
    }
    if (timeDelta >= this.options.maxMs && eventDelta > 0) {
      return { shouldPredict: true, reason: `${Math.round(timeDelta / 1000)}s elapsed` };
    }

    return { shouldPredict: false, reason: 'no trigger' };
  }

  markPredicted(snapshot: RuntimeSnapshot): void {
    this.lastPredictAt = Date.now();
    this.lastPredictEventCount = snapshot.events.length;
    this.lastPredictTokens = snapshot.contextTokens;
  }

  reset(): void {
    this.lastPredictAt = 0;
    this.lastPredictEventCount = 0;
    this.lastPredictTokens = 0;
  }
}

// Helper: build a RuntimeEvent from raw fields (used by demo and tests)
let _eventCounter = 0;
export function makeEvent(sessionId: string, type: string, payload: Record<string, unknown> = {}): RuntimeEvent {
  _eventCounter += 1;
  return {
    id: `evt-${sessionId}-${_eventCounter}-${Date.now()}`,
    sessionId,
    timestamp: Date.now(),
    type,
    payload,
  };
}
