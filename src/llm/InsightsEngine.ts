// InsightsEngine — uses pi-ai to generate natural language insights from
// structured analytics. v6.md Section 11: "GPT 只负责解释".
//
// Input: AnalyticsReport.llmPayload (~500 tokens of structured JSON)
// Output: natural language insight (root cause, recommendation)
//
// Uses @earendil-works/pi-ai/compat as the unified LLM framework.
// Dynamic import works around tsx's exports field resolution issue.
// Falls back to template-based explanation if no API key is configured.

import type { Context, Model, Api, AssistantMessage } from '@earendil-works/pi-ai';
import type { AnalyticsReport } from '../ml/AnalyticsEngine.js';

const SYSTEM_PROMPT = `You are an AI Development Observatory analyst. You receive structured metrics about AI coding agent sessions and must provide a concise natural-language insight.

Rules:
- Explain ROOT CAUSE, not just describe numbers.
- Give one actionable recommendation.
- Keep response under 150 words.
- Write in the same language as the data (Chinese if metrics contain Chinese context, otherwise English).
- Focus on what changed and WHY, not just what the numbers are.`;

export interface InsightResult {
  text: string;
  source: 'llm' | 'template';
  model?: string;
  tokensUsed?: { input: number; output: number };
}

// Lazy-loaded compat module (dynamic import bypasses tsx exports resolution)
interface CompatModule {
  complete: (model: Model<Api>, context: Context, options?: Record<string, unknown>) => Promise<AssistantMessage>;
  getModel: (provider: string, id: string) => Model<Api> | undefined;
}

let compatPromise: Promise<CompatModule | null> | null = null;

async function loadCompat(): Promise<CompatModule | null> {
  if (!compatPromise) {
    compatPromise = import('@earendil-works/pi-ai/compat')
      .then((m: any) => m as CompatModule)
      .catch(() => null);
  }
  return compatPromise;
}

export class InsightsEngine {
  private providerId: string;
  private modelId: string;
  private compat: CompatModule | null | undefined;
  private model: Model<Api> | undefined;

  constructor() {
    this.providerId = process.env.AEA_LLM_PROVIDER ?? 'openai';
    this.modelId = process.env.AEA_LLM_MODEL ?? 'gpt-4o-mini';
  }

  /**
   * Lazily initialize: load compat module and resolve model.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.compat !== undefined) return;
    this.compat = await loadCompat();
    if (this.compat) {
      this.model = this.compat.getModel(this.providerId as never, this.modelId as never) ?? undefined;
    }
  }

  /**
   * Check if a configured LLM model is available.
   */
  async isAvailable(): Promise<boolean> {
    await this.ensureInitialized();
    return this.model !== undefined;
  }

  /**
   * Generate a natural language insight from an AnalyticsReport.
   * Uses pi-ai if a model is configured, otherwise falls back to template.
   */
  async generate(report: AnalyticsReport): Promise<InsightResult> {
    await this.ensureInitialized();

    const payload = JSON.stringify(report.llmPayload, null, 2);

    if (!this.compat || !this.model) {
      return { text: this.templateExplanation(report), source: 'template' };
    }

    try {
      const context: Context = {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Analyze these AI coding agent metrics and provide a root-cause insight with recommendation:\n\n${payload}`,
          timestamp: Date.now(),
        }],
      };

      const response = await this.compat.complete(this.model, context);

      // Extract text from response content blocks
      const textParts: string[] = [];
      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        }
      }

      const text = textParts.join('\n');
      // If LLM returned no text or 0 tokens, fall back to template
      if (!text || (response.usage.input === 0 && response.usage.output === 0)) {
        return { text: this.templateExplanation(report), source: 'template' };
      }

      return {
        text,
        source: 'llm',
        model: `${this.providerId}/${this.modelId}`,
        tokensUsed: { input: response.usage.input, output: response.usage.output },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        text: `${this.templateExplanation(report)}\n\n[LLM fallback: ${errMsg}]`,
        source: 'template',
      };
    }
  }

  /**
   * Template-based explanation — used when no LLM is configured.
   * Follows v6.md Section 11's example format.
   */
  private templateExplanation(report: AnalyticsReport): string {
    const p = report.llmPayload;
    const lines: string[] = [];

    // Summary
    lines.push(`分析 ${p.sessions} 个会话（${p.events} 个事件）的观察结果：`);

    // Health direction
    const health = String(p.healthDirection ?? 'stable');
    if (health === 'improving') {
      lines.push(`整体健康度呈改善趋势，Accept Rate 的 7 日滚动均值为 ${p.avgAcceptRate}。`);
    } else if (health === 'declining') {
      lines.push(`整体健康度呈下降趋势，Accept Rate 的 7 日滚动均值为 ${p.avgAcceptRate}，Retry Rate 为 ${p.avgRetryRate}。`);
    } else {
      lines.push(`整体健康度保持稳定，Accept Rate=${p.avgAcceptRate}，Retry Rate=${p.avgRetryRate}。`);
    }

    // Top failure
    const topFailure = String(p.topFailure ?? 'none');
    if (topFailure !== 'none') {
      lines.push(`主要失败模式为 ${topFailure}，异常分数 ${p.anomalyScore}。`);
      const pattern = String(p.topFailurePattern ?? '');
      if (pattern) lines.push(`典型失败路径：${pattern}`);
    }

    // Context ROI
    const roi = p.contextROI as Record<string, number>[] | undefined;
    if (roi && roi.length > 0) {
      const topPositive = roi.find((r) => Object.values(r)[0] as number > 0);
      const topNegative = roi.find((r) => Object.values(r)[0] as number < 0);
      if (topPositive) {
        const [feat, val] = Object.entries(topPositive)[0];
        lines.push(`Context ROI：${feat} 对 Accept Rate 有正向贡献（+${val}）。`);
      }
      if (topNegative) {
        const [feat, val] = Object.entries(topNegative)[0];
        lines.push(`Context ROI：${feat} 呈负相关（${val}），建议优化。`);
      }
    }

    // Trend
    const acceptTrend = String(p.trendAcceptRate ?? 'stable');
    const retryTrend = String(p.trendRetryRate ?? 'stable');
    if (acceptTrend !== 'stable' || retryTrend !== 'stable') {
      lines.push(`趋势：Accept Rate ${acceptTrend}，Retry Rate ${retryTrend}。`);
    }

    // Top workflow
    const workflow = String(p.topWorkflow ?? '');
    if (workflow && workflow !== 'n/a') {
      lines.push(`最常见工作流：${workflow}`);
    }

    // Recommendation
    if (topFailure === 'retry_loop') {
      lines.push('建议：检查 Prompt 质量，减少模糊指令，考虑增加 Context Selection 优化。');
    } else if (topFailure === 'context_explosion') {
      lines.push('建议：优先优化 Context Selection，减少不必要的文件引用，而非更换模型。');
    } else if (topFailure === 'wrong_context') {
      lines.push('建议：检查 Workspace 上下文是否匹配任务需求，优化检索策略。');
    } else if (health === 'declining') {
      lines.push('建议：深入排查最近变更，关注 Workspace 复杂度和 Prompt 膨胀。');
    } else {
      lines.push('建议：持续监控，关注趋势变化。');
    }

    return lines.join('\n');
  }
}
