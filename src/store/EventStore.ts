// EventStore — insert and query IDEEvents.

import type Database from 'better-sqlite3';
import type { IDEEvent, IDEEventType } from './types.js';

export class EventStore {
  constructor(private db: Database.Database) {}

  insert(event: IDEEvent): number {
    const stmt = this.db.prepare(`
      INSERT INTO events (timestamp, session_id, workspace_id, event_type, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      event.timestamp,
      event.sessionId,
      event.workspaceId,
      event.eventType,
      JSON.stringify(event.metadata ?? {})
    );
    return Number(result.lastInsertRowid);
  }

  insertBatch(events: IDEEvent[]): number {
    let count = 0;
    const tx = this.db.transaction((items: IDEEvent[]) => {
      for (const e of items) {
        this.insert(e);
        count++;
      }
    });
    tx(events);
    return count;
  }

  getBySession(sessionId: string): IDEEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp').all(sessionId) as any[];
    return rows.map(rowToEvent);
  }

  getByType(eventType: IDEEventType, limit = 1000): IDEEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE event_type = ? ORDER BY timestamp LIMIT ?').all(eventType, limit) as any[];
    return rows.map(rowToEvent);
  }

  getByWorkspace(workspaceId: string, from?: number, to?: number): IDEEvent[] {
    if (from !== undefined && to !== undefined) {
      const rows = this.db.prepare('SELECT * FROM events WHERE workspace_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp').all(workspaceId, from, to) as any[];
      return rows.map(rowToEvent);
    }
    const rows = this.db.prepare('SELECT * FROM events WHERE workspace_id = ? ORDER BY timestamp').all(workspaceId) as any[];
    return rows.map(rowToEvent);
  }

  getSessionIds(workspaceId?: string): string[] {
    const sql = workspaceId
      ? 'SELECT DISTINCT session_id FROM events WHERE workspace_id = ?'
      : 'SELECT DISTINCT session_id FROM events';
    const rows = (workspaceId ? this.db.prepare(sql).all(workspaceId) : this.db.prepare(sql).all()) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return row.n;
  }

  /** 删除超过指定天数的旧事件 */
  prune(olderThanDays: number): number {
    const cutoff = Date.now() - olderThanDays * 86400000;
    const result = this.db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff);
    return Number(result.changes);
  }
}

function rowToEvent(row: any): IDEEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    metadata: JSON.parse(row.metadata ?? '{}'),
  };
}
