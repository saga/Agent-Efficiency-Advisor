// 桥接模块 — AgentLogEvent (V2.5) 与 IDEEvent (V6) 之间的转换
//
// AgentLogEvent 是 V2.5 realtime 层的核心类型,被 20+ 文件使用。
// IDEEvent 是 V6 EventStore 的统一事件模型。
// V6Sink 已在内部做这个转换;此模块把转换逻辑抽出来作为公共 API,
// 让其他需要桥接的代码(如 analytics、training)可以直接复用。
//
// 长期目标:V2.5 realtime 层完全迁移到 IDEEvent 后,此模块可删除。

import type { AgentLogEvent, EditEvent, LLMRequestEvent, ToolCallEvent } from '../types.js';
import type { IDEEvent, IDEEventType } from '../store/types.js';

/**
 * 把一个 AgentLogEvent 转换为 IDEEvent。
 * @param event V2.5 AgentLogEvent
 * @param workspaceId 工作区 ID(可选,默认 'default')
 */
export function agentLogEventToIDEEvent(
  event: AgentLogEvent,
  workspaceId = 'default',
): IDEEvent {
  const base = {
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    workspaceId,
    metadata: { ...event.payload } as Record<string, unknown>,
  };

  switch (event.type) {
    case 'session_start':
      return { ...base, eventType: 'session_start' as IDEEventType };

    case 'session_end':
      return { ...base, eventType: 'session_end' as IDEEventType };

    case 'llm_request': {
      const payload = (event as LLMRequestEvent).payload;
      return {
        ...base,
        eventType: 'completion' as IDEEventType,
        metadata: {
          ...base.metadata,
          promptTokens: payload.promptTokens,
          completionTokens: payload.completionTokens ?? 0,
          model: payload.model,
        },
      };
    }

    case 'tool_call': {
      const payload = (event as ToolCallEvent).payload;
      const toolName = payload.tool;
      // 把已知工具映射到具体 IDEEventType,其余归为 tool_call
      const eventType: IDEEventType = mapToolToEventType(toolName);
      return {
        ...base,
        eventType,
        metadata: {
          ...base.metadata,
          toolName,
          durationMs: payload.durationMs,
          success: payload.success,
          args: payload.args,
        },
      };
    }

    case 'edit': {
      const payload = (event as EditEvent).payload;
      return {
        ...base,
        eventType: payload.success === false ? 'retry' : 'accept',
        metadata: {
          ...base.metadata,
          file: payload.file,
          diffLines: payload.diffLines,
          success: payload.success,
        },
      };
    }

    default:
      return { ...base, eventType: 'tool_call' as IDEEventType };
  }
}

/**
 * 把批量 AgentLogEvent 转换为 IDEEvent 流。
 */
export function agentLogEventsToIDEEvents(
  events: AgentLogEvent[],
  workspaceId = 'default',
): IDEEvent[] {
  return events
    .map((e) => agentLogEventToIDEEvent(e, workspaceId))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** 工具名 → IDEEventType 映射 */
function mapToolToEventType(tool: string): IDEEventType {
  switch (tool) {
    case 'read_file':
    case 'open_file':
      return 'read_file';
    case 'edit':
    case 'write_file':
      return 'edit';
    case 'run_test':
      return 'run_test';
    case 'commit':
      return 'commit';
    case 'terminal':
    case 'run_command':
      return 'terminal';
    default:
      return 'tool_call';
  }
}
