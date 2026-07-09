import type { AgentLogEvent, SessionState } from '../types.js';
import { createSessionState, updateState } from './SessionState.js';

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  get(sessionId: string): SessionState {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, createSessionState(sessionId));
    }
    return this.sessions.get(sessionId)!;
  }

  apply(event: AgentLogEvent): SessionState {
    const state = this.get(event.sessionId);
    return updateState(state, event);
  }

  all(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  reset(): void {
    this.sessions.clear();
  }
}
