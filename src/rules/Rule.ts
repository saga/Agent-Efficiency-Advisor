import type { AgentLogEvent, Alert, Rule, SessionState } from '../types.js';

export function makeAlert(
  ruleId: string,
  state: SessionState,
  severity: Alert['severity'],
  message: string,
  details?: Record<string, unknown>
): Alert {
  return {
    id: `${ruleId}-${state.sessionId}-${Date.now()}`,
    ruleId,
    sessionId: state.sessionId,
    severity,
    message,
    timestamp: Date.now(),
    details,
  };
}

export abstract class BaseRule implements Rule {
  abstract id: string;
  abstract name: string;

  abstract match(state: SessionState, event: AgentLogEvent): boolean;
  abstract action(state: SessionState, event: AgentLogEvent): Alert | undefined;
}

export * from '../types.js';
