// GraphBuilder tests — verify graph construction, node/edge types, and dedup.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, dispose, seedGoodSession, seedRetrySession, seedExplodeSession, type TestContext } from './helpers.js';
import { GraphStore } from '../src/graph/GraphStore.js';
import { GraphBuilder } from '../src/graph/GraphBuilder.js';
import { GraphQueries } from '../src/graph/GraphQueries.js';
import { AnalyticsEngine } from '../src/ml/AnalyticsEngine.js';
import { EmbeddingStore } from '../src/embedding/EmbeddingStore.js';
import { EmbeddingPipeline } from '../src/embedding/EmbeddingPipeline.js';

describe('GraphBuilder', () => {
  let ctx: TestContext;
  let graphStore: GraphStore;
  let builder: GraphBuilder;

  beforeEach(() => {
    ctx = createTestContext();
    graphStore = new GraphStore(ctx.db);
    builder = new GraphBuilder(ctx.eventStore, ctx.featureStore, graphStore);
  });

  afterEach(() => {
    dispose(ctx);
  });

  it('creates session and workspace nodes', () => {
    seedGoodSession(ctx, 'sess-1', 'ws-1');
    ctx.pipeline.computeSession('sess-1');

    builder.build();

    const sessions = graphStore.getNodesByType('session');
    const workspaces = graphStore.getNodesByType('workspace');
    expect(sessions).toHaveLength(1);
    expect(workspaces).toHaveLength(1);
    expect(sessions[0].entityId).toBe('sess-1');
    expect(workspaces[0].entityId).toBe('ws-1');
  });

  it('creates prompt, completion, accept, and file nodes', () => {
    seedGoodSession(ctx);
    ctx.pipeline.computeSession('sess-good');

    builder.build();

    expect(graphStore.getNodesByType('prompt')).toHaveLength(1);
    expect(graphStore.getNodesByType('completion')).toHaveLength(1);
    expect(graphStore.getNodesByType('accept')).toHaveLength(1);
    expect(graphStore.getNodesByType('file')).toHaveLength(2); // src/index.ts + src/utils.ts
  });

  it('creates retry and reject nodes for retry session', () => {
    seedRetrySession(ctx);
    ctx.pipeline.computeSession('sess-retry');

    builder.build();

    expect(graphStore.getNodesByType('retry')).toHaveLength(3);
    expect(graphStore.getNodesByType('reject')).toHaveLength(1);
  });

  it('deduplicates workspace_language edges across sessions', () => {
    // Two sessions in the same workspace with the same languages
    seedGoodSession(ctx, 'sess-1', 'ws-shared');
    seedGoodSession(ctx, 'sess-2', 'ws-shared');
    ctx.pipeline.computeAllSessions();

    builder.build();

    const langEdges = graphStore.getEdgesByType('workspace_language');
    // Should be 1 edge per language, NOT 2 (one per session)
    // The good session has languages: ['TypeScript']
    expect(langEdges.length).toBe(1);
  });

  it('deduplicates file nodes by path', () => {
    // Both sessions read src/index.ts
    seedGoodSession(ctx, 'sess-1', 'ws-1');
    seedGoodSession(ctx, 'sess-2', 'ws-1');
    ctx.pipeline.computeAllSessions();

    builder.build();

    const files = graphStore.getNodesByType('file');
    // src/index.ts appears in both sessions but should be 1 node
    const indexPaths = files.filter((f) => f.entityId === 'src/index.ts');
    expect(indexPaths).toHaveLength(1);
  });

  it('links prompt to files read before it (prompt_file edges)', () => {
    seedGoodSession(ctx);
    ctx.pipeline.computeSession('sess-good');

    builder.build();

    const promptFileEdges = graphStore.getEdgesByType('prompt_file');
    // Good session reads 2 files before the chat → 2 prompt_file edges
    expect(promptFileEdges.length).toBe(2);
  });

  it('creates session_tool edges for tool usage', () => {
    const t = Date.now();
    ctx.eventStore.insertBatch([
      { timestamp: t, sessionId: 's1', workspaceId: 'ws', eventType: 'session_start', metadata: { languages: ['TS'] } },
      { timestamp: t + 1, sessionId: 's1', workspaceId: 'ws', eventType: 'run_test', metadata: { toolName: 'vitest' } },
      { timestamp: t + 2, sessionId: 's1', workspaceId: 'ws', eventType: 'session_end', metadata: {} },
    ]);
    ctx.pipeline.computeSession('s1');

    builder.build();

    const tools = graphStore.getNodesByType('tool');
    expect(tools).toHaveLength(1);
    expect(tools[0].properties.name).toBe('vitest');
  });
});

