// Real-time observability types for AI coding agents.

export interface LogEvent {
  type: string;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface LLMRequestEvent extends LogEvent {
  type: 'llm_request';
  payload: {
    promptTokens: number;
    completionTokens?: number;
    model?: string;
  };
}

export interface ToolCallEvent extends LogEvent {
  type: 'tool_call';
  payload: {
    tool: string;
    durationMs?: number;
    success?: boolean;
    args?: Record<string, unknown>;
  };
}

export interface EditEvent extends LogEvent {
  type: 'edit';
  payload: {
    file: string;
    diffLines: number;
    success?: boolean;
  };
}

export interface SessionStartEvent extends LogEvent {
  type: 'session_start';
  payload: {
    modelLimit?: number;
  };
}

export interface SessionEndEvent extends LogEvent {
  type: 'session_end';
  payload: Record<string, unknown>;
}

export type AgentLogEvent =
  | LLMRequestEvent
  | ToolCallEvent
  | EditEvent
  | SessionStartEvent
  | SessionEndEvent
  | LogEvent;

export interface SessionState {
  sessionId: string;
  startedAt: number;
  promptTokens: number;
  completionTokens: number;
  cacheTokens: number;
  toolCalls: number;
  readFiles: number;
  edits: number;
  retries: number;
  contextBytes: number;
  contextTokens: number;
  modelLimit: number;
  subAgents: number;
  elapsedMs: number;
  toolSequence: string[];
  filesRead: Set<string>;
  filesEdited: Set<string>;
  events: AgentLogEvent[];
}

export interface Rule {
  id: string;
  name: string;
  match: (state: SessionState, event: AgentLogEvent) => boolean;
  action: (state: SessionState, event: AgentLogEvent) => Alert | undefined;
}

export interface Alert {
  id: string;
  ruleId: string;
  sessionId: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface Metrics {
  contextTokens: number;
  toolCalls: number;
  cost: number;
  latency: number;
  retries: number;
  loops: number;
  subAgents: number;
  cacheHit: number;
  readFiles: number;
  edits: number;
}

export interface HealthWeights {
  contextUtilization: number;
  retryRate: number;
  loopDetected: number;
  mcpLatency: number;
  promptGrowth: number;
}

export interface HealthScore {
  score: number;
  label: 'Excellent' | 'Good' | 'Warning' | 'Critical';
  breakdown: Record<string, number>;
}

export interface Recommendation {
  model: 'mini' | 'medium' | 'large';
  confidence: number;
  estimatedSavingPercent: number;
  reasons: string[];
}

export interface AdvisorOutput {
  taskComplexity: number;
  recommendation: Recommendation;
  alerts: Alert[];
  health: HealthScore;
}

export interface OutcomeSignal {
  testPassed: boolean;
  committed: boolean;
  noRetry: boolean;
  noRevert: boolean;
  followUpEditCount?: number;
  timeToNextPromptMs?: number;
}

// Legacy V1/V2 types (kept for historical analysis)
export interface ToolCall {
  tool: string;
  argsSummary?: string;
  timestamp: number;
}

export interface ReasoningStep {
  step: number;
  title: string;
  tokens?: number;
}

export interface AgentTrace {
  traceId: string;
  sessionId: string;
  timestamp: number;
  userRequest: string;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  estimatedCostUsd: number;
  toolCalls: ToolCall[];
  filesChanged: string[];
  reasoningSteps: ReasoningStep[];
  finalDiff: string;
  outcome?: OutcomeSignal;
  evaluation?: EvaluationResult;
}

export interface OutcomeSignal {
  testPassed: boolean;
  committed: boolean;
  noRetry: boolean;
  noRevert: boolean;
  followUpEditCount?: number;
  timeToNextPromptMs?: number;
}

export interface FeatureVector {
  contextTokens: number;
  toolCallCount: number;
  uniqueFileCount: number;
  diffLineCount: number;
  reasoningStepCount: number;
  totalTokens: number;
  inputOutputRatio: number;
  hasTests: boolean;
}

export interface EvaluationResult {
  complexity: number;
  smallerModelPossible: boolean;
  confidence: number;
  reason: string[];
  evaluatedAt: number;
  evaluatorModel?: string;
}
