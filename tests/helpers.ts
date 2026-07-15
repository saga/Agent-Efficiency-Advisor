// Test helpers — create in-memory SQLite + seed events for V6 tests.

import Database from 'better-sqlite3';
import { openDatabase } from '../src/store/schema.js';
import { EventStore } from '../src/store/EventStore.js';
import { FeatureRegistry } from '../src/store/FeatureRegistry.js';
import { FeatureStore } from '../src/store/FeatureStore.js';
import { FeaturePipeline } from '../src/store/FeaturePipeline.js';
import type { IDEEvent } from '../src/store/types.js';

export interface TestContext {
  db: Database.Database;
  eventStore: EventStore;
  featureStore: FeatureStore;
  pipeline: FeaturePipeline;
  registry: FeatureRegistry;
}

export function createTestContext(): TestContext {
  const db = openDatabase(':memory:');
  const eventStore = new EventStore(db);
  const registry = new FeatureRegistry(db);
  const featureStore = new FeatureStore(db);
  const pipeline = new FeaturePipeline(db, eventStore, featureStore, registry);
  return { db, eventStore, featureStore, pipeline, registry };
}

export function dispose(ctx: TestContext): void {
  ctx.db.close();
}

/** A simple good session: read 2 files, chat, completion, accept, edit, commit. */
export function seedGoodSession(
  ctx: TestContext,
  sessionId = 'sess-good',
  ws = 'ws-test'
): IDEEvent[] {
  const t = Date.now();
  const events: IDEEvent[] = [
    { timestamp: t, sessionId, workspaceId: ws, eventType: 'session_start', metadata: { model: 'gpt-5', languages: ['TypeScript'], dependencies: ['react'] } },
    { timestamp: t + 1, sessionId, workspaceId: ws, eventType: 'read_file', metadata: { path: 'src/index.ts' } },
    { timestamp: t + 2, sessionId, workspaceId: ws, eventType: 'read_file', metadata: { path: 'src/utils.ts' } },
    { timestamp: t + 3, sessionId, workspaceId: ws, eventType: 'chat', metadata: { promptId: 'p1', tokenCount: 1000, retrievedFiles: 2, contextToken: 1200, historyToken: 0 } },
    { timestamp: t + 4, sessionId, workspaceId: ws, eventType: 'completion', metadata: { tokenCount: 300 } },
    { timestamp: t + 5, sessionId, workspaceId: ws, eventType: 'accept', metadata: {} },
    { timestamp: t + 6, sessionId, workspaceId: ws, eventType: 'edit', metadata: { file: 'src/index.ts' } },
    { timestamp: t + 7, sessionId, workspaceId: ws, eventType: 'commit', metadata: { branch: 'main', author: 'tester' } },
    { timestamp: t + 8, sessionId, workspaceId: ws, eventType: 'session_end', metadata: {} },
  ];
  ctx.eventStore.insertBatch(events);
  return events;
}

/** A retry-heavy session: chat, completion, retry×3, reject. */
export function seedRetrySession(
  ctx: TestContext,
  sessionId = 'sess-retry',
  ws = 'ws-test'
): IDEEvent[] {
  const t = Date.now();
  const events: IDEEvent[] = [
    { timestamp: t, sessionId, workspaceId: ws, eventType: 'session_start', metadata: { model: 'gpt-5', languages: ['TypeScript'], dependencies: ['react'] } },
    { timestamp: t + 1, sessionId, workspaceId: ws, eventType: 'chat', metadata: { promptId: 'p2', tokenCount: 3000, retrievedFiles: 5, contextToken: 4000, historyToken: 800 } },
    { timestamp: t + 2, sessionId, workspaceId: ws, eventType: 'completion', metadata: { tokenCount: 600 } },
    { timestamp: t + 3, sessionId, workspaceId: ws, eventType: 'retry', metadata: {} },
    { timestamp: t + 4, sessionId, workspaceId: ws, eventType: 'retry', metadata: {} },
    { timestamp: t + 5, sessionId, workspaceId: ws, eventType: 'retry', metadata: {} },
    { timestamp: t + 6, sessionId, workspaceId: ws, eventType: 'reject', metadata: {} },
    { timestamp: t + 7, sessionId, workspaceId: ws, eventType: 'session_end', metadata: {} },
  ];
  ctx.eventStore.insertBatch(events);
  return events;
}

/** A context explosion session: read many files, large prompt, retry, reject. */
export function seedExplodeSession(
  ctx: TestContext,
  sessionId = 'sess-explode',
  ws = 'ws-test'
): IDEEvent[] {
  const t = Date.now();
  const events: IDEEvent[] = [
    { timestamp: t, sessionId, workspaceId: ws, eventType: 'session_start', metadata: { model: 'gpt-5', languages: ['TypeScript'], dependencies: ['react'] } },
    { timestamp: t + 1, sessionId, workspaceId: ws, eventType: 'read_file', metadata: { path: 'README.md' } },
    { timestamp: t + 2, sessionId, workspaceId: ws, eventType: 'read_file', metadata: { path: 'package.json' } },
    { timestamp: t + 3, sessionId, workspaceId: ws, eventType: 'read_file', metadata: { path: 'tsconfig.json' } },
    { timestamp: t + 4, sessionId, workspaceId: ws, eventType: 'read_file', metadata: { path: 'src/store/schema.ts' } },
    { timestamp: t + 5, sessionId, workspaceId: ws, eventType: 'chat', metadata: { promptId: 'p3', tokenCount: 8000, retrievedFiles: 10, contextToken: 12000, historyToken: 0 } },
    { timestamp: t + 6, sessionId, workspaceId: ws, eventType: 'completion', metadata: { tokenCount: 1500 } },
    { timestamp: t + 7, sessionId, workspaceId: ws, eventType: 'retry', metadata: {} },
    { timestamp: t + 8, sessionId, workspaceId: ws, eventType: 'reject', metadata: {} },
    { timestamp: t + 9, sessionId, workspaceId: ws, eventType: 'session_end', metadata: {} },
  ];
  ctx.eventStore.insertBatch(events);
  return events;
}
