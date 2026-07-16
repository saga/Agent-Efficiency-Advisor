// V6Sink — bridge realtime AgentLogEvent stream into V6 EventStore.
//
// Subscribes to the V2.5 event stream (MockLogSource / CopilotSource / TailManager),
// converts each AgentLogEvent into one or more IDEEvents, and writes them to SQLite.
// On session_end, triggers FeaturePipeline.computeSession() so features are
// available immediately for V6 analytics.
//
// This is the missing "online collection" piece — it closes the loop between
// the V2.5 realtime layer and the V6 store/embedding/ML/LLM/graph layers.

import type { AgentLogEvent } from '../types.js';
import type { IDEEvent, IDEEventType } from '../store/types.js';
import type { EventStore } from '../store/EventStore.js';
import type { FeaturePipeline } from '../store/FeaturePipeline.js';

export interface V6SinkOptions {
  workspaceId?: string;
  languages?: string[];
  dependencies?: string[];
}

export class V6Sink {
  private promptCounter = new Map<string, number>();
  private readonly workspaceId: string;
  private readonly languages: string[];
  private readonly dependencies: string[];

  constructor(
    private eventStore: EventStore,
    private pipeline: FeaturePipeline,
    options: V6SinkOptions = {}
  ) {
    this.workspaceId = options.workspaceId ?? 'realtime-workspace';
    this.languages = options.languages ?? ['TypeScript'];
    this.dependencies = options.dependencies ?? [];
  }

  /**
   * Ingest a single AgentLogEvent, convert to IDEEvent(s), write to SQLite.
   * Returns the IDEEvent(s) that were written.
   */
  ingest(event: AgentLogEvent): IDEEvent[] {
    const ideEvents = this.convert(event);
    if (ideEvents.length > 0) {
      this.eventStore.insertBatch(ideEvents);
    }

    // Trigger feature computation when session ends
    if (event.type === 'session_end') {
      try {
        this.pipeline.computeSession(event.sessionId);
      } catch (err) {
        // Feature computation failure shouldn't crash the realtime loop
        console.error(`[V6Sink] feature computation failed for ${event.sessionId}:`, err);
      }
    }

    return ideEvents;
  }

  /**
   * Manually trigger feature computation for a session. Useful for log sources
   * (e.g. real VSCode Copilot Agent Debug Logs) that do not emit a session_end
   * event when the file/session is finished.
   */
  flushSession(sessionId: string): void {
    try {
      this.pipeline.computeSession(sessionId);
    } catch (err) {
      console.error(`[V6Sink] feature computation failed for ${sessionId}:`, err);
    }
  }

  /**
   * Convert AgentLogEvent → IDEEvent(s).
   *
   * Mapping rules:
   *   session_start → session_start (with workspace metadata)
   *   session_end   → session_end
   *   llm_request   → chat + completion (split: prompt vs response)
   *   tool_call     → read_file | run_test | tool_call (based on tool name)
   *   edit (success: true)  → accept (user accepted the change)
   *   edit (success: false) → retry (user will retry the edit)
   */
  private convert(event: AgentLogEvent): IDEEvent[] {
    const base = {
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      workspaceId: this.workspaceId,
    };

    switch (event.type) {
      case 'session_start':
        return [{
          ...base,
          eventType: 'session_start' as IDEEventType,
          metadata: {
            model: (event.payload as Record<string, unknown>).model ?? 'unknown',
            modelLimit: (event.payload as Record<string, unknown>).modelLimit,
            languages: this.languages,
            dependencies: this.dependencies,
          },
        }];

      case 'session_end':
        return [{ ...base, eventType: 'session_end' as IDEEventType, metadata: {} }];

      case 'llm_request': {
        const promptId = this.nextPromptId(event.sessionId);
        const promptTokens = Number(event.payload.promptTokens ?? 0);
        const completionTokens = Number(event.payload.completionTokens ?? 0);
        return [
          {
            ...base,
            eventType: 'chat' as IDEEventType,
            metadata: {
              promptId,
              tokenCount: promptTokens,
              contextToken: promptTokens,
              historyToken: 0,
              retrievedFiles: 0,
            },
          },
          {
            ...base,
            eventType: 'completion' as IDEEventType,
            metadata: {
              tokenCount: completionTokens,
              model: event.payload.model ?? 'unknown',
            },
          },
        ];
      }

      case 'tool_call': {
        const tool = String(event.payload.tool ?? 'unknown');
        const args = (event.payload.args ?? {}) as Record<string, unknown>;

        // Map common tool names to V6 event types
        if (tool === 'read_file') {
          return [{
            ...base,
            eventType: 'read_file' as IDEEventType,
            metadata: { path: String(args.path ?? 'unknown') },
          }];
        }
        if (tool === 'run_test' || tool === 'test') {
          return [{
            ...base,
            eventType: 'run_test' as IDEEventType,
            metadata: {
              toolName: tool,
              passed: event.payload.success ?? false,
            },
          }];
        }
        if (tool === 'terminal' || tool === 'bash' || tool === 'shell') {
          return [{
            ...base,
            eventType: 'terminal' as IDEEventType,
            metadata: { toolName: tool },
          }];
        }
        if (tool === 'commit' || tool === 'git') {
          return [{
            ...base,
            eventType: 'commit' as IDEEventType,
            metadata: {
              toolName: tool,
              branch: String(args.branch ?? 'main'),
            },
          }];
        }
        // Generic tool call
        return [{
          ...base,
          eventType: 'tool_call' as IDEEventType,
          metadata: {
            toolName: tool,
            durationMs: event.payload.durationMs,
            success: event.payload.success,
          },
        }];
      }

      case 'edit': {
        const success = event.payload.success !== false;
        const file = String(event.payload.file ?? 'unknown');
        // Map edit outcomes to V6 accept/retry semantics:
        //   success: true  → accept (change was applied)
        //   success: false → retry (user will try again)
        return [{
          ...base,
          eventType: success ? ('accept' as IDEEventType) : ('retry' as IDEEventType),
          metadata: {
            file,
            diffLines: event.payload.diffLines ?? 0,
            // Keep original event type for debugging
            originalEventType: 'edit',
          },
        }];
      }

      default:
        // Unknown event types are skipped (could log if needed)
        return [];
    }
  }

  private nextPromptId(sessionId: string): string {
    const n = (this.promptCounter.get(sessionId) ?? 0) + 1;
    this.promptCounter.set(sessionId, n);
    return `${sessionId}-prompt-${n}`;
  }
}
