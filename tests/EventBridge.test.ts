// Tests for EventBridge — AgentLogEvent ↔ IDEEvent 转换桥接

import { describe, it, expect } from 'vitest';
import { agentLogEventToIDEEvent, agentLogEventsToIDEEvents } from '../src/realtime/EventBridge.js';
import type { AgentLogEvent, EditEvent, LLMRequestEvent, ToolCallEvent } from '../src/types.js';

describe('EventBridge', () => {
  it('converts session_start event', () => {
    const event: AgentLogEvent = {
      type: 'session_start',
      sessionId: 's1',
      timestamp: 1000,
      payload: { modelLimit: 256000 },
    };
    const ide = agentLogEventToIDEEvent(event, 'ws1');
    expect(ide.eventType).toBe('session_start');
    expect(ide.workspaceId).toBe('ws1');
    expect(ide.metadata.modelLimit).toBe(256000);
  });

  it('converts llm_request to completion', () => {
    const event: LLMRequestEvent = {
      type: 'llm_request',
      sessionId: 's1',
      timestamp: 2000,
      payload: { promptTokens: 5000, completionTokens: 800, model: 'gpt-5' },
    };
    const ide = agentLogEventToIDEEvent(event);
    expect(ide.eventType).toBe('completion');
    expect(ide.metadata.promptTokens).toBe(5000);
    expect(ide.metadata.completionTokens).toBe(800);
    expect(ide.metadata.model).toBe('gpt-5');
  });

  it('converts read_file tool_call', () => {
    const event: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 's1',
      timestamp: 3000,
      payload: { tool: 'read_file', durationMs: 50, success: true },
    };
    const ide = agentLogEventToIDEEvent(event);
    expect(ide.eventType).toBe('read_file');
    expect(ide.metadata.toolName).toBe('read_file');
    expect(ide.metadata.durationMs).toBe(50);
  });

  it('converts terminal tool_call', () => {
    const event: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 's1',
      timestamp: 3000,
      payload: { tool: 'terminal', success: true },
    };
    const ide = agentLogEventToIDEEvent(event);
    expect(ide.eventType).toBe('terminal');
  });

  it('converts unknown tool to tool_call', () => {
    const event: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 's1',
      timestamp: 3000,
      payload: { tool: 'custom_tool' },
    };
    const ide = agentLogEventToIDEEvent(event);
    expect(ide.eventType).toBe('tool_call');
  });

  it('converts successful edit to accept', () => {
    const event: EditEvent = {
      type: 'edit',
      sessionId: 's1',
      timestamp: 4000,
      payload: { file: 'src/app.ts', diffLines: 10, success: true },
    };
    const ide = agentLogEventToIDEEvent(event);
    expect(ide.eventType).toBe('accept');
    expect(ide.metadata.file).toBe('src/app.ts');
    expect(ide.metadata.diffLines).toBe(10);
  });

  it('converts failed edit to retry', () => {
    const event: EditEvent = {
      type: 'edit',
      sessionId: 's1',
      timestamp: 4000,
      payload: { file: 'src/app.ts', diffLines: 0, success: false },
    };
    const ide = agentLogEventToIDEEvent(event);
    expect(ide.eventType).toBe('retry');
  });

  it('converts batch events in chronological order', () => {
    const events: AgentLogEvent[] = [
      { type: 'session_start', sessionId: 's1', timestamp: 3000, payload: {} },
      { type: 'session_start', sessionId: 's1', timestamp: 1000, payload: {} },
      { type: 'session_end', sessionId: 's1', timestamp: 2000, payload: {} },
    ];
    const ides = agentLogEventsToIDEEvents(events);
    expect(ides).toHaveLength(3);
    expect(ides[0].timestamp).toBe(1000);
    expect(ides[1].timestamp).toBe(2000);
    expect(ides[2].timestamp).toBe(3000);
  });
});
