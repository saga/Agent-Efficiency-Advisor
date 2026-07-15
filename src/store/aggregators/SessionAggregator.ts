// SessionAggregator — Event → SessionAggregate.
// v7.md #1: 只负责聚合事件序列与基础计数，不计算 rate / entropy / burst 等派生指标。

import type { IDEEvent } from '../types.js';
import type { SessionAggregate } from './types.js';

export class SessionAggregator {
  aggregate(sessionId: string, events: IDEEvent[]): SessionAggregate {
    const types = events.map((e) => e.eventType);
    const startTime = events[0]?.timestamp ?? 0;
    const endTime = events[events.length - 1]?.timestamp ?? 0;

    let completions = 0, retries = 0, accepts = 0, rejects = 0;
    for (const t of types) {
      if (t === 'completion') completions++;
      else if (t === 'retry') retries++;
      else if (t === 'accept') accepts++;
      else if (t === 'reject') rejects++;
    }

    return {
      sessionId,
      workspaceId: events[0]?.workspaceId ?? '',
      events,
      types,
      startTime,
      endTime,
      duration: endTime - startTime,
      completions,
      retries,
      accepts,
      rejects,
    };
  }
}
