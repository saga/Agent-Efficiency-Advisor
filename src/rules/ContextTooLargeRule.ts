import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';
import { DEFAULT_RULE_CONFIG, type RuleConfig } from './config.js';

export class ContextTooLargeRule extends BaseRule {
  id = 'context-too-large';
  name = 'Context Too Large';

  private readonly warningUtilization: number;
  private readonly criticalUtilization: number;

  constructor(config?: RuleConfig) {
    super();
    const c = config?.contextTooLarge ?? DEFAULT_RULE_CONFIG.contextTooLarge;
    this.warningUtilization = c.warningUtilization;
    this.criticalUtilization = c.criticalUtilization;
  }

  match(state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'llm_request') return false;
    const utilization = state.contextTokens / state.modelLimit;
    return utilization >= this.warningUtilization;
  }

  action(state: SessionState): Alert | undefined {
    const utilization = state.contextTokens / state.modelLimit;
    return makeAlert(this.id, state, utilization >= this.criticalUtilization ? 'critical' : 'warning', `Context at ${Math.round(utilization * 100)}%`, {
      contextTokens: state.contextTokens,
      modelLimit: state.modelLimit,
    });
  }
}
