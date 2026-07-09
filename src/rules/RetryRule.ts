import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';

const RETRY_THRESHOLD = 3;

export class RetryRule extends BaseRule {
  id = 'retry-spike';
  name = 'Retry Spike';

  match(state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'tool_call' && event.type !== 'edit') return false;
    return event.payload.success === false && state.retries >= RETRY_THRESHOLD;
  }

  action(state: SessionState): Alert | undefined {
    return makeAlert(this.id, state, 'warning', `${state.retries} consecutive failures; prompt or tool may be wrong`, {
      retries: state.retries,
    });
  }
}
