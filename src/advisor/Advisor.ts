import type { AdvisorOutput, Alert, HealthScore, Recommendation, SessionState } from '../types.js';

const TOKEN_LIMIT_MINI = 8000;
const TOOL_LIMIT_MINI = 5;
const FILE_LIMIT_MINI = 2;

export function advise(state: SessionState, alerts: Alert[], health: HealthScore): AdvisorOutput {
  const reasons: string[] = [];
  let complexity = 0;

  // Prompt complexity
  if (state.promptTokens < TOKEN_LIMIT_MINI) {
    reasons.push(`Prompt ${state.promptTokens} tokens`);
    complexity += 10;
  } else if (state.promptTokens < 30000) {
    reasons.push(`Prompt ${state.promptTokens} tokens`);
    complexity += 30;
  } else {
    reasons.push(`Large prompt ${state.promptTokens} tokens`);
    complexity += 50;
  }

  // Tool / search complexity
  if (state.toolCalls <= TOOL_LIMIT_MINI) {
    reasons.push(`${state.toolCalls} tool calls`);
    complexity += 5;
  } else {
    reasons.push(`${state.toolCalls} tool calls`);
    complexity += 20;
  }

  // File complexity
  if (state.filesEdited.size <= FILE_LIMIT_MINI && state.filesRead.size <= 5) {
    reasons.push(`${state.filesEdited.size} files edited`);
    complexity += 5;
  } else {
    reasons.push(`${state.filesEdited.size} files edited, ${state.filesRead.size} read`);
    complexity += 20;
  }

  // Retry / loop penalties
  if (state.retries > 0) {
    reasons.push(`${state.retries} retries`);
    complexity += 15;
  }
  if (alerts.some((a) => a.ruleId === 'tool-loop')) {
    reasons.push('tool loop detected');
    complexity += 20;
  }
  if (state.subAgents > 0) {
    reasons.push(`${state.subAgents} sub agents`);
    complexity += 20;
  }

  const recommendation = recommendModel(state, complexity, reasons);

  return {
    taskComplexity: Math.min(100, complexity),
    recommendation,
    alerts,
    health,
  };
}

function recommendModel(state: SessionState, complexity: number, reasons: string[]): Recommendation {
  const miniEligible =
    state.promptTokens < TOKEN_LIMIT_MINI &&
    state.toolCalls <= TOOL_LIMIT_MINI &&
    state.filesEdited.size <= FILE_LIMIT_MINI &&
    state.retries === 0 &&
    state.subAgents === 0;

  if (miniEligible && complexity <= 30) {
    return {
      model: 'mini',
      confidence: 0.85,
      estimatedSavingPercent: 60,
      reasons,
    };
  }

  if (complexity <= 60) {
    return {
      model: 'medium',
      confidence: 0.7,
      estimatedSavingPercent: 25,
      reasons,
    };
  }

  return {
    model: 'large',
    confidence: 0.75,
    estimatedSavingPercent: 0,
    reasons,
  };
}
