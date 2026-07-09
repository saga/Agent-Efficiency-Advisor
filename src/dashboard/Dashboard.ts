import type { AdvisorOutput, Metrics, SessionState } from '../types.js';

export function renderDashboard(
  state: SessionState,
  metrics: Metrics,
  advisor: AdvisorOutput
): string {
  const bar = progressBar(state.contextTokens, state.modelLimit);
  const healthIcon = healthIconFor(advisor.health.label);

  const lines = [
    '┌────────────────────────────────────────────┐',
    `│ Session: ${pad(state.sessionId, 36)} │`,
    `│ Context  ${formatK(state.contextTokens)} / ${formatK(state.modelLimit)} ${bar} │`,
    `│ Tool     ReadFile ${pad(metrics.readFiles, 3)}  Edit ${pad(metrics.edits, 3)}  Retry ${pad(metrics.retries, 3)} │`,
    `│ Loop     ${pad(metrics.loops, 3)}  SubAgent ${pad(metrics.subAgents, 3)}  Cost $${metrics.cost.toFixed(3)} │`,
    `│ Health   ${pad(advisor.health.score, 3)} ${healthIcon} ${pad(advisor.health.label, 10)}           │`,
    `│ Complex  ${pad(advisor.taskComplexity, 3)}/100  Recommend ${advisor.recommendation.model.toUpperCase()} (${Math.round(advisor.recommendation.confidence * 100)}%) │`,
    '├────────────────────────────────────────────┤',
  ];

  if (advisor.alerts.length === 0) {
    lines.push('│ No alerts                                  │');
  } else {
    for (const alert of advisor.alerts.slice(-5)) {
      const icon = alert.severity === 'critical' ? '❌' : alert.severity === 'warning' ? '⚠️' : 'ℹ️';
      lines.push(`│ ${icon} ${truncate(alert.message, 38)} │`);
    }
  }

  lines.push('└────────────────────────────────────────────┘');
  return lines.join('\n');
}

function progressBar(current: number, max: number): string {
  const ratio = Math.min(current / max, 1);
  const filled = Math.round(ratio * 14);
  const bar = '█'.repeat(filled) + '░'.repeat(14 - filled);
  return `[${bar}]`;
}

function healthIconFor(label: string): string {
  switch (label) {
    case 'Excellent':
      return '✅';
    case 'Good':
      return '✓';
    case 'Warning':
      return '⚠️';
    case 'Critical':
      return '❌';
    default:
      return '?';
  }
}

function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width, ' ');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}
