import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';

const LOOP_WINDOW = 10;
const LOOP_MIN_REPEATS = 4;

export class ToolLoopRule extends BaseRule {
  id = 'tool-loop';
  name = 'Tool Loop';

  match(state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'tool_call') return false;
    return detectLoop(state.toolSequence);
  }

  action(state: SessionState): Alert | undefined {
    const loop = findLoopPattern(state.toolSequence);
    return makeAlert(this.id, state, 'warning', `Detected possible tool loop: ${loop}`, {
      sequence: state.toolSequence.slice(-LOOP_WINDOW),
    });
  }
}

function detectLoop(sequence: string[]): boolean {
  if (sequence.length < LOOP_MIN_REPEATS * 2) return false;
  const recent = sequence.slice(-LOOP_WINDOW);
  return findLoopPattern(recent) !== 'none';
}

function findLoopPattern(sequence: string[]): string {
  for (let len = 2; len <= 5; len++) {
    const pattern = sequence.slice(-len).join(' → ');
    let repeats = 0;
    for (let i = sequence.length - len; i >= 0; i -= len) {
      const chunk = sequence.slice(i, i + len).join(' → ');
      if (chunk === pattern) repeats++;
      else break;
    }
    if (repeats >= LOOP_MIN_REPEATS) return pattern;
  }
  return 'none';
}
