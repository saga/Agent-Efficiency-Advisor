import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';
import { DEFAULT_RULE_CONFIG, type RuleConfig } from './config.js';

export class ToolLoopRule extends BaseRule {
  id = 'tool-loop';
  name = 'Tool Loop';

  private readonly window: number;
  private readonly minRepeats: number;

  constructor(config?: RuleConfig) {
    super();
    const c = config?.toolLoop ?? DEFAULT_RULE_CONFIG.toolLoop;
    this.window = c.window;
    this.minRepeats = c.minRepeats;
  }

  match(state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'tool_call') return false;
    return detectLoop(state.toolSequence, this.window, this.minRepeats);
  }

  action(state: SessionState): Alert | undefined {
    const loop = findLoopPattern(state.toolSequence, this.minRepeats);
    return makeAlert(this.id, state, 'warning', `Detected possible tool loop: ${loop}`, {
      sequence: state.toolSequence.slice(-this.window),
    });
  }
}

function detectLoop(sequence: string[], window: number, minRepeats: number): boolean {
  if (sequence.length < minRepeats * 2) return false;
  const recent = sequence.slice(-window);
  return findLoopPattern(recent, minRepeats) !== 'none';
}

function findLoopPattern(sequence: string[], minRepeats: number): string {
  for (let len = 2; len <= 5; len++) {
    const pattern = sequence.slice(-len).join(' → ');
    let repeats = 0;
    for (let i = sequence.length - len; i >= 0; i -= len) {
      const chunk = sequence.slice(i, i + len).join(' → ');
      if (chunk === pattern) repeats++;
      else break;
    }
    if (repeats >= minRepeats) return pattern;
  }
  return 'none';
}
