// Built-in metric providers: like Prometheus exporters — each computes one
// derived metric from the immutable snapshot.

import type { MetricProvider, RuntimeSnapshot } from '../../runtime/types.js';

function detectLoop(sequence: string[]): boolean {
  if (sequence.length < 8) return false;
  for (let len = 2; len <= 5; len++) {
    const tail = sequence.slice(-len * 3);
    let repeats = 1;
    for (let i = len; i < tail.length; i += len) {
      const a = tail.slice(i - len, i).join(',');
      const b = tail.slice(i, i + len).join(',');
      if (a === b) repeats++;
      else break;
    }
    if (repeats >= 3) return true;
  }
  return false;
}

export const ContextUsageProvider: MetricProvider = {
  id: 'context_usage',
  description: 'Context token utilization (0-1)',
  compute(snap: RuntimeSnapshot): number {
    return snap.modelLimit > 0 ? snap.contextTokens / snap.modelLimit : 0;
  },
};

export const RetryRateProvider: MetricProvider = {
  id: 'retry_rate',
  description: 'Retry rate among tool calls and edits',
  compute(snap: RuntimeSnapshot): number {
    const denom = snap.toolCalls + snap.edits;
    return denom > 0 ? snap.retries / denom : 0;
  },
};

export const LoopDetectedProvider: MetricProvider = {
  id: 'loop_detected',
  description: '1 if a recent tool loop is detected',
  compute(snap: RuntimeSnapshot): number {
    return detectLoop(snap.recentTools) ? 1 : 0;
  },
};

export const PromptGrowthRateProvider: MetricProvider = {
  id: 'prompt_growth_rate',
  description: 'Prompt tokens normalized by 50k',
  compute(snap: RuntimeSnapshot): number {
    return Math.min(snap.promptTokens / 50000, 1);
  },
};

export const ToolDiversityProvider: MetricProvider = {
  id: 'tool_diversity',
  description: 'Unique tools / total tool calls',
  compute(snap: RuntimeSnapshot): number {
    if (snap.toolCalls === 0) return 0;
    const unique = new Set(snap.recentTools).size;
    return unique / snap.toolCalls;
  },
};

export const FileEntropyProvider: MetricProvider = {
  id: 'file_entropy',
  description: 'Files read + edited, capped at 30',
  compute(snap: RuntimeSnapshot): number {
    return Math.min((snap.filesRead.length + snap.filesEdited.length) / 30, 1);
  },
};

export const SubAgentPressureProvider: MetricProvider = {
  id: 'subagent_pressure',
  description: 'Sub-agent count normalized by 5',
  compute(snap: RuntimeSnapshot): number {
    return Math.min(snap.subAgents / 5, 1);
  },
};

export const StuckInPlanningProvider: MetricProvider = {
  id: 'stuck_in_planning',
  description: '1 if phase remained Planning for too many transitions',
  compute(snap: RuntimeSnapshot): number {
    let count = 0;
    for (let i = snap.transitions.length - 1; i >= 0; i--) {
      if (snap.transitions[i].to === 'Planning') count++;
      else break;
    }
    return count >= 4 ? 1 : 0;
  },
};

export const CoreMetricProviders: MetricProvider[] = [
  ContextUsageProvider,
  RetryRateProvider,
  LoopDetectedProvider,
  PromptGrowthRateProvider,
  ToolDiversityProvider,
  FileEntropyProvider,
  SubAgentPressureProvider,
  StuckInPlanningProvider,
];
