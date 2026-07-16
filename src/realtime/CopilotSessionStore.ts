// CopilotSessionStore — read VSCode Copilot Chat session-state SQLite database
// and convert sessions/turns/files into IDEEvents for the V6+ pipeline.
//
// Location: ~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/session-store.db
// Complements debug-logs/main.jsonl: session-store gives high-level chat semantics
// (prompts, responses, repository, branch, cwd), while debug-logs give low-level
// execution traces (tokens, tool calls, model, duration).

import Database from 'better-sqlite3';
import type { IDEEvent, IDEEventType } from '../store/types.js';

export interface CopilotSessionStoreOptions {
  /** Path to session-store.db. Defaults to macOS default location. */
  dbPath?: string;
  /** Fallback workspace id when sessions.workspace_id is null. */
  defaultWorkspaceId?: string;
}

export interface CopilotSession {
  id: string;
  workspaceId: string | null;
  createdAt: number;
  updatedAt: number;
  agentName: string | null;
  summary: string | null;
  repository: string | null;
  branch: string | null;
  cwd: string | null;
}

export interface CopilotTurn {
  id: string;
  sessionId: string;
  turnIndex: number;
  userMessage: string | null;
  assistantResponse: string | null;
  timestamp: number;
}

export interface CopilotSessionFile {
  sessionId: string;
  filePath: string;
  toolName: string | null;
  turnIndex: number;
  firstSeenAt: number;
}

export class CopilotSessionStore {
  private readonly db: Database.Database;
  private readonly defaultWorkspaceId: string;

  constructor(options: CopilotSessionStoreOptions = {}) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/Users/saga';
    this.db = new Database(
      options.dbPath ?? `${home}/Library/Application Support/Code/User/globalStorage/github.copilot-chat/session-store.db`,
      { readonly: true }
    );
    this.defaultWorkspaceId = options.defaultWorkspaceId ?? 'copilot-default-workspace';
  }

  close(): void {
    this.db.close();
  }

  getSessionCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    return row.n;
  }

  getSessions(): CopilotSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions').all() as any[];
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      createdAt: toMs(r.created_at),
      updatedAt: toMs(r.updated_at),
      agentName: r.agent_name,
      summary: r.summary,
      repository: r.repository,
      branch: r.branch,
      cwd: r.cwd,
    }));
  }

  getTurns(sessionId: string): CopilotTurn[] {
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC')
      .all(sessionId) as any[];
    return rows.map((r) => ({
      id: String(r.id),
      sessionId: r.session_id,
      turnIndex: Number(r.turn_index ?? 0),
      userMessage: r.user_message,
      assistantResponse: r.assistant_response,
      timestamp: toMs(r.timestamp),
    }));
  }

  getSessionFiles(sessionId: string): CopilotSessionFile[] {
    const rows = this.db
      .prepare('SELECT * FROM session_files WHERE session_id = ? ORDER BY first_seen_at ASC')
      .all(sessionId) as any[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      filePath: r.file_path,
      toolName: r.tool_name,
      turnIndex: Number(r.turn_index ?? 0),
      firstSeenAt: toMs(r.first_seen_at),
    }));
  }

  /**
   * Convert a single Copilot session into a chronologically ordered list of IDEEvent.
   */
  toIDEEvents(session: CopilotSession): IDEEvent[] {
    const workspaceId = session.workspaceId ?? this.inferWorkspaceId(session);
    const events: IDEEvent[] = [];

    // 1. Session start
    events.push({
      timestamp: session.createdAt,
      sessionId: session.id,
      workspaceId,
      eventType: 'session_start' as IDEEventType,
      metadata: {
        agentName: session.agentName,
        repository: session.repository,
        branch: session.branch,
        cwd: session.cwd,
        summary: session.summary,
        source: 'copilot-session-store',
      },
    });

    // 2. Files referenced before/in the session
    for (const f of this.getSessionFiles(session.id)) {
      events.push({
        timestamp: f.firstSeenAt,
        sessionId: session.id,
        workspaceId,
        eventType: 'read_file' as IDEEventType,
        metadata: {
          path: f.filePath,
          toolName: f.toolName,
          turnIndex: f.turnIndex,
          source: 'copilot-session-store',
        },
      });
    }

    // 3. Turns → chat + completion pairs
    const turns = this.getTurns(session.id);
    for (const turn of turns) {
      const promptId = `${session.id}-turn-${turn.turnIndex}`;

      if (turn.userMessage) {
        events.push({
          timestamp: turn.timestamp,
          sessionId: session.id,
          workspaceId,
          eventType: 'chat' as IDEEventType,
          metadata: {
            promptId,
            turnIndex: turn.turnIndex,
            messageLength: turn.userMessage.length,
            source: 'copilot-session-store',
          },
        });
      }

      if (turn.assistantResponse) {
        events.push({
          timestamp: turn.timestamp + 1,
          sessionId: session.id,
          workspaceId,
          eventType: 'completion' as IDEEventType,
          metadata: {
            promptId,
            turnIndex: turn.turnIndex,
            responseLength: turn.assistantResponse.length,
            source: 'copilot-session-store',
          },
        });
      }
    }

    // 4. Session end
    events.push({
      timestamp: session.updatedAt,
      sessionId: session.id,
      workspaceId,
      eventType: 'session_end' as IDEEventType,
      metadata: {
        duration: session.updatedAt - session.createdAt,
        turnCount: turns.length,
        source: 'copilot-session-store',
      },
    });

    // Already ordered because we construct in chronological order, but guard anyway.
    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Convert all sessions to IDEEvents.
   */
  toAllIDEEvents(): IDEEvent[] {
    const events: IDEEvent[] = [];
    for (const session of this.getSessions()) {
      events.push(...this.toIDEEvents(session));
    }
    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  private inferWorkspaceId(session: CopilotSession): string {
    if (session.repository) return `repo:${session.repository}`;
    if (session.cwd) return `cwd:${session.cwd}`;
    return this.defaultWorkspaceId;
  }
}

function toMs(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Date.parse(value);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}
