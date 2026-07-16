// TemporalFeatures — add time-based and historical behavior features.
//
// These features capture patterns that the base ModelSizeFeatures miss:
//   - Hour of day / weekday (coding patterns vary by time)
//   - Session duration breakdown (chat vs tool vs idle)
//   - Rolling statistics from past N sessions (moving average, EMA)
//   - Accept rate, retry rate, tool success rate (behavioral signals)
//
// The rolling features require a session history, which is maintained
// by the caller and passed in as an array of past session features.

import type { IDEEvent } from '../store/types.js';

export interface TemporalFeatures {
  // Time-based
  hourOfDay: number;        // 0-23
  dayOfWeek: number;        // 0-6 (0=Sunday)
  isWeekend: number;        // 0 or 1

  // Session dynamics
  chatDurationMs: number;   // time spent in chat events
  toolDurationMs: number;   // time spent in tool calls
  idleMs: number;           // gaps between events > 5s
  chatToToolRatio: number;  // chat events / tool events

  // Behavior rates
  acceptRate: number;       // accept / (accept + retry + reject)
  cancelRate: number;       // cancelled sessions / total (from history)
  switchRate: number;       // model switches / session (if detectable)
  toolSuccessRate: number;  // successful tools / total tools

  // Rolling statistics (from past N sessions)
  rollingAvgTokens: number; // moving average of total tokens
  rollingAvgDuration: number; // moving average of session duration
  rollingAcceptRate: number;  // moving average of accept rate
  emaTokens: number;          // EMA of total tokens (alpha=0.3)
  emaRetryRate: number;       // EMA of retry rate
  sessionsToday: number;      // number of sessions today
}

export const TEMPORAL_FEATURE_COLUMNS: (keyof TemporalFeatures)[] = [
  'hourOfDay',
  'dayOfWeek',
  'isWeekend',
  'chatDurationMs',
  'toolDurationMs',
  'idleMs',
  'chatToToolRatio',
  'acceptRate',
  'cancelRate',
  'switchRate',
  'toolSuccessRate',
  'rollingAvgTokens',
  'rollingAvgDuration',
  'rollingAcceptRate',
  'emaTokens',
  'emaRetryRate',
  'sessionsToday',
];

export interface SessionHistoryEntry {
  timestamp: number;
  totalTokens: number;
  duration: number;
  acceptRate: number;
  retryRate: number;
  cancelled: boolean;
}

const EMA_ALPHA = 0.3;
const ROLLING_WINDOW = 10;
const IDLE_THRESHOLD_MS = 5000;

/**
 * Extract temporal and behavioral features from a session's events.
 *
 * @param events Chronologically ordered IDEEvents for a single session
 * @param history Past session entries for rolling statistics (most recent first)
 */
