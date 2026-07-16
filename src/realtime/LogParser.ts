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

      // Real VSCode Copilot Agent Debug Log format (v7+): ts/dur/sid/type/attrs
      if (this.isRealCopilotFormat(parsed)) {
        return this.parseRealCopilotEvent(parsed, sessionId);
      }

      // Legacy / synthetic AEA debug format: flat kind/type with token/tool fields
      return this.parseLegacyEvent(parsed, sessionId);
    } catch {
      return undefined;
    }
  }

  private isRealCopilotFormat(parsed: Record<string, unknown>): boolean {
    return (
      typeof parsed.ts === 'number' &&
      typeof parsed.sid === 'string' &&
      typeof parsed.type === 'string' &&
      parsed.attrs !== undefined &&
      typeof parsed.attrs === 'object'
    );
  }

  private parseRealCopilotEvent(parsed: Record<string, unknown>, fallbackSessionId: string): AgentLogEvent | undefined {
    const ts = Number(parsed.ts ?? Date.now());
    const sid = String(parsed.sid ?? fallbackSessionId);
    const type = String(parsed.type ?? '');
    const dur = Number(parsed.dur ?? 0);
    const status = String(parsed.status ?? 'ok');
    const attrs = (parsed.attrs ?? {}) as Record<string, unknown>;
    const success = status === 'ok';

    switch (type) {
      case 'session_start':
        return {
          type: 'session_start',
          sessionId: sid,
          timestamp: ts,
          payload: {
            modelLimit: Number(attrs.modelLimit ?? 256000),
            model: String(attrs.model ?? 'unknown'),
            copilotVersion: String(attrs.copilotVersion ?? 'unknown'),
            vscodeVersion: String(attrs.vscodeVersion ?? 'unknown'),
          },
        };

      case 'session_end':
        return {
          type: 'session_end',
          sessionId: sid,
          timestamp: ts,
          payload: attrs,
        };

      case 'llm_request': {
        const inputTokens = Number(attrs.inputTokens ?? 0);
        const outputTokens = Number(attrs.outputTokens ?? 0);
        const cachedTokens = Number(attrs.cachedTokens ?? 0);
        return {
          type: 'llm_request',
          sessionId: sid,
          timestamp: ts,
          payload: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            cachedTokens,
            model: String(attrs.model ?? 'unknown'),
            debugName: String(attrs.debugName ?? ''),
            ttft: Number(attrs.ttft ?? 0),
          },
        };
      }

      case 'tool_call': {
        // Real Copilot logs put the tool name in the top-level `name` field.
        const toolName = String(parsed.name ?? attrs.name ?? 'unknown');
        const args = this.parseArgs(attrs.args ?? attrs.arguments ?? '{}');
        return {
          type: 'tool_call',
          sessionId: sid,
          timestamp: ts,
          payload: {
            tool: toolName,
            durationMs: dur,
            success,
            args,
          },
        };
      }

      case 'agent_response': {
        // Best-effort: detect file-edit intent from assistant response parts.
        const responseText = String(attrs.response ?? '');
        const fileEdit = this.extractFileEdit(responseText);
        if (fileEdit) {
          return {
            type: 'edit',
            sessionId: sid,
            timestamp: ts,
            payload: {
              file: fileEdit.file,
              diffLines: fileEdit.diffLines,
              success,
            },
          };
        }
        return undefined;
      }

      case 'user_message':
      case 'turn_start':
      case 'turn_end':
      case 'generic':
      case 'discovery':
      case 'child_session_ref':
      default:
        // These event types are intentionally skipped for the realtime V2.5 pipeline.
        return undefined;
    }
  }

  private parseLegacyEvent(parsed: Record<string, unknown>, sessionId: string): AgentLogEvent | undefined {
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
  }

  private parseArgs(raw: unknown): Record<string, unknown> {
    if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return { raw };
      }
    }
    return {};
  }

  private extractFileEdit(responseText: string): { file: string; diffLines: number } | undefined {
    // Best-effort: detect file-edit intent from assistant response parts.
    // The response is a JSON string of [{ role, parts: [{ type, name, arguments }] }].
    let parts: unknown[] = [];
    try {
      const parsed = JSON.parse(responseText) as unknown;
      if (Array.isArray(parsed)) {
        parts = parsed.flatMap((msg: unknown) => {
          const p = (msg as Record<string, unknown>)?.parts;
          return Array.isArray(p) ? p : [];
        });
      }
    } catch {
      // Fall back to regex heuristic if JSON parsing fails.
      const editMatch = responseText.match(/"name"\s*:\s*"(edit_file|apply_edit|write_to_file)"/);
      if (!editMatch) return undefined;
      const fileMatch = responseText.match(/"filePath"\s*:\s*"([^"]+)"/);
      const file = fileMatch?.[1] ?? 'unknown';
      const diffLines = (responseText.match(/\\n/g) ?? []).length;
      return { file, diffLines };
    }

    for (const part of parts) {
      const p = part as Record<string, unknown>;
      const name = String(p.name ?? '');
      if (['edit_file', 'apply_edit', 'write_to_file'].includes(name)) {
        const args = this.parseArgs(p.arguments ?? '{}');
        const file = String(args.filePath ?? args.path ?? args.file ?? 'unknown');
        return { file, diffLines: 0 };
      }
    }
    return undefined;
  }
}
