// Multi-dimensional Health (V5-6). Replaces the single HealthScore with a
// breakdown across six dimensions, like CPU/Memory/Disk/Network for an OS.

import type { HealthDimension, MultiDimensionalHealth, RuntimeSnapshot } from '../runtime/types.js';
import type { MetricSnapshot } from '../plugins/metrics/MetricsPipeline.js';

function labelFor(score: number): HealthDimension['label'] {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 50) return 'Warning';
  return 'Critical';
}

function dim(name: string, score: number, detail?: string): HealthDimension {
  return { name, score: Math.round(score), label: labelFor(score), detail };
}

export function computeMultiHealth(snapshot: RuntimeSnapshot, metrics: MetricSnapshot): MultiDimensionalHealth {
  const v = metrics.values;

  const execution = dim(
    'Execution',
    (1 - (v.retry_rate ?? 0)) * 60 + (v.loop_detected === 0 ? 40 : 10),
    `retries=${snapshot.retries}, loops=${v.loop_detected}`
  );

  const reasoning = dim(
    'Reasoning',
    100 - Math.min(v.prompt_growth_rate ?? 0, 1) * 60 - (v.stuck_in_planning ?? 0) * 40,
    `prompt=${snapshot.promptTokens}, stuck=${v.stuck_in_planning}`
  );

  const context = dim(
    'Context',
    (1 - Math.min(v.context_usage ?? 0, 1)) * 100,
    `${snapshot.contextTokens}/${snapshot.modelLimit} tokens`
  );

  const tool = dim(
    'Tool',
    (1 - Math.min(v.tool_diversity ?? 0, 1) / 2) * 50 +
      (v.loop_detected === 0 ? 50 : 15),
    `calls=${snapshot.toolCalls}, diversity=${(v.tool_diversity ?? 0).toFixed(2)}`
  );

  const planning = dim(
    'Planning',
    v.stuck_in_planning === 0 ? 90 : 30,
    `phase=${snapshot.phase}`
  );

  const memory = dim(
    'Memory',
    100 - Math.min((v.file_entropy ?? 0) * 100, 60) - Math.min((v.subagent_pressure ?? 0) * 100, 30),
    `files=${snapshot.filesRead.length + snapshot.filesEdited.length}, subagents=${snapshot.subAgents}`
  );

  const dimensions = [execution, reasoning, context, tool, planning, memory];
  const overall = Math.round(dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length);

  return { overall, dimensions };
}
