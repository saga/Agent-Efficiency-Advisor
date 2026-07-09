import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';

export class ModelSwitchRule extends BaseRule {
  id = 'model-switch';
  name = 'Model Switch';

  match(_state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'llm_request') return false;
    const e = event as import('../types.js').LLMRequestEvent;
    const model = String(e.payload.model ?? '').toLowerCase();
    return model.includes('mini') || model.includes('large') || model.includes('sonnet');
  }

  action(state: SessionState, event: AgentLogEvent): Alert | undefined {
    const e = event as import('../types.js').LLMRequestEvent;
    return makeAlert(this.id, state, 'info', `Switched to model ${e.payload.model}`, {
      model: e.payload.model,
    });
  }
}
