import type { HealthScore, HealthWeights, Metrics, SessionState } from '../types.js';

export const DEFAULT_WEIGHTS: HealthWeights = {
  contextUtilization: 0.4,
  retryRate: 0.2,
  loopDetected: 0.2,
  mcpLatency: 0.1,
  promptGrowth: 0.1,
};

export function computeHealthScore(
  state: SessionState,
  metrics: Metrics,
  weights: HealthWeights = DEFAULT_WEIGHTS
): HealthScore {
  const contextUtilization = Math.min(state.contextTokens / state.modelLimit, 1);
  const retryRate = state.toolCalls > 0 ? state.retries / state.toolCalls : 0;
  const loopDetected = metrics.loops > 0 ? 1 : 0;
  const promptGrowth = Math.min(state.promptTokens / 50000, 1);
  const mcpLatency = Math.min(metrics.latency / 60000, 1);

  const contextScore = (1 - contextUtilization) * 100;
  const retryScore = (1 - retryRate) * 100;
  const loopScore = loopDetected === 0 ? 100 : 30;
  const promptScore = (1 - promptGrowth) * 100;
  const latencyScore = (1 - mcpLatency) * 100;

  const score = Math.round(
    contextScore * weights.contextUtilization +
      retryScore * weights.retryRate +
      loopScore * weights.loopDetected +
      latencyScore * weights.mcpLatency +
      promptScore * weights.promptGrowth
  );

  return {
    score,
    label: labelForScore(score),
    breakdown: {
      contextUtilization: Math.round(contextScore),
      retryRate: Math.round(retryScore),
      loopDetected: Math.round(loopScore),
      mcpLatency: Math.round(latencyScore),
      promptGrowth: Math.round(promptScore),
    },
  };
}

function labelForScore(score: number): HealthScore['label'] {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 50) return 'Warning';
  return 'Critical';
}
