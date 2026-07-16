import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';
import { DEFAULT_RULE_CONFIG, type RuleConfig } from './config.js';

export class RetryRule extends BaseRule {
  id = 'retry-spike';
  name = 'Retry Spike';

  private readonly threshold: number;

  constructor(config?: RuleConfig) {
    super();
    const c = config?.retry ?? DEFAULT_RULE_CONFIG.retry;
    this.threshold = c.threshold;
  }

  match(state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'tool_call' && event.type !== 'edit') return false;
    return event.payload.success === false && state.retries >= this.threshold;
  }

  action(state: SessionState): Alert | undefined {
    return makeAlert(this.id, state, 'warning', `${state.retries} consecutive failures; prompt or tool may be wrong`, {
      retries: state.retries,
    });
  }
}
