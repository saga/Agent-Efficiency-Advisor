import type { AgentLogEvent, Metrics, SessionState } from '../types.js';

export function buildMetrics(state: SessionState): Metrics {
  return {
    contextTokens: state.contextTokens,
    toolCalls: state.toolCalls,
    cost: estimateCost(state),
    latency: state.elapsedMs,
    retries: state.retries,
    loops: countLoops(state.toolSequence),
    subAgents: state.subAgents,
    cacheHit: 0, // TODO: derive from cache tokens when available
    readFiles: state.readFiles,
    edits: state.edits,
  };
}

export function updateMetricsFromEvent(metrics: Metrics, event: AgentLogEvent): Metrics {
  switch (event.type) {
    case 'llm_request':
      metrics.contextTokens += Number(event.payload.promptTokens ?? 0);
      break;
    case 'tool_call':
      metrics.toolCalls += 1;
      if (String(event.payload.tool ?? '').toLowerCase() === 'read_file') {
        metrics.readFiles += 1;
      }
      break;
    case 'edit':
      metrics.edits += 1;
      break;
  }
  return metrics;
}

function estimateCost(state: SessionState): number {
  // Rough estimate: $5 / 1M input tokens, $15 / 1M output tokens
  return state.promptTokens * 5e-6 + state.completionTokens * 15e-6;
}

function countLoops(sequence: string[]): number {
  let loops = 0;
  for (let len = 2; len <= 5; len++) {
    for (let i = 0; i <= sequence.length - len * 2; i++) {
      const a = sequence.slice(i, i + len).join(',');
      const b = sequence.slice(i + len, i + len * 2).join(',');
      if (a === b) loops++;
    }
  }
  return loops;
}
