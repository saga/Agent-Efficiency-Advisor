// Tests for CopilotSessionStore — reads VSCode Copilot Chat session-store SQLite.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CopilotSessionStore } from '../src/realtime/CopilotSessionStore.js';

describe('CopilotSessionStore', () => {
  let tmpDir: string;
  let dbPath: string;
  let sourceDb: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aea-session-store-'));
    dbPath = join(tmpDir, 'session-store.db');
    sourceDb = new Database(dbPath);

    sourceDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        agent_name TEXT,
        summary TEXT,
        repository TEXT,
        branch TEXT,
        cwd TEXT
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        user_message TEXT,
        assistant_response TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE session_files (
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        tool_name TEXT,
        turn_index INTEGER NOT NULL,
        first_seen_at INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    sourceDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedOneSession() {
    // Real session-store.db stores timestamps as ISO 8601 strings.
    const t0 = Date.now();
    const iso = (offset: number) => new Date(t0 + offset).toISOString();
    sourceDb.prepare(`
      INSERT INTO sessions (id, workspace_id, created_at, updated_at, agent_name, summary, repository, branch, cwd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-1', 'ws-1', iso(0), iso(5000), 'ask', 'Refactor utils', 'aea', 'main', '/Users/saga/code-repos/aea');

    sourceDb.prepare(`
      INSERT INTO turns (id, session_id, turn_index, user_message, assistant_response, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('turn-1', 'sess-1', 0, 'refactor the helper', 'OK I will refactor utils.ts', iso(1000));

    sourceDb.prepare(`
      INSERT INTO turns (id, session_id, turn_index, user_message, assistant_response, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('turn-2', 'sess-1', 1, 'also fix the tests', 'Done', iso(3000));

    sourceDb.prepare(`
      INSERT INTO session_files (session_id, file_path, tool_name, turn_index, first_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('sess-1', 'src/utils.ts', 'read_file', 0, iso(500));
  }

  it('reads session count', () => {
    seedOneSession();
    const store = new CopilotSessionStore({ dbPath });
    expect(store.getSessionCount()).toBe(1);
    store.close();
  });

  it('maps session metadata correctly', () => {
    seedOneSession();
    const store = new CopilotSessionStore({ dbPath });
    const sessions = store.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-1');
    expect(sessions[0].workspaceId).toBe('ws-1');
    expect(sessions[0].repository).toBe('aea');
    expect(sessions[0].branch).toBe('main');
    expect(sessions[0].agentName).toBe('ask');
    store.close();
  });

  it('converts a session to IDEEvent stream', () => {
    seedOneSession();
    const store = new CopilotSessionStore({ dbPath });
    const session = store.getSessions()[0];
    const events = store.toIDEEvents(session);

    const types = events.map((e) => e.eventType);
    expect(types[0]).toBe('session_start');
    expect(types[types.length - 1]).toBe('session_end');
    expect(types).toContain('chat');
    expect(types).toContain('completion');
    expect(types).toContain('read_file');

    expect(events.every((e) => e.sessionId === 'sess-1')).toBe(true);
    expect(events.every((e) => e.workspaceId === 'ws-1')).toBe(true);

    const chat = events.find((e) => e.eventType === 'chat');
    expect(chat?.metadata.turnIndex).toBe(0);
    expect(chat?.metadata.messageLength).toBeGreaterThan(0);

    const readFile = events.find((e) => e.eventType === 'read_file');
    expect(readFile?.metadata.path).toBe('src/utils.ts');

    store.close();
  });

  it('infers workspace id from repository when workspace_id is null', () => {
    const t0 = Date.now();
    const iso = (offset: number) => new Date(t0 + offset).toISOString();
    sourceDb.prepare(`
      INSERT INTO sessions (id, workspace_id, created_at, updated_at, agent_name, summary, repository, branch, cwd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-2', null, iso(0), iso(1000), null, null, 'my-repo', null, null);
    sourceDb.prepare(`
      INSERT INTO turns (id, session_id, turn_index, user_message, assistant_response, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('turn-3', 'sess-2', 0, 'hi', 'hello', iso(100));

    const store = new CopilotSessionStore({ dbPath, defaultWorkspaceId: 'fallback' });
    const session = store.getSessions()[0];
    const events = store.toIDEEvents(session);
    expect(events[0].workspaceId).toBe('repo:my-repo');
    store.close();
  });

  it('orders events chronologically', () => {
    seedOneSession();
    const store = new CopilotSessionStore({ dbPath });
    const session = store.getSessions()[0];
    const events = store.toIDEEvents(session);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
    }
    store.close();
  });
});
