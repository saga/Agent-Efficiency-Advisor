import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';
import { DEFAULT_RULE_CONFIG, type RuleConfig } from './config.js';

export class PromptExplosionRule extends BaseRule {
  private lastPromptTokens = 0;

  id = 'prompt-explosion';
  name = 'Prompt Explosion';

  private readonly growthThresholdTokens: number;

  constructor(config?: RuleConfig) {
    super();
    const c = config?.promptExplosion ?? DEFAULT_RULE_CONFIG.promptExplosion;
    this.growthThresholdTokens = c.growthThresholdTokens;
  }

  match(state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'llm_request') return false;
    const current = state.promptTokens;
    const delta = current - this.lastPromptTokens;
    this.lastPromptTokens = current;
    return delta >= this.growthThresholdTokens;
  }

  action(state: SessionState): Alert | undefined {
    return makeAlert(this.id, state, 'warning', `Prompt tokens exploded to ${state.promptTokens}`, {
      promptTokens: state.promptTokens,
    });
  }
}
