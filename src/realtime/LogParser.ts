import type { AgentLogEvent } from '../types.js';

export interface LogParser {
  parse(line: string, sessionId: string): AgentLogEvent | undefined;
}

export class GenericJsonlParser implements LogParser {
  parse(line: string, sessionId: string): AgentLogEvent | undefined {
    try {
      const parsed = JSON.parse(line) as { type?: string; [key: string]: unknown };
      if (!parsed.type) return undefined;
      return {
        type: parsed.type,
        sessionId,
        timestamp: Date.now(),
        payload: parsed,
      } as AgentLogEvent;
    } catch {
      return undefined;
    }
  }
}

export class CopilotParser implements LogParser {
  parse(line: string, sessionId: string): AgentLogEvent | undefined {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const kind = String(parsed.kind ?? parsed.type ?? '');

      if (kind === 'request' || kind === 'llm_request') {
        return {
          type: 'llm_request',
          sessionId,
          timestamp: Date.now(),
          payload: {
            promptTokens: Number(parsed.promptTokens ?? parsed.tokens ?? 0),
            completionTokens: Number(parsed.completionTokens ?? 0),
            model: String(parsed.model ?? 'unknown'),
          },
        };
      }

      if (kind === 'tool_call' || kind === 'tool') {
        return {
          type: 'tool_call',
          sessionId,
          timestamp: Date.now(),
          payload: {
            tool: String(parsed.tool ?? parsed.name ?? 'unknown'),
            durationMs: Number(parsed.durationMs ?? parsed.duration ?? 0),
            success: parsed.success !== false,
            args: (parsed.args ?? parsed.arguments ?? {}) as Record<string, unknown>,
          },
        };
      }

      if (kind === 'edit' || kind === 'file_edit') {
        return {
          type: 'edit',
          sessionId,
          timestamp: Date.now(),
          payload: {
            file: String(parsed.file ?? parsed.path ?? 'unknown'),
            diffLines: Number(parsed.diffLines ?? 0),
            success: parsed.success !== false,
          },
        };
      }

      if (kind === 'session_start') {
        return {
          type: 'session_start',
          sessionId,
          timestamp: Date.now(),
          payload: {
            modelLimit: Number(parsed.modelLimit ?? 256000),
          },
        };
      }

      if (kind === 'session_end') {
        return {
          type: 'session_end',
          sessionId,
          timestamp: Date.now(),
          payload: parsed,
        };
      }

      return undefined;
    } catch {
      return undefined;
    }
  }
}
