// Event sourcing reducer: events → immutable snapshot.
// Snapshots are never mutated; reducer returns a new snapshot per event.

import type { AgentPhase, PhaseTransition, RuntimeEvent, RuntimeSnapshot } from './types.js';

const DEFAULT_MODEL_LIMIT = 256000;
const RECENT_TOOLS_WINDOW = 12;

export function createInitialSnapshot(sessionId: string): RuntimeSnapshot {
  const now = Date.now();
  return {
    sessionId,
    version: 0,
    createdAt: now,
    updatedAt: now,
    phase: 'Idle',
    transitions: [],
    promptTokens: 0,
    completionTokens: 0,
    cacheTokens: 0,
    contextTokens: 0,
    modelLimit: DEFAULT_MODEL_LIMIT,
    toolCalls: 0,
    readFiles: 0,
    edits: 0,
    retries: 0,
    subAgents: 0,
    filesRead: [],
    filesEdited: [],
    recentTools: [],
    events: [],
  };
}

export function reduce(prev: RuntimeSnapshot, event: RuntimeEvent): RuntimeSnapshot {
  const events = [...prev.events, event];
  const base: RuntimeSnapshot = {
    ...prev,
    version: prev.version + 1,
    updatedAt: event.timestamp,
    events,
  };

  const nextPhase = derivePhase(prev.phase, event);
  if (nextPhase !== prev.phase) {
    const transition: PhaseTransition = {
      from: prev.phase,
      to: nextPhase,
      at: event.timestamp,
      event,
    };
    base.transitions = [...prev.transitions, transition];
    base.phase = nextPhase;
  }

  switch (event.type) {
    case 'session_start': {
      base.modelLimit = Number(event.payload.modelLimit ?? DEFAULT_MODEL_LIMIT);
      break;
    }
    case 'llm_request': {
      const promptTokens = Number(event.payload.promptTokens ?? 0);
      const completionTokens = Number(event.payload.completionTokens ?? 0);
      base.promptTokens = prev.promptTokens + promptTokens;
      base.completionTokens = prev.completionTokens + completionTokens;
      base.contextTokens = prev.contextTokens + promptTokens + completionTokens;
      if (event.payload.model) base.model = String(event.payload.model);
      break;
    }
    case 'tool_call': {
      base.toolCalls = prev.toolCalls + 1;
      const tool = String(event.payload.tool ?? '');
      base.recentTools = [...prev.recentTools, tool].slice(-RECENT_TOOLS_WINDOW);

      if (tool === 'read_file' || tool === 'readfile') {
        base.readFiles = prev.readFiles + 1;
        const args = event.payload.args as Record<string, unknown> | undefined;
        const file = String(args?.path ?? args?.file ?? '');
        if (file) base.filesRead = addToSet(prev.filesRead, file);
      }

      if (event.payload.success === false) {
        base.retries = prev.retries + 1;
      }
      break;
    }
    case 'edit': {
      base.edits = prev.edits + 1;
      const file = String(event.payload.file ?? 'unknown');
      base.filesEdited = addToSet(prev.filesEdited, file);
      if (event.payload.success === false) {
        base.retries = prev.retries + 1;
      }
      break;
    }
    case 'subagent_start': {
      base.subAgents = prev.subAgents + 1;
      break;
    }
    case 'session_end': {
      // phase already derived
      break;
    }
  }

  return base;
}

export function replay(events: RuntimeEvent[], sessionId?: string): RuntimeSnapshot {
  const sid = sessionId ?? events[0]?.sessionId ?? 'replay';
  let snap = createInitialSnapshot(sid);
  for (const event of events) {
    snap = reduce(snap, event);
  }
  return snap;
}

export function snapshotAt(events: RuntimeEvent[], version: number): RuntimeSnapshot | undefined {
  if (version < 0) return undefined;
  const slice = events.slice(0, version + 1);
  if (slice.length === 0) return undefined;
  return replay(slice);
}

function addToSet(arr: string[], value: string): string[] {
  return arr.includes(value) ? arr : [...arr, value];
}

function derivePhase(current: AgentPhase, event: RuntimeEvent): AgentPhase {
  switch (event.type) {
    case 'session_start':
      return 'Planning';
    case 'llm_request':
      return current === 'Planning' ? 'Thinking' : current;
    case 'tool_call':
      return 'CallingTool';
    case 'tool_result':
      return 'WaitingTool';
    case 'edit':
      return 'Editing';
    case 'review':
      return 'Reviewing';
    case 'session_end':
      return current === 'Failed' ? 'Failed' : 'Finished';
    case 'error':
      return 'Failed';
    default:
      return current;
  }
}
