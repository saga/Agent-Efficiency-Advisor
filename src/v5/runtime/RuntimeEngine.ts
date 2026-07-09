// RuntimeEngine: the core of V5. Holds events per session, applies reducer,
// supports time-travel, and notifies subscribers on every snapshot update.

import type { RuntimeEvent, RuntimeSnapshot } from './types.js';
import { createInitialSnapshot, reduce, replay, snapshotAt } from './reducer.js';

export type SnapshotListener = (snapshot: RuntimeSnapshot, event: RuntimeEvent) => void;

export class RuntimeEngine {
  private events = new Map<string, RuntimeEvent[]>();
  private snapshots = new Map<string, RuntimeSnapshot>();
  private listeners = new Set<SnapshotListener>();

  ingest(event: RuntimeEvent): RuntimeSnapshot {
    const list = this.events.get(event.sessionId) ?? [];
    const nextList = [...list, event];
    this.events.set(event.sessionId, nextList);

    const prev = this.snapshots.get(event.sessionId) ?? createInitialSnapshot(event.sessionId);
    const next = reduce(prev, event);
    this.snapshots.set(event.sessionId, next);

    for (const listener of this.listeners) {
      listener(next, event);
    }
    return next;
  }

  get(sessionId: string): RuntimeSnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  getEvents(sessionId: string): RuntimeEvent[] {
    return this.events.get(sessionId) ?? [];
  }

  // Time-travel: get snapshot as of Nth event
  getAtVersion(sessionId: string, version: number): RuntimeSnapshot | undefined {
    const events = this.events.get(sessionId);
    if (!events) return undefined;
    return snapshotAt(events, version);
  }

  // Replay all events from scratch (useful after schema changes)
  rehydrate(sessionId: string): RuntimeSnapshot {
    const events = this.events.get(sessionId) ?? [];
    const snap = replay(events, sessionId);
    this.snapshots.set(sessionId, snap);
    return snap;
  }

  all(): RuntimeSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(sessionId?: string): void {
    if (sessionId) {
      this.events.delete(sessionId);
      this.snapshots.delete(sessionId);
    } else {
      this.events.clear();
      this.snapshots.clear();
    }
  }
}
