// Unified Event Model — the single source of truth for all sources
// (Copilot, Cursor, Continue, Claude Code, Git, MCP, terminal, editor).

export type IDEEventType =
  | 'open_file'
  | 'read_file'
  | 'edit'
  | 'completion'
  | 'accept'
  | 'reject'
  | 'retry'
  | 'tool_call'
  | 'terminal'
  | 'chat'
  | 'run_test'
  | 'commit'
  | 'session_start'
  | 'session_end'
  | 'error';

export interface IDEEvent {
  id?: number;
  timestamp: number;
  sessionId: string;
  workspaceId: string;
  eventType: IDEEventType;
  metadata: Record<string, unknown>;
}

// Feature row stored in SQLite. All feature tables share this shape:
// a primary key (entity id), a version, and a JSON blob of features.
export interface FeatureRow {
  entityId: string;
  version: number;
  computedAt: number;
  features: Record<string, number>;
}

export type FeatureDomain = 'workspace' | 'session' | 'prompt' | 'tool' | 'behavior';

export interface FeatureDefinition {
  name: string;
  domain: FeatureDomain;
  description: string;
  version: number;
  owner: string;
}

// Concrete feature shapes (documentation; actual storage is JSON blob)
export interface WorkspaceFeature {
  workspaceId: string;
  totalFiles: number;
  totalLOC: number;
  languageCount: number;
  dependencyCount: number;
  gitBranchCount: number;
}

export interface SessionFeature {
  sessionId: string;
  duration: number;
  completionCount: number;
  retryCount: number;
  acceptCount: number;
  rejectCount: number;
  acceptRate: number;
  retryRate: number;
}

export interface PromptFeature {
  promptId: string;
  tokenCount: number;
  historyLength: number;
  retrievedFiles: number;
  retrievedSymbols: number;
  promptDensity: number;
  historyRatio: number;
}

export interface ToolFeature {
  terminalCalls: number;
  gitCalls: number;
  mcpCalls: number;
  filesystemCalls: number;
}

// Behavior features — the high-value innovation from v6.md
export interface BehaviorFeature {
  avgReadBeforeAsk: number;
  avgRetryDistance: number;
  toolSwitchFrequency: number;
  contextExpansionSpeed: number;
  workflowEntropy: number;
  retryBurstScore: number;
  editAfterAcceptRatio: number;
  workflowLength: number;
}
