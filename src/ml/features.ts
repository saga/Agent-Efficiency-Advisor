import type { AgentTrace, SessionState } from '../types.js';
import type { IDEEvent } from '../store/types.js';

export interface ModelSizeFeatures {
  promptTokens: number;
  completionTokens: number;
  contextTokens: number;
  toolCalls: number;
  readFiles: number;
  edits: number;
  retries: number;
  uniqueFilesRead: number;
  uniqueFilesEdited: number;
  elapsedMs: number;
  contextUtilization: number;
  readToEditRatio: number;
  retryRate: number;
  hasLoop: number;
  subAgents: number;
}

export type ModelSizeLabel = 'mini' | 'medium' | 'large';

export const LABEL_INDEX: Record<ModelSizeLabel, number> = {
  mini: 0,
  medium: 1,
  large: 2,
};

export const INDEX_LABEL: Record<number, ModelSizeLabel> = {
  0: 'mini',
  1: 'medium',
  2: 'large',
};

export const FEATURE_COLUMNS: (keyof ModelSizeFeatures)[] = [
  'promptTokens',
  'completionTokens',
  'contextTokens',
  'toolCalls',
  'readFiles',
  'edits',
  'retries',
  'uniqueFilesRead',
  'uniqueFilesEdited',
  'elapsedMs',
  'contextUtilization',
  'readToEditRatio',
  'retryRate',
  'hasLoop',
  'subAgents',
];

export function extractModelSizeFeatures(state: SessionState): ModelSizeFeatures {
  const readToEditRatio = state.edits > 0 ? state.readFiles / state.edits : state.readFiles;
  const retryRate = state.toolCalls > 0 ? state.retries / state.toolCalls : 0;
  const hasLoop = detectLoop(state.toolSequence) ? 1 : 0;

  return {
    promptTokens: state.promptTokens,
    completionTokens: state.completionTokens,
    contextTokens: state.contextTokens,
    toolCalls: state.toolCalls,
    readFiles: state.readFiles,
    edits: state.edits,
    retries: state.retries,
    uniqueFilesRead: state.filesRead.size,
    uniqueFilesEdited: state.filesEdited.size,
    elapsedMs: state.elapsedMs,
    contextUtilization: state.modelLimit > 0 ? state.contextTokens / state.modelLimit : 0,
    readToEditRatio,
    retryRate,
    hasLoop,
    subAgents: state.subAgents,
  };
}

export function extractModelSizeFeaturesFromTrace(trace: AgentTrace): ModelSizeFeatures {
  const totalTokens = trace.inputTokens + trace.outputTokens;
  const toolCalls = trace.toolCalls.length;
  const uniqueFilesRead = new Set(trace.filesChanged).size;

  return {
    promptTokens: trace.inputTokens,
    completionTokens: trace.outputTokens,
    contextTokens: trace.contextTokens,
    toolCalls,
    readFiles: toolCalls,
    edits: uniqueFilesRead,
    retries: 0,
    uniqueFilesRead,
    uniqueFilesEdited: uniqueFilesRead,
    elapsedMs: 0,
    contextUtilization: trace.contextTokens / 256000,
    readToEditRatio: uniqueFilesRead > 0 ? toolCalls / uniqueFilesRead : toolCalls,
    retryRate: 0,
    hasLoop: 0,
    subAgents: 0,
  };
}

/**
 * Extract ModelSizeFeatures from a chronologically ordered list of IDEEvent.
 * This bridges the V6 Event Store / Feature Store back to the model-size
 * classifier feature schema, enabling training on real observed sessions.
 */
export function extractModelSizeFeaturesFromEvents(events: IDEEvent[]): ModelSizeFeatures | null {
  if (events.length === 0) return null;

  const startEvent = events.find((e) => e.eventType === 'session_start');
  const endEvent = events.find((e) => e.eventType === 'session_end');
  const modelLimit = Number(startEvent?.metadata?.modelLimit ?? 256000);

  let promptTokens = 0;
  let completionTokens = 0;
  let contextTokens = 0;
  let toolCalls = 0;
  let readFiles = 0;
  let edits = 0;
  let retries = 0;
  let subAgents = 0;
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const toolSequence: string[] = [];

  for (const e of events) {
    const m = e.metadata ?? {};
    switch (e.eventType) {
      case 'chat':
        promptTokens += Number(m.tokenCount ?? m.contextToken ?? m.messageLength ?? 0);
        break;
      case 'completion':
        completionTokens += Number(m.tokenCount ?? m.responseLength ?? 0);
        break;
      case 'tool_call': {
        toolCalls++;
        const toolName = String(m.toolName ?? m.tool ?? 'unknown');
        toolSequence.push(toolName);
        if (m.path && typeof m.path === 'string') {
          readFiles++;
          filesRead.add(m.path);
        }
        break;
      }
      case 'read_file':
        readFiles++;
        if (m.path && typeof m.path === 'string') filesRead.add(m.path);
        break;
      case 'edit':
      case 'accept':
        // V6Sink maps a successful edit to an 'accept' IDEEvent; count both
        // as edits so real-time sessions feed the model-size feature schema.
        edits++;
        if (m.file && typeof m.file === 'string') filesEdited.add(m.file);
        if (m.path && typeof m.path === 'string') filesEdited.add(m.path);
        break;
      case 'retry':
        retries++;
        break;
      case 'terminal':
        subAgents += Number(m.subAgents ?? 0);
        break;
    }
  }

  // Derive contextTokens as prompt + completion if not directly observed.
  contextTokens = contextTokens || promptTokens + completionTokens;

  const startTime = events[0]?.timestamp ?? 0;
  const endTime = endEvent?.timestamp ?? events[events.length - 1]?.timestamp ?? startTime;
  const elapsedMs = Math.max(0, endTime - startTime);

  const readToEditRatio = edits > 0 ? readFiles / edits : readFiles;
  const retryRate = toolCalls > 0 ? retries / toolCalls : 0;

  return {
    promptTokens,
    completionTokens,
    contextTokens,
    toolCalls,
    readFiles,
    edits,
    retries,
    uniqueFilesRead: filesRead.size,
    uniqueFilesEdited: filesEdited.size,
    elapsedMs,
    contextUtilization: modelLimit > 0 ? contextTokens / modelLimit : 0,
    readToEditRatio,
    retryRate,
    hasLoop: detectLoop(toolSequence) ? 1 : 0,
    subAgents,
  };
}

function detectLoop(sequence: string[]): boolean {
  if (sequence.length < 8) return false;
  for (let len = 2; len <= 5; len++) {
    const tail = sequence.slice(-len * 3);
    let repeats = 1;
    for (let i = len; i < tail.length; i += len) {
      const a = tail.slice(i - len, i).join(',');
      const b = tail.slice(i, i + len).join(',');
      if (a === b) repeats++;
      else break;
    }
    if (repeats >= 3) return true;
  }
  return false;
}
