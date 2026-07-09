import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';

export class ContextTooLargeRule extends BaseRule {
  id = 'context-too-large';
  name = 'Context Too Large';

  match(state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'llm_request') return false;
    const utilization = state.contextTokens / state.modelLimit;
    return utilization >= 0.8;
  }

  action(state: SessionState): Alert | undefined {
    const utilization = state.contextTokens / state.modelLimit;
    return makeAlert(this.id, state, utilization >= 0.95 ? 'critical' : 'warning', `Context at ${Math.round(utilization * 100)}%`, {
      contextTokens: state.contextTokens,
      modelLimit: state.modelLimit,
    });
  }
}
