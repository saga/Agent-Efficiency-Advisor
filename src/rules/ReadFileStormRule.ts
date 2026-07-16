import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';
import { DEFAULT_RULE_CONFIG, type RuleConfig } from './config.js';

export class ReadFileStormRule extends BaseRule {
  id = 'readfile-storm';
  name = 'ReadFile Storm';

  private readonly threshold: number;

  constructor(config?: RuleConfig) {
    super();
    const c = config?.readFileStorm ?? DEFAULT_RULE_CONFIG.readFileStorm;
    this.threshold = c.threshold;
  }

  match(state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'tool_call') return false;
    const tool = String(event.payload.tool ?? '').toLowerCase();
    return (tool === 'read_file' || tool === 'readfile') && state.readFiles >= this.threshold;
  }

  action(state: SessionState): Alert | undefined {
    return makeAlert(this.id, state, 'warning', `Agent read ${state.readFiles} files; possible search storm`, {
      readFiles: state.readFiles,
      uniqueFiles: state.filesRead.size,
    });
  }
}
