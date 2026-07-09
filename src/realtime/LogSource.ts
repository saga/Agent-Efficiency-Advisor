import type { AgentLogEvent } from '../types.js';

export interface LogSource {
  watch(): AsyncIterable<AgentLogEvent>;
  stop?(): void;
}
