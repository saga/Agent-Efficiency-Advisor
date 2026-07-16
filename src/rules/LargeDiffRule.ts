import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';
import { DEFAULT_RULE_CONFIG, type RuleConfig } from './config.js';

export class LargeDiffRule extends BaseRule {
  id = 'large-diff';
  name = 'Large Diff';

  private readonly threshold: number;

  constructor(config?: RuleConfig) {
    super();
    const c = config?.largeDiff ?? DEFAULT_RULE_CONFIG.largeDiff;
    this.threshold = c.threshold;
  }

  match(_state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'edit') return false;
    const e = event as import('../types.js').EditEvent;
    return Number(e.payload.diffLines ?? 0) >= this.threshold;
  }

  action(state: SessionState, event: AgentLogEvent): Alert | undefined {
    const e = event as import('../types.js').EditEvent;
    return makeAlert(this.id, state, 'info', `Large diff: ${e.payload.diffLines} lines in ${e.payload.file}`, {
      file: e.payload.file,
      diffLines: e.payload.diffLines,
    });
  }
}
