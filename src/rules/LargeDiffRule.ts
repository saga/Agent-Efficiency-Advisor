import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';

const LARGE_DIFF_THRESHOLD = 100;

export class LargeDiffRule extends BaseRule {
  id = 'large-diff';
  name = 'Large Diff';

  match(_state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'edit') return false;
    const e = event as import('../types.js').EditEvent;
    return Number(e.payload.diffLines ?? 0) >= LARGE_DIFF_THRESHOLD;
  }

  action(state: SessionState, event: AgentLogEvent): Alert | undefined {
    const e = event as import('../types.js').EditEvent;
    return makeAlert(this.id, state, 'info', `Large diff: ${e.payload.diffLines} lines in ${e.payload.file}`, {
      file: e.payload.file,
      diffLines: e.payload.diffLines,
    });
  }
}
