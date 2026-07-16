// TranscriptParser — parse VSCode Copilot transcript JSONL files into IDEEvents.
//
// Transcripts live at:
//   workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<session-id>.jsonl
//
// Each line is a structured event with type/data/id/timestamp/parentId.
// Key event types:
//   session.start          → session_start (with copilotVersion, vscodeVersion)
//   user.message           → chat (with messageLength, content)
//   assistant.message      → completion (with responseLength, toolRequests)
//   assistant.turn_start   → (metadata marker, no IDEEvent)
//   assistant.turn_end     → (metadata marker, no IDEEvent)
//   tool.execution_start   → tool_call (with toolName, arguments)
//   tool.execution_complete→ accept (success=true) | retry (success=false)
//
// The tool.execution_complete success/fail signal is the highest-value
// behavior signal — it tells us whether the model's tool call was accepted
// by the user/system, which is a direct supervision signal.

import fs from 'node:fs';
import path from 'node:path';
import type { IDEEvent, IDEEventType } from '../store/types.js';

export interface TranscriptEntry {
  type: string;
  data: Record<string, unknown>;
  id: string;
  timestamp: string;
  parentId: string | null;
}

export interface ParsedSession {
  sessionId: string;
  workspaceId: string;
  events: IDEEvent[];
  copilotVersion?: string;
  vscodeVersion?: string;
  startTime: number;
  endTime: number;
}

export class TranscriptParser {
  /**
   * Parse a single transcript JSONL file into IDEEvents.
   */
  parseFile(filePath: string): ParsedSession | null {
    if (!fs.existsSync(filePath)) return null;

    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
    const entries: TranscriptEntry[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as TranscriptEntry;
        if (obj.type && obj.data && obj.timestamp) {
          entries.push(obj);
        }
      } catch {
        // skip invalid JSON
      }
    }

