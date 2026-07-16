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

  // 测试 run_test 工具调用转换
  it('maps run_test tool_call to run_test IDEEvent', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline);

    sink.ingest({
      type: 'tool_call',
      sessionId: 's1',
      timestamp: 1000,
      payload: { tool: 'run_test', args: { command: 'npm test' }, success: true },
    });

    const events = ctx.eventStore.getBySession('s1');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('run_test');
    expect(events[0].metadata.passed).toBe(true);
    expect(events[0].metadata.toolName).toBe('run_test');
  });

  // 测试 terminal 工具调用转换
  it('maps terminal tool_call to terminal IDEEvent', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline);

    sink.ingest({
      type: 'tool_call',
      sessionId: 's1',
      timestamp: 1000,
      payload: { tool: 'terminal', args: { command: 'ls -la' }, success: true },
    });

    const events = ctx.eventStore.getBySession('s1');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('terminal');
    expect(events[0].metadata.toolName).toBe('terminal');
  });

  // 测试 commit 工具调用转换
  it('maps commit tool_call to commit IDEEvent', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline);

    sink.ingest({
      type: 'tool_call',
      sessionId: 's1',
      timestamp: 1000,
      payload: { tool: 'commit', args: { branch: 'feature/x' }, success: true },
    });

    const events = ctx.eventStore.getBySession('s1');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('commit');
    expect(events[0].metadata.toolName).toBe('commit');
    expect(events[0].metadata.branch).toBe('feature/x');
  });

  // 测试未知工具调用回退为通用 tool_call 事件
  it('maps unknown tool_call to generic tool_call IDEEvent', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline);

    sink.ingest({
      type: 'tool_call',
      sessionId: 's1',
      timestamp: 1000,
      payload: { tool: 'custom_tool', args: {}, success: true, durationMs: 200 },
    });

    const events = ctx.eventStore.getBySession('s1');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('tool_call');
    expect(events[0].metadata.toolName).toBe('custom_tool');
    expect(events[0].metadata.durationMs).toBe(200);
  });

  // 测试 flushSession 手动触发特征计算
  it('flushSession manually triggers feature computation', () => {
    const sink = new V6Sink(ctx.eventStore, ctx.pipeline);

    // 写入最小会话,但不发送 session_end
    sink.ingest({ type: 'session_start', sessionId: 's1', timestamp: 1, payload: {} });
    sink.ingest({ type: 'llm_request', sessionId: 's1', timestamp: 2, payload: { promptTokens: 100, completionTokens: 50 } });
    sink.ingest({ type: 'edit', sessionId: 's1', timestamp: 3, payload: { file: 'f.ts', diffLines: 1, success: true } });

    // 此时还未计算 session 特征
    let sessionFeat = ctx.featureStore.read('session', 's1');
    expect(sessionFeat).toBeUndefined();

    // 手动 flush 触发计算
    sink.flushSession('s1');

    sessionFeat = ctx.featureStore.read('session', 's1');
    expect(sessionFeat).toBeDefined();
    expect(sessionFeat!.features.acceptCount).toBe(1);
    expect(sessionFeat!.features.completionCount).toBe(1);
  });
});
