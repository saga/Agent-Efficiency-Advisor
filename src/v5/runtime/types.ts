// V5 Runtime types — state machine + event sourcing primitives.

export type AgentPhase =
  | 'Idle'
  | 'Planning'
  | 'Thinking'
  | 'CallingTool'
  | 'WaitingTool'
  | 'Editing'
  | 'Reviewing'
  | 'Finished'
  | 'Failed';

export interface PhaseTransition {
  from: AgentPhase;
  to: AgentPhase;
  at: number;
  event: RuntimeEvent;
  reason?: string;
}

export interface RuntimeEvent {
  id: string;
  sessionId: string;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface RuntimeSnapshot {
  sessionId: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  phase: AgentPhase;
  transitions: PhaseTransition[];

  // Cumulative counters (derived, never mutated directly by callers)
  promptTokens: number;
  completionTokens: number;
  cacheTokens: number;
  contextTokens: number;
  modelLimit: number;
  toolCalls: number;
  readFiles: number;
  edits: number;
  retries: number;
  subAgents: number;

  // Sets (encoded as arrays for immutability/serialization)
  filesRead: string[];
  filesEdited: string[];

  // Sliding window of recent tool calls for loop detection
  recentTools: string[];

  // Last known model
  model?: string;

  // Original events kept for replay/time-travel
  events: RuntimeEvent[];
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

export interface Recommendation {
  model: 'mini' | 'medium' | 'large';
  confidence: number;
  estimatedSavingPercent: number;
  reasons: string[];
  source: string; // which predictor produced this
}

export interface HealthDimension {
  name: string;
  score: number; // 0-100
  label: 'Excellent' | 'Good' | 'Warning' | 'Critical';
  detail?: string;
}

export interface MultiDimensionalHealth {
  overall: number;
  dimensions: HealthDimension[];
}

export interface TimelineEntry {
  timestamp: number;
  phase: AgentPhase;
  event: RuntimeEvent;
  annotation?: string;
}

export interface PredictionContext {
  snapshot: RuntimeSnapshot;
  alerts: Alert[];
  health: MultiDimensionalHealth;
}

export interface Predictor {
  id: string;
  predict(ctx: PredictionContext): Promise<Recommendation> | Recommendation;
}

export interface MetricProvider {
  id: string;
  compute(snapshot: RuntimeSnapshot): number;
  description?: string;
}

export interface RuntimeRule {
  id: string;
  name: string;
  match(snapshot: RuntimeSnapshot, event: RuntimeEvent): boolean;
  action(snapshot: RuntimeSnapshot, event: RuntimeEvent): Alert | undefined;
}

export interface Plugin {
  id: string;
  name: string;
  rules?: RuntimeRule[];
  metricProviders?: MetricProvider[];
  predictors?: Predictor[];
}
