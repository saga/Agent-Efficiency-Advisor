/**
 * @legacy V1/V2 历史分析模块
 *
 * 此模块属于 V1/V2 遗留代码,保留用于离线训练数据参考。
 * 新代码应使用 V6/V7 的 src/store/ (EventStore/FeatureStore) 和 src/ml/ 模块。
 * 详见 docs/ARCHITECTURE.md 和 IMPROVEMENT_PLAN.md。
 */
import type { AgentTrace, EvaluationResult, FeatureVector } from '../types.js';

export interface Evaluator {
  evaluate(trace: AgentTrace, features: FeatureVector): Promise<EvaluationResult>;
}

export interface LlmEvaluatorOptions {
  model: string;
  invoke: (prompt: string) => Promise<string>;
}

export function buildEvaluatorPrompt(trace: AgentTrace, features: FeatureVector): string {
  return `You are an AI coding task evaluator.

Given this completed agent trace summary:

- user request: """${sanitize(trace.userRequest)}"""
- model used: ${trace.modelUsed}
- context tokens: ${features.contextTokens}
- total tokens: ${features.totalTokens}
- tool calls: ${features.toolCallCount}
- unique files changed: ${features.uniqueFileCount}
- diff lines: ${features.diffLineCount}
- reasoning steps: ${features.reasoningStepCount}
- has tests: ${features.hasTests}
- files changed: ${trace.filesChanged.join(', ') || 'none'}

Estimate:
1. Task complexity: 1-10
2. Could a smaller model likely solve it? (true/false)
3. Confidence: 0.0-1.0
4. Reasons: list of short strings

Return JSON only in this exact shape:
{
  "complexity": number,
  "smaller_model_possible": boolean,
  "confidence": number,
  "reason": ["..."]
}`;
}

export class LlmEvaluator implements Evaluator {
  constructor(private options: LlmEvaluatorOptions) {}

  async evaluate(trace: AgentTrace, features: FeatureVector): Promise<EvaluationResult> {
    const prompt = buildEvaluatorPrompt(trace, features);
    const raw = await this.options.invoke(prompt);
    const parsed = JSON.parse(stripMarkdownCodeBlock(raw)) as unknown;
    return parseEvaluationResult(parsed, this.options.model);
  }
}

export class MockLlmEvaluator implements Evaluator {
  async evaluate(_trace: AgentTrace, features: FeatureVector): Promise<EvaluationResult> {
    const complexity = Math.min(
      10,
      Math.max(
        1,
        Math.round(
          (features.contextTokens / 20000) * 3 +
            features.toolCallCount * 0.5 +
            features.uniqueFileCount * 0.7 +
            features.reasoningStepCount * 0.4 +
            features.diffLineCount * 0.02
        )
      )
    );

    const reasons: string[] = [];
    if (features.uniqueFileCount <= 2) reasons.push('single file edit');
    if (features.toolCallCount <= 3) reasons.push('few tool calls');
    if (features.reasoningStepCount <= 2) reasons.push('no architectural reasoning');
    if (features.contextTokens < 4000) reasons.push('small context');
    if (features.hasTests) reasons.push('includes tests');
    if (features.uniqueFileCount > 4) reasons.push('multiple files touched');

    const smallerModelPossible =
      complexity <= 4 && features.uniqueFileCount <= 3 && features.toolCallCount <= 5;
    const confidence = smallerModelPossible ? 0.82 : 0.65;

    return {
      complexity,
      smallerModelPossible,
      confidence,
      reason: reasons.length ? reasons : ['baseline assessment'],
      evaluatedAt: Date.now(),
      evaluatorModel: 'mock-evaluator',
    };
  }
}

function sanitize(text: string): string {
  return text.replace(/"""/g, '"').slice(0, 800);
}

function stripMarkdownCodeBlock(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return trimmed;
}

function parseEvaluationResult(parsed: unknown, model: string): EvaluationResult {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Evaluator returned non-object');
  }
  const obj = parsed as Record<string, unknown>;
  return {
    complexity: Number(obj.complexity),
    smallerModelPossible: Boolean(obj.smaller_model_possible),
    confidence: Number(obj.confidence),
    reason: Array.isArray(obj.reason) ? obj.reason.map(String) : [String(obj.reason)],
    evaluatedAt: Date.now(),
    evaluatorModel: model,
  };
}
