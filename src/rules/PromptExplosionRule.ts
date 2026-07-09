import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';

const GROWTH_THRESHOLD_TOKENS = 10000;

export class PromptExplosionRule extends BaseRule {
  private lastPromptTokens = 0;

  id = 'prompt-explosion';
  name = 'Prompt Explosion';

  match(state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'llm_request') return false;
    const current = state.promptTokens;
    const delta = current - this.lastPromptTokens;
    this.lastPromptTokens = current;
    return delta >= GROWTH_THRESHOLD_TOKENS;
  }

  action(state: SessionState): Alert | undefined {
    return makeAlert(this.id, state, 'warning', `Prompt tokens exploded to ${state.promptTokens}`, {
      promptTokens: state.promptTokens,
    });
  }
}
