import type { AgentTrace, SessionState } from '../types.js';

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
