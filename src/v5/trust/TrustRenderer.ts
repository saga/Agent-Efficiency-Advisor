// Render a TrustDecision as a human-readable decision report.

import type { TrustDecision, AdvisorScorecard, EvaluationMetrics, DriftSignal } from './types.js';

export function renderTrustDecision(d: TrustDecision): string {
  const lines: string[] = [];
  lines.push('═══ Trustworthy Decision ═══');
  lines.push(`Recommendation: ${d.topModel.toUpperCase()}`);
  lines.push(`Calibrated confidence: ${(d.calibratedConfidence * 100).toFixed(1)}%`);
  lines.push(`Fusion strategy: ${d.fusionStrategy}`);
  lines.push('');
  lines.push('Probabilities (raw → calibrated):');
  for (const p of d.probabilities) {
    lines.push(`  ${p.model.padEnd(7)} ${(p.rawProbability * 100).toFixed(1)}% → ${(p.calibratedProbability * 100).toFixed(1)}%`);
  }
  lines.push('');
  lines.push('Top reasons (SHAP-like contribution):');
  for (const r of d.reasons) {
    const sign = r.contribution >= 0 ? '+' : '';
    lines.push(`  ${sign}${r.contribution.toFixed(3)}  ${r.feature} — ${r.description}`);
  }
  lines.push('');
  lines.push('Alternatives:');
  for (const a of d.alternatives) {
    lines.push(`  ${a.model.padEnd(7)} ${(a.confidence * 100).toFixed(1)}%  ${a.rationale}`);
  }
  lines.push('');
  lines.push(`Risk: ${d.risk.level.toUpperCase()}`);
  for (const f of d.risk.factors) lines.push(`  • ${f}`);
  lines.push(`  mitigation: ${d.risk.mitigation}`);
  if (d.risk.escalationRule) lines.push(`  escalation: ${d.risk.escalationRule}`);
  lines.push('');
  lines.push('Expected outcome:');
  const o = d.expectedOutcome;
  lines.push(`  success probability: ${(o.successProbability * 100).toFixed(0)}%`);
  lines.push(`  estimated saving:    ${o.estimatedSavingPercent}%`);
  lines.push(`  estimated tokens:    ${o.estimatedTokens}`);
  lines.push(`  estimated cost:      $${o.estimatedCostUsd.toFixed(4)}`);
  if (d.counterfactual) {
    lines.push('');
    lines.push('Counterfactual:');
    lines.push(`  ${d.counterfactual.description}`);
  }
  return lines.join('\n');
}

export function renderScorecard(s: AdvisorScorecard): string {
  const lines: string[] = [];
  lines.push('═══ Advisor Scorecard ═══');
  lines.push(`Overall grade: ${s.overallGrade}`);
  lines.push(`  accuracy:        ${(s.accuracy * 100).toFixed(1)}%`);
  lines.push(`  macro F1:        ${(s.macroF1 * 100).toFixed(1)}%`);
  lines.push(`  Brier score:     ${s.brierScore.toFixed(3)} (lower is better)`);
  lines.push(`  ECE:             ${s.ece.toFixed(3)} (lower is better)`);
  lines.push(`  cost saved:      ${s.costSavedPercent.toFixed(1)}%`);
  lines.push(`  failure increase:${s.failureIncreasePercent.toFixed(1)}%`);
  lines.push(`  avg latency:     ${s.avgLatencyMs.toFixed(0)}ms`);
  return lines.join('\n');
}

export function renderEvaluationMetrics(m: EvaluationMetrics): string {
  const lines: string[] = [];
  lines.push('═══ Evaluation Metrics ═══');
  lines.push(`samples: ${m.sampleCount}`);
  lines.push(`accuracy: ${(m.accuracy * 100).toFixed(1)}%`);
  lines.push(`macro F1: ${(m.macroF1 * 100).toFixed(1)}%`);
  lines.push(`Brier:    ${m.brierScore.toFixed(3)}`);
  lines.push(`ECE:      ${m.ece.toFixed(3)}`);
  lines.push('');
  lines.push('Per-class:');
  for (const cls of ['mini', 'medium', 'large'] as const) {
    lines.push(`  ${cls.padEnd(7)} P=${(m.precision[cls] * 100).toFixed(0)}% R=${(m.recall[cls] * 100).toFixed(0)}% F1=${(m.f1[cls] * 100).toFixed(0)}%`);
  }
  lines.push('');
  lines.push('Confusion matrix (rows=true, cols=pred):');
  lines.push(`  ${' '.padEnd(8)} ${'mini'.padEnd(7)} ${'medium'.padEnd(7)} ${'large'.padEnd(7)}`);
  for (const t of ['mini', 'medium', 'large'] as const) {
    const row = m.confusionMatrix[t] ?? {};
    lines.push(`  ${t.padEnd(8)} ${String(row.mini ?? 0).padEnd(7)} ${String(row.medium ?? 0).padEnd(7)} ${String(row.large ?? 0).padEnd(7)}`);
  }
  return lines.join('\n');
}

export function renderDrift(signals: DriftSignal[]): string {
  const lines: string[] = ['═══ Drift Detection ═══'];
  for (const s of signals) {
    const icon = s.severity === 'high' ? '❌' : s.severity === 'medium' ? '⚠️' : s.severity === 'low' ? 'ℹ️' : '✓';
    lines.push(`${icon} ${s.type}: ${s.metric} = ${s.currentValue} (baseline ${s.baselineValue}) — ${s.recommendation}`);
  }
  return lines.join('\n');
}