    if (entries.length === 0) return null;
    return this.parseEntries(entries, filePath);
  }

  /**
   * Parse all transcript files in a workspaceStorage directory.
   */
  parseDirectory(workspaceStorageDir: string): ParsedSession[] {
    const pattern = 'GitHub.copilot-chat/transcripts';
    const results: ParsedSession[] = [];

    const scan = (dir: string, depth: number) => {
      if (depth > 3) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full.includes(pattern)) {
            const files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'));
            for (const f of files) {
              const parsed = this.parseFile(path.join(full, f));
              if (parsed) results.push(parsed);
            }
          } else {
            scan(full, depth + 1);
          }
        }
      }
    };

    scan(workspaceStorageDir, 0);
    return results;
  }

  private parseEntries(entries: TranscriptEntry[], filePath: string): ParsedSession {
    const events: IDEEvent[] = [];
    let sessionId = '';
    let workspaceId = 'transcript-workspace';
    let copilotVersion: string | undefined;
    let vscodeVersion: string | undefined;
    let startTime = 0;
    let endTime = 0;

    // Track tool execution start times for duration calculation
    const toolStartTimes = new Map<string, { toolName: string; startTime: number; args: Record<string, unknown> }>();

    // Track turn count
    let turnCount = 0;

    for (const entry of entries) {
      const ts = Date.parse(entry.timestamp);
      if (Number.isNaN(ts)) continue;
      if (startTime === 0) startTime = ts;
      endTime = ts;

      const data = entry.data;
      const baseEvent = {
        timestamp: ts,
        sessionId: '',
        workspaceId,
      };

      switch (entry.type) {
        case 'session.start': {
          sessionId = String(data.sessionId ?? path.basename(filePath, '.jsonl'));
          copilotVersion = String(data.copilotVersion ?? '');
          vscodeVersion = String(data.vscodeVersion ?? '');
          const event: IDEEvent = {
            ...baseEvent,
            sessionId,
            eventType: 'session_start' as IDEEventType,
            metadata: {
              copilotVersion,
              vscodeVersion,
              producer: String(data.producer ?? 'copilot-agent'),
              source: 'transcript',
            },
          };
          events.push(event);
          break;
        }

        case 'user.message': {
          if (!sessionId) sessionId = path.basename(filePath, '.jsonl');
          const content = String(data.content ?? '');
          const attachments = Array.isArray(data.attachments) ? data.attachments : [];
          const event: IDEEvent = {
            ...baseEvent,
            sessionId,
            eventType: 'chat' as IDEEventType,
            metadata: {
              messageLength: content.length,
              turnIndex: turnCount,
              attachmentCount: attachments.length,
              source: 'transcript',
            },
          };
          events.push(event);
          break;
        }

        case 'assistant.message': {
          const content = String(data.content ?? '');
          const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];

          // Extract tool calls from toolRequests
          for (const req of toolRequests) {
            const r = req as Record<string, unknown>;
            const toolName = String(r.name ?? 'unknown');
            const toolCallId = String(r.toolCallId ?? '');
            const argsRaw = r.arguments;
            let args: Record<string, unknown> = {};
            if (typeof argsRaw === 'string') {
              try { args = JSON.parse(argsRaw) as Record<string, unknown>; } catch { args = { raw: argsRaw }; }
            } else if (typeof argsRaw === 'object' && argsRaw !== null) {
              args = argsRaw as Record<string, unknown>;
            }

            const toolEvent: IDEEvent = {
              ...baseEvent,
              sessionId,
              eventType: 'tool_call' as IDEEventType,
              metadata: {
                toolName,
                toolCallId,
                args,
                source: 'transcript',
              },
            };
            events.push(toolEvent);
          }

          const completionEvent: IDEEvent = {
            ...baseEvent,
            sessionId,
            eventType: 'completion' as IDEEventType,
            metadata: {
              responseLength: content.length,
              toolRequestCount: toolRequests.length,
              turnIndex: turnCount,
              source: 'transcript',
            },
          };
          events.push(completionEvent);
          break;
        }

        case 'assistant.turn_start': {
          turnCount = Number(data.turnId ?? turnCount);
          break;
        }

        case 'assistant.turn_end': {
          // Turn boundary — no IDEEvent needed, but could be used for timing
          break;
        }

        case 'tool.execution_start': {
          const toolCallId = String(data.toolCallId ?? '');
          const toolName = String(data.toolName ?? 'unknown');
          const args = (data.arguments ?? {}) as Record<string, unknown>;
          toolStartTimes.set(toolCallId, { toolName, startTime: ts, args });

          // If it's a file read, emit read_file event
          if (toolName === 'read_file' || toolName === 'read') {
            const filePath = String(args.filePath ?? args.path ?? 'unknown');
            const event: IDEEvent = {
              ...baseEvent,
              sessionId,
              eventType: 'read_file' as IDEEventType,
              metadata: {
                path: filePath,
                toolName,
                toolCallId,
                source: 'transcript',
              },
            };
            events.push(event);
          }
          break;
        }

        case 'tool.execution_complete': {
          const toolCallId = String(data.toolCallId ?? '');
          const success = data.success === true;
          const startInfo = toolStartTimes.get(toolCallId);

          if (startInfo) {
            const durationMs = ts - startInfo.startTime;
            toolStartTimes.delete(toolCallId);

            // Determine if this was a file edit
            const args = startInfo.args;
            let filePath = String(args.filePath ?? args.path ?? args.file ?? '');
            // multi_replace_string_in_file stores filePath in replacements[0].filePath
            if (!filePath && startInfo.toolName === 'multi_replace_string_in_file') {
              const replacements = args.replacements as Array<Record<string, unknown>> | undefined;
              if (Array.isArray(replacements) && replacements.length > 0) {
                filePath = String(replacements[0]?.filePath ?? '');
              }
            }

            if (filePath && [
            'edit_file', 'apply_edit', 'write_to_file', 'create_file', 'insert_edit',
            'replace_string_in_file', 'multi_replace_string_in_file',
          ].includes(startInfo.toolName)) {
              // File edit → accept or retry based on success
              const eventType: IDEEventType = success ? 'accept' : 'retry';
              const event: IDEEvent = {
                ...baseEvent,
                sessionId,
                eventType,
                metadata: {
                  file: filePath,
                  toolName: startInfo.toolName,
                  durationMs,
                  success,
                  source: 'transcript',
                },
              };
              events.push(event);
            } else {
              // Generic tool completion → accept/retry as behavior signal
              const eventType: IDEEventType = success ? 'accept' : 'retry';
              const event: IDEEvent = {
                ...baseEvent,
                sessionId,
                eventType,
                metadata: {
                  toolName: startInfo.toolName,
                  toolCallId,
                  durationMs,
                  success,
                  source: 'transcript',
                },
              };
              events.push(event);
            }
          }
          break;
        }
      }
    }

    // Sort by timestamp
    events.sort((a, b) => a.timestamp - b.timestamp);

    // Add session_end if not present
    const hasSessionEnd = events.some((e) => e.eventType === 'session_end');
    if (!hasSessionEnd && events.length > 0) {
      events.push({
        timestamp: endTime,
        sessionId,
        workspaceId,
        eventType: 'session_end' as IDEEventType,
        metadata: {
          duration: endTime - startTime,
          turnCount,
          source: 'transcript',
        },
      });
    }

    return {
      sessionId: sessionId || path.basename(filePath, '.jsonl'),
      workspaceId,
      events,
      copilotVersion,
      vscodeVersion,
      startTime,
      endTime,
    };
  }
}
