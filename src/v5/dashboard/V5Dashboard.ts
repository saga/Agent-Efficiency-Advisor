// V5 Dashboard: multi-dimensional health + timeline + metrics + recommendation.

import type { MultiDimensionalHealth, RuntimeSnapshot } from '../runtime/types.js';
import type { MetricSnapshot } from '../plugins/metrics/MetricsPipeline.js';
import type { FusedPrediction } from '../plugins/predictors/index.js';
import type { Alert } from '../runtime/types.js';
import { renderTimeline } from '../timeline/Timeline.js';

export interface V5DashboardInput {
  snapshot: RuntimeSnapshot;
  metrics: MetricSnapshot;
  health: MultiDimensionalHealth;
  prediction: FusedPrediction;
  alerts: Alert[];
}

export function renderV5Dashboard(input: V5DashboardInput): string {
  const { snapshot: s, metrics: m, health: h, prediction: p, alerts } = input;

  const lines: string[] = [];
  lines.push('┌──────────────────────────────────────────────────────────────┐');
  lines.push(`│ Session: ${pad(s.sessionId, 50)} │`);
  lines.push(`│ Phase:  ${pad(s.phase, 51)} │`);
  lines.push(`│ Events: ${pad(String(s.events.length), 50)} │`);
  lines.push('├──────────────────────────────────────────────────────────────┤');
  lines.push(`│ Context   ${fmtK(s.contextTokens)} / ${fmtK(s.modelLimit)} ${progressBar(s.contextTokens, s.modelLimit)} │`);
  lines.push(`│ Tokens    prompt ${fmtK(s.promptTokens)}  completion ${fmtK(s.completionTokens)}        │`);
  lines.push(`│ Tools     calls ${pad(s.toolCalls, 4)}  reads ${pad(s.readFiles, 4)}  edits ${pad(s.edits, 4)}  retries ${pad(s.retries, 3)} │`);
  lines.push(`│ Files     read ${pad(s.filesRead.length, 4)}  edited ${pad(s.filesEdited.length, 4)}  subagents ${pad(s.subAgents, 3)}        │`);
  lines.push('├──────────────────────────────────────────────────────────────┤');
  lines.push(`│ Health    overall ${pad(h.overall, 3)}                                            │`);

  for (const d of h.dimensions) {
    const icon = iconForLabel(d.label);
    lines.push(`│   ${icon} ${pad(d.name, 10)} ${pad(String(d.score), 3)} ${pad(d.label, 10)} ${truncate(d.detail ?? '', 28)} │`);
  }

  lines.push('├──────────────────────────────────────────────────────────────┤');
  lines.push(`│ Recommend ${p.fused.model.toUpperCase()} (${Math.round(p.fused.confidence * 100)}%)  save ~${p.fused.estimatedSavingPercent}%                source: ${truncate(p.fused.source, 20)} │`);

  for (const r of p.recommendations) {
    lines.push(`│   • ${pad(r.source, 10)} → ${r.model.toUpperCase()} (${Math.round(r.confidence * 100)}%)` + pad('', 30) + '│');
  }

  lines.push('├──────────────────────────────────────────────────────────────┤');

  if (alerts.length === 0) {
    lines.push('│ Alerts: none                                                 │');
  } else {
    lines.push(`│ Alerts: ${pad(String(alerts.length), 3)}                                                      │`);
    for (const a of alerts.slice(-4)) {
      const icon = a.severity === 'critical' ? '❌' : a.severity === 'warning' ? '⚠️' : 'ℹ️';
      lines.push(`│   ${icon} ${truncate(a.message, 54)} │`);
    }
  }

  lines.push('├──────────────────────────────────────────────────────────────┤');
  lines.push('│ Metrics:                                                       │');
  for (const [id, value] of Object.entries(m.values)) {
    lines.push(`│   ${pad(id, 22)} ${pad(value.toFixed(3), 8)}                                    │`);
  }

  lines.push('└──────────────────────────────────────────────────────────────┘');
  lines.push('');
  lines.push(renderTimeline(s));

  return lines.join('\n');
}

function progressBar(current: number, max: number): string {
  const ratio = Math.min(current / max, 1);
  const filled = Math.round(ratio * 14);
  return `[${'█'.repeat(filled)}${'░'.repeat(14 - filled)}]`;
}

function iconForLabel(label: string): string {
  switch (label) {
    case 'Excellent': return '✅';
    case 'Good': return '✓';
    case 'Warning': return '⚠️';
    case 'Critical': return '❌';
    default: return '?';
  }
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width, ' ');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
