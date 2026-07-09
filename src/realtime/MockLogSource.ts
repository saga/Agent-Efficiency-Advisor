import type { AgentLogEvent } from '../types.js';
import type { LogSource } from './LogSource.js';

export interface MockLogSourceOptions {
  sessionId: string;
  intervalMs?: number;
  eventSequence?: AgentLogEvent[];
}

export class MockLogSource implements LogSource {
  private active = false;

  constructor(private options: MockLogSourceOptions) {}

  async *watch(): AsyncIterable<AgentLogEvent> {
    this.active = true;
    const events = this.options.eventSequence ?? generateScenario(this.options.sessionId);
    const interval = this.options.intervalMs ?? 500;

    for (const event of events) {
      if (!this.active) break;
      await sleep(interval);
      yield event;
    }
  }

  stop(): void {
    this.active = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function generateScenario(sessionId: string): AgentLogEvent[] {
  const now = Date.now();
  const e = (type: string, payload: Record<string, unknown>): AgentLogEvent => ({
    type,
    sessionId,
    timestamp: now,
    payload,
  });

  return [
    e('session_start', { modelLimit: 256000 }),
    e('llm_request', { promptTokens: 2000, completionTokens: 400, model: 'gpt-5' }),
    e('tool_call', { tool: 'read_file', durationMs: 120, success: true, args: { path: 'src/index.ts' } }),
    e('tool_call', { tool: 'read_file', durationMs: 90, success: true, args: { path: 'src/types.ts' } }),
    e('tool_call', { tool: 'grep', durationMs: 200, success: true, args: { query: 'interface' } }),
    e('llm_request', { promptTokens: 5000, completionTokens: 800, model: 'gpt-5' }),
    e('edit', { file: 'src/index.ts', diffLines: 12, success: true }),
    e('tool_call', { tool: 'read_file', durationMs: 110, success: true, args: { path: 'src/index.ts' } }),
    e('tool_call', { tool: 'read_file', durationMs: 100, success: true, args: { path: 'src/utils.ts' } }),
    e('tool_call', { tool: 'read_file', durationMs: 130, success: true, args: { path: 'src/parser.ts' } }),
    e('llm_request', { promptTokens: 9000, completionTokens: 1200, model: 'gpt-5' }),
    e('edit', { file: 'src/utils.ts', diffLines: 8, success: false }),
    e('edit', { file: 'src/utils.ts', diffLines: 8, success: false }),
    e('edit', { file: 'src/utils.ts', diffLines: 8, success: true }),
    e('session_end', {}),
  ];
}
