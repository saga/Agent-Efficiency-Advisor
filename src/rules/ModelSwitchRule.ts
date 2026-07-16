import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';
import { DEFAULT_RULE_CONFIG, type RuleConfig } from './config.js';

export class ModelSwitchRule extends BaseRule {
  id = 'model-switch';
  name = 'Model Switch';

  private readonly keywords: string[];

  constructor(config?: RuleConfig) {
    super();
    const c = config?.modelSwitch ?? DEFAULT_RULE_CONFIG.modelSwitch;
    this.keywords = c.keywords;
  }

  match(_state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'llm_request') return false;
    const e = event as import('../types.js').LLMRequestEvent;
    const model = String(e.payload.model ?? '').toLowerCase();
    return this.keywords.some((k) => model.includes(k));
  }

  action(state: SessionState, event: AgentLogEvent): Alert | undefined {
    const e = event as import('../types.js').LLMRequestEvent;
    return makeAlert(this.id, state, 'info', `Switched to model ${e.payload.model}`, {
      model: e.payload.model,
    });
  }
}
