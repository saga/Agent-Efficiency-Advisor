import type { AgentLogEvent, SessionState } from '../types.js';

const DEFAULT_MODEL_LIMIT = 256000;
const BYTES_PER_TOKEN_ESTIMATE = 4;

export function createSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    startedAt: Date.now(),
    promptTokens: 0,
    completionTokens: 0,
    cacheTokens: 0,
    toolCalls: 0,
    readFiles: 0,
    edits: 0,
    retries: 0,
    contextBytes: 0,
    contextTokens: 0,
    modelLimit: DEFAULT_MODEL_LIMIT,
    subAgents: 0,
    elapsedMs: 0,
    toolSequence: [],
    filesRead: new Set(),
    filesEdited: new Set(),
    events: [],
  };
}

export function updateState(state: SessionState, event: AgentLogEvent): SessionState {
  state.events.push(event);
  state.elapsedMs = Date.now() - state.startedAt;

  switch (event.type) {
    case 'session_start': {
      state.modelLimit = Number(event.payload.modelLimit ?? DEFAULT_MODEL_LIMIT);
      break;
    }
    case 'llm_request': {
      const promptTokens = Number(event.payload.promptTokens ?? 0);
      const completionTokens = Number(event.payload.completionTokens ?? 0);
      state.promptTokens += promptTokens;
      state.completionTokens += completionTokens;
      state.contextTokens += promptTokens + completionTokens;
      state.contextBytes = state.contextTokens * BYTES_PER_TOKEN_ESTIMATE;
      break;
    }
    case 'tool_call': {
      state.toolCalls += 1;
      state.toolSequence.push(String(event.payload.tool));
      const tool = String(event.payload.tool ?? '').toLowerCase();
      if (tool === 'read_file' || tool === 'readfile') {
        state.readFiles += 1;
        const args = event.payload.args as Record<string, unknown> | undefined;
        const path = String(args?.path ?? args?.file ?? '');
        if (path) state.filesRead.add(path);
      }
      if (event.payload.success === false) {
        state.retries += 1;
      }
      break;
    }
    case 'edit': {
      state.edits += 1;
      const file = String(event.payload.file ?? 'unknown');
      state.filesEdited.add(file);
      if (event.payload.success === false) {
        state.retries += 1;
      }
      break;
    }
  }

  return state;
}
