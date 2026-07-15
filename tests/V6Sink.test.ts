// V6Sink tests — verify AgentLogEvent → IDEEvent conversion.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, dispose, type TestContext } from './helpers.js';
import { V6Sink } from '../src/realtime/V6Sink.js';
import type { AgentLogEvent } from '../src/types.js';

describe('V6Sink', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    dispose(ctx);
  });

  it('converts session_start to IDEEvent with workspace metadata', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline, {
      workspaceId: 'ws-1',
      languages: ['TypeScript', 'Python'],
      dependencies: ['react'],
    });

    const event: AgentLogEvent = {
      type: 'session_start',
      sessionId: 's1',
      timestamp: 1000,
      payload: { modelLimit: 256000 },
    };

    const written = sink.ingest(event);
    expect(written).toHaveLength(1);
    expect(written[0].eventType).toBe('session_start');
    expect(written[0].workspaceId).toBe('ws-1');
    expect(written[0].metadata.languages).toEqual(['TypeScript', 'Python']);
    expect(written[0].metadata.dependencies).toEqual(['react']);
  });

  it('splits llm_request into chat + completion', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline);

    const event: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 's1',
      timestamp: 2000,
      payload: { promptTokens: 1500, completionTokens: 400, model: 'gpt-5' },
    };

    const written = sink.ingest(event);
    expect(written).toHaveLength(2);
    expect(written[0].eventType).toBe('chat');
    expect(written[0].metadata.tokenCount).toBe(1500);
    expect(written[1].eventType).toBe('completion');
    expect(written[1].metadata.tokenCount).toBe(400);
  });

  it('generates unique prompt IDs across multiple llm_requests', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline);

    sink.ingest({ type: 'llm_request', sessionId: 's1', timestamp: 1, payload: { promptTokens: 100, completionTokens: 50 } });
    sink.ingest({ type: 'llm_request', sessionId: 's1', timestamp: 2, payload: { promptTokens: 200, completionTokens: 60 } });

    const events = ctx.eventStore.getBySession('s1');
    const chats = events.filter((e) => e.eventType === 'chat');
    expect(chats).toHaveLength(2);
    expect(chats[0].metadata.promptId).not.toBe(chats[1].metadata.promptId);
  });

  it('maps read_file tool_call to read_file IDEEvent', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline);

    sink.ingest({
      type: 'tool_call',
      sessionId: 's1',
      timestamp: 1000,
      payload: { tool: 'read_file', args: { path: 'src/index.ts' }, success: true },
    });

    const events = ctx.eventStore.getBySession('s1');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('read_file');
    expect(events[0].metadata.path).toBe('src/index.ts');
  });

  it('maps successful edit to accept, failed edit to retry', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline);

    sink.ingest({
      type: 'edit',
      sessionId: 's1',
      timestamp: 1000,
      payload: { file: 'src/index.ts', diffLines: 10, success: true },
    });
    sink.ingest({
      type: 'edit',
      sessionId: 's1',
      timestamp: 2000,
      payload: { file: 'src/index.ts', diffLines: 5, success: false },
    });

    const events = ctx.eventStore.getBySession('s1');
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe('accept');
    expect(events[1].eventType).toBe('retry');
  });

  it('triggers feature computation on session_end', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline);

    // Seed a minimal session
    sink.ingest({ type: 'session_start', sessionId: 's1', timestamp: 1, payload: {} });
    sink.ingest({ type: 'llm_request', sessionId: 's1', timestamp: 2, payload: { promptTokens: 100, completionTokens: 50 } });
    sink.ingest({ type: 'edit', sessionId: 's1', timestamp: 3, payload: { file: 'f.ts', diffLines: 1, success: true } });
    sink.ingest({ type: 'session_end', sessionId: 's1', timestamp: 4, payload: {} });

    const sessionFeat = ctx.featureStore.read('session', 's1');
    expect(sessionFeat).toBeDefined();
    expect(sessionFeat!.features.acceptCount).toBe(1);
    expect(sessionFeat!.features.completionCount).toBe(1);
  });
});