describe('GraphQueries', () => {
  let ctx: TestContext;
  let graphStore: GraphStore;
  let builder: GraphBuilder;
  let embeddingStore: EmbeddingStore;
  let embeddingPipeline: EmbeddingPipeline;

  beforeEach(() => {
    ctx = createTestContext();
    graphStore = new GraphStore(ctx.db);
    builder = new GraphBuilder(ctx.eventStore, ctx.featureStore, graphStore);
    embeddingStore = new EmbeddingStore(ctx.db);
    embeddingPipeline = new EmbeddingPipeline(ctx.eventStore, ctx.featureStore, embeddingStore);
  });

  afterEach(() => {
    dispose(ctx);
  });

  it('findSessionsSucceededAfterRetries finds sessions with retries + accepts', () => {
    // A session with 3 retries but eventually accepts
    const t = Date.now();
    ctx.eventStore.insertBatch([
      { timestamp: t, sessionId: 's-recover', workspaceId: 'ws', eventType: 'session_start', metadata: { languages: ['TS'] } },
      { timestamp: t + 1, sessionId: 's-recover', workspaceId: 'ws', eventType: 'chat', metadata: { promptId: 'p1', tokenCount: 500, retrievedFiles: 0, contextToken: 500, historyToken: 0 } },
      { timestamp: t + 2, sessionId: 's-recover', workspaceId: 'ws', eventType: 'completion', metadata: { tokenCount: 100 } },
      { timestamp: t + 3, sessionId: 's-recover', workspaceId: 'ws', eventType: 'retry', metadata: {} },
      { timestamp: t + 4, sessionId: 's-recover', workspaceId: 'ws', eventType: 'retry', metadata: {} },
      { timestamp: t + 5, sessionId: 's-recover', workspaceId: 'ws', eventType: 'retry', metadata: {} },
      { timestamp: t + 6, sessionId: 's-recover', workspaceId: 'ws', eventType: 'accept', metadata: {} },
      { timestamp: t + 7, sessionId: 's-recover', workspaceId: 'ws', eventType: 'session_end', metadata: {} },
    ]);
    ctx.pipeline.computeSession('s-recover');

    builder.build();

    const queries = new GraphQueries(graphStore, ctx.eventStore, ctx.featureStore);
    const results = queries.findSessionsSucceededAfterRetries(3);
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe('s-recover');
    expect(results[0].retryCount).toBe(3);
    expect(results[0].acceptCount).toBe(1);
    expect(results[0].succeeded).toBe(true);
  });

  it('toolAcceptRateImpact aggregates by tool name', () => {
    seedGoodSession(ctx, 'sess-1', 'ws-1');
    // Add a tool call to the good session
    const events = ctx.eventStore.getBySession('sess-1');
    const t = events[events.length - 1].timestamp;
    ctx.eventStore.insertBatch([
      { timestamp: t + 100, sessionId: 'sess-1', workspaceId: 'ws-1', eventType: 'run_test', metadata: { toolName: 'vitest' } },
    ]);
    ctx.pipeline.computeSession('sess-1');

    builder.build();

    const queries = new GraphQueries(graphStore, ctx.eventStore, ctx.featureStore);
    const results = queries.toolAcceptRateImpact();
    const vitest = results.find((r) => r.toolName === 'vitest');
    expect(vitest).toBeDefined();
    expect(vitest!.sessionCount).toBe(1);
  });
});