export function extractTemporalFeatures(
  events: IDEEvent[],
  history: SessionHistoryEntry[] = [],
): TemporalFeatures {
  if (events.length === 0) {
    return emptyTemporalFeatures();
  }

  const startTime = events[0]?.timestamp ?? Date.now();
  const date = new Date(startTime);

  // Time-based features
  const hourOfDay = date.getHours();
  const dayOfWeek = date.getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6) ? 1 : 0;

  // Session dynamics
  let chatDurationMs = 0;
  let toolDurationMs = 0;
  let idleMs = 0;
  let chatCount = 0;
  let toolCount = 0;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const nextTs = i < events.length - 1 ? events[i + 1].timestamp : e.timestamp;
    const gap = i > 0 ? e.timestamp - events[i - 1].timestamp : 0;

    if (gap > IDLE_THRESHOLD_MS) {
      idleMs += gap;
    }

    const duration = Number(e.metadata?.durationMs ?? Math.max(0, nextTs - e.timestamp));

    switch (e.eventType) {
      case 'chat':
        chatCount++;
        chatDurationMs += duration;
        break;
      case 'tool_call':
      case 'read_file':
      case 'run_test':
      case 'terminal':
        toolCount++;
        toolDurationMs += duration;
        break;
    }
  }

  const chatToToolRatio = toolCount > 0 ? chatCount / toolCount : chatCount;

  // Behavior rates
  let acceptCount = 0;
  let retryCount = 0;
  let rejectCount = 0;
  let toolSuccesses = 0;
  let toolTotal = 0;

  for (const e of events) {
    switch (e.eventType) {
      case 'accept':
        acceptCount++;
        toolTotal++;
        if (e.metadata?.success !== false) toolSuccesses++;
        break;
      case 'retry':
        retryCount++;
        toolTotal++;
        break;
      case 'reject':
        rejectCount++;
        toolTotal++;
        break;
    }
  }

  const totalFeedback = acceptCount + retryCount + rejectCount;
  const acceptRate = totalFeedback > 0 ? acceptCount / totalFeedback : 0;
  const toolSuccessRate = toolTotal > 0 ? toolSuccesses / toolTotal : 0;

  // Cancel rate from history
  const cancelRate = history.length > 0
    ? history.filter((h) => h.cancelled).length / history.length
    : 0;

  // Switch rate: detect model changes (not directly available, estimate as 0)
  const switchRate = 0;

  // Rolling statistics from history
  const recentHistory = history.slice(0, ROLLING_WINDOW);

  const rollingAvgTokens = recentHistory.length > 0
    ? recentHistory.reduce((sum, h) => sum + h.totalTokens, 0) / recentHistory.length
    : 0;

  const rollingAvgDuration = recentHistory.length > 0
    ? recentHistory.reduce((sum, h) => sum + h.duration, 0) / recentHistory.length
    : 0;

  const rollingAcceptRate = recentHistory.length > 0
    ? recentHistory.reduce((sum, h) => sum + h.acceptRate, 0) / recentHistory.length
    : 0;

  // EMA calculation (iterate from oldest to newest)
  let emaTokens = 0;
  let emaRetryRate = 0;
  if (recentHistory.length > 0) {
    const reversed = [...recentHistory].reverse(); // oldest first
    emaTokens = reversed[0].totalTokens;
    emaRetryRate = reversed[0].retryRate;
    for (let i = 1; i < reversed.length; i++) {
      emaTokens = EMA_ALPHA * reversed[i].totalTokens + (1 - EMA_ALPHA) * emaTokens;
      emaRetryRate = EMA_ALPHA * reversed[i].retryRate + (1 - EMA_ALPHA) * emaRetryRate;
    }
  }

  // Sessions today
  const todayStart = new Date(startTime);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const sessionsToday = history.filter((h) => h.timestamp >= todayStartMs).length;

  return {
    hourOfDay,
    dayOfWeek,
    isWeekend,
    chatDurationMs,
    toolDurationMs,
    idleMs,
    chatToToolRatio,
    acceptRate,
    cancelRate,
    switchRate,
    toolSuccessRate,
    rollingAvgTokens,
    rollingAvgDuration,
    rollingAcceptRate,
    emaTokens,
    emaRetryRate,
    sessionsToday,
  };
}

function emptyTemporalFeatures(): TemporalFeatures {
  return {
    hourOfDay: 0,
    dayOfWeek: 0,
    isWeekend: 0,
    chatDurationMs: 0,
    toolDurationMs: 0,
    idleMs: 0,
    chatToToolRatio: 0,
    acceptRate: 0,
    cancelRate: 0,
    switchRate: 0,
    toolSuccessRate: 0,
    rollingAvgTokens: 0,
    rollingAvgDuration: 0,
    rollingAcceptRate: 0,
    emaTokens: 0,
    emaRetryRate: 0,
    sessionsToday: 0,
  };
}

/**
 * Create a SessionHistoryEntry from a completed session's features and events.
 */
export function createHistoryEntry(
  timestamp: number,
  events: IDEEvent[],
  promptTokens: number,
  completionTokens: number,
  duration: number,
  retryRate: number,
): SessionHistoryEntry {
  let acceptCount = 0;
  let totalFeedback = 0;
  let cancelled = false;

  for (const e of events) {
    if (e.eventType === 'accept') {
      acceptCount++;
      totalFeedback++;
    } else if (e.eventType === 'retry' || e.eventType === 'reject') {
      totalFeedback++;
    }
  }

  // A session is cancelled if it has very few events and no accepts
  cancelled = events.length < 3 && acceptCount === 0;

  return {
    timestamp,
    totalTokens: promptTokens + completionTokens,
    duration,
    acceptRate: totalFeedback > 0 ? acceptCount / totalFeedback : 0,
    retryRate,
    cancelled,
  };
}
