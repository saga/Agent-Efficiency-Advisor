import type { AgentLogEvent, Alert, SessionState } from '../types.js';
import { BaseRule, makeAlert } from './Rule.js';

const READ_FILE_STORM_THRESHOLD = 20;

export class ReadFileStormRule extends BaseRule {
  id = 'readfile-storm';
  name = 'ReadFile Storm';

  match(state: SessionState, event: AgentLogEvent): boolean {
    if (event.type !== 'tool_call') return false;
    const tool = String(event.payload.tool ?? '').toLowerCase();
    return (tool === 'read_file' || tool === 'readfile') && state.readFiles >= READ_FILE_STORM_THRESHOLD;
  }

  action(state: SessionState): Alert | undefined {
    return makeAlert(this.id, state, 'warning', `Agent read ${state.readFiles} files; possible search storm`, {
      readFiles: state.readFiles,
      uniqueFiles: state.filesRead.size,
    });
  }
}
