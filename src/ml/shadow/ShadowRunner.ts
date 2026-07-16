import type { SessionState } from '../../types.js';
import type { Context, Model, Api, AssistantMessage } from '@earendil-works/pi-ai';
import { extractModelSizeFeatures, LABEL_INDEX, type ModelSizeLabel } from '../features.js';

export interface ShadowResult {
  originalModel: string;
  shadowModel: string;
  originalSuccess: boolean;
  shadowSuccess: boolean;
  label: 'mini' | 'medium' | 'large';
  confidence: number;
}

export interface ShadowTaskRunner {
  run(state: SessionState, recommendedModel: string): Promise<ShadowResult>;
}

export interface ShadowRunnerOptions {
  sampleRate: number;
  shadowModel: string;
  runner: ShadowTaskRunner;
}

export class ShadowRunner {
  private total = 0;
  private sampled = 0;

  constructor(private options: ShadowRunnerOptions) {}

  shouldSample(): boolean {
    this.total++;
    if (Math.random() < this.options.sampleRate) {
      this.sampled++;
      return true;
    }
    return false;
  }

  async evaluate(state: SessionState, recommendedModel: string): Promise<ShadowResult | undefined> {
    if (!this.shouldSample()) return undefined;
    return this.options.runner.run(state, recommendedModel);
  }

  stats(): { total: number; sampled: number; rate: number } {
    return {
      total: this.total,
      sampled: this.sampled,
      rate: this.total > 0 ? this.sampled / this.total : 0,
    };
  }
}

// ============================================================================
// MockShadowTaskRunner —— 仅用于 demo / 本地测试。
// 它基于简单启发式模拟 shadow 结果,不调用真实模型,产出的标签质量有限。
// 生产环境应使用 LlmShadowTaskRunner(调用真实轻量 LLM 生成训练标签),
// 或实现自定义的 ShadowTaskRunner 注入到 ShadowRunner。
// ============================================================================
export class MockShadowTaskRunner implements ShadowTaskRunner {
  async run(state: SessionState, recommendedModel: string): Promise<ShadowResult> {
    // Simulate outcomes based on task characteristics.
    const isSimple =
      state.promptTokens < 8000 &&
      state.toolCalls <= 5 &&
      state.filesEdited.size <= 2 &&
      state.retries === 0;

    const originalSuccess = true;
    const shadowSuccess = isSimple || Math.random() > 0.3;

    // If shadow succeeds, the recommended smaller model is sufficient.
    const label: ShadowResult['label'] = shadowSuccess
      ? (recommendedModel as ShadowResult['label'])
      : bumpModel(recommendedModel);

    return {
      originalModel: state.sessionId,
      shadowModel: this.options.shadowModel,
      originalSuccess,
      shadowSuccess,
      label,
      confidence: shadowSuccess ? 0.95 : 0.6,
    };
  }

  constructor(private options: { shadowModel: string }) {}
}

// ============================================================================
// LlmShadowTaskRunner —— Shadow 接口的生产实现。
// 调用轻量 LLM(如 GPT-5-mini)判断当前任务是否能由更小模型完成,从而生成
// 高质量训练标签。初始化方式与 InsightsEngine 一致(@earendil-works/pi-ai/compat)。
// 若 LLM 不可用(未配置 API key / 模块加载失败 / 调用或解析异常),自动 fallback
// 到 MockShadowTaskRunner 的启发式逻辑,保证 ShadowRunner 始终可用。
// ============================================================================
export class LlmShadowTaskRunner implements ShadowTaskRunner {
  private providerId: string;
  private modelId: string;
  private compat: CompatModule | null | undefined;
  private model: Model<Api> | undefined;
  // LLM 不可用时的 fallback 实现
  private mockFallback: MockShadowTaskRunner;

  constructor(private options: { shadowModel: string; providerId?: string; modelId?: string }) {
    // 与 InsightsEngine 相同的初始化方式:优先读取 shadow 专用环境变量,回退到通用 LLM 配置
    this.providerId =
      options.providerId ??
      process.env.AEA_SHADOW_LLM_PROVIDER ??
      process.env.AEA_LLM_PROVIDER ??
      'openai';
    this.modelId = options.modelId ?? process.env.AEA_SHADOW_LLM_MODEL ?? 'gpt-5-mini';
    this.mockFallback = new MockShadowTaskRunner({ shadowModel: options.shadowModel });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.compat !== undefined) return;
    this.compat = await loadCompat();
    if (this.compat) {
      this.model = this.compat.getModel(this.providerId as never, this.modelId as never) ?? undefined;
    }
  }

  async run(state: SessionState, recommendedModel: string): Promise<ShadowResult> {
    await this.ensureInitialized();

    // LLM 不可用 → fallback 到 Mock 逻辑
    if (!this.compat || !this.model) {
      return this.mockFallback.run(state, recommendedModel);
    }

    // a. 用 extractModelSizeFeatures 从 SessionState 提取特征
    const features = extractModelSizeFeatures(state);

    try {
      // b. 调用 pi-ai 的轻量 LLM(与 InsightsEngine 相同的 complete 调用方式)
      const context: Context = {
        systemPrompt: SHADOW_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildShadowPrompt(features, recommendedModel),
            timestamp: Date.now(),
          },
        ],
      };
      const response = await this.compat.complete(this.model, context);
      const text = extractText(response);

      // c. 解析 LLM 判断结果,让 LLM 决定该任务能由多小的模型完成
      const parsed = parseLabelResponse(text);
      if (!parsed) {
        // 解析失败 → fallback
        return this.mockFallback.run(state, recommendedModel);
      }

      const label = parsed.label;
      const confidence = parsed.confidence;
      // shadowSuccess: LLM 判定的最小可行模型不大于当前推荐模型,
      // 即更小模型即可完成任务 → shadow 成功
      const recIdx = LABEL_INDEX[recommendedModel as ModelSizeLabel];
      const shadowSuccess = recIdx !== undefined && LABEL_INDEX[label] <= recIdx;

      return {
        originalModel: recommendedModel,
        shadowModel: this.options.shadowModel,
        originalSuccess: true,
        shadowSuccess,
        label,
        confidence,
      };
    } catch {
      // d. LLM 调用异常 → fallback 到 MockShadowTaskRunner 逻辑
      return this.mockFallback.run(state, recommendedModel);
    }
  }
}

function bumpModel(model: string): 'mini' | 'medium' | 'large' {
  if (model === 'mini') return 'medium';
  if (model === 'medium') return 'large';
  return 'large';
}

// ----------------------------------------------------------------------------
// pi-ai compat 模块的懒加载(与 InsightsEngine 相同的实现思路,动态 import 绕过
// tsx 的 exports field 解析问题)。
// ----------------------------------------------------------------------------
interface CompatModule {
  complete: (model: Model<Api>, context: Context, options?: Record<string, unknown>) => Promise<AssistantMessage>;
  getModel: (provider: string, id: string) => Model<Api> | undefined;
}

let compatPromise: Promise<CompatModule | null> | null = null;

function loadCompat(): Promise<CompatModule | null> {
  if (!compatPromise) {
    compatPromise = import('@earendil-works/pi-ai/compat')
      .then((m: any) => m as CompatModule)
      .catch(() => null);
  }
  return compatPromise;
}

// ----------------------------------------------------------------------------
// LLM prompt / 解析辅助
// ----------------------------------------------------------------------------
const SHADOW_SYSTEM_PROMPT = `You are a model-sizing judge for an AI coding-agent observatory. Given a session's feature vector and the currently recommended model size, decide the MINIMAL model size that could successfully complete this task.

Model sizes (small -> large): mini, medium, large.
- mini: simple, low-token, few-tool tasks (small edits, single-file reads, no retries, no loops).
- medium: moderate context, multiple tools, several file edits, possibly a few retries.
- large: heavy context utilization, many tool calls, retry loops, sub-agents, or large multi-file diffs.

Respond with STRICT JSON only, no prose:
{"label":"mini|medium|large","confidence":0.0-1.0,"reason":"<short>"}`;

function buildShadowPrompt(
  features: ReturnType<typeof extractModelSizeFeatures>,
  recommendedModel: string,
): string {
  const lines = [
    `Recommended model: ${recommendedModel}`,
    'Session features:',
    `  promptTokens: ${features.promptTokens}`,
    `  completionTokens: ${features.completionTokens}`,
    `  contextTokens: ${features.contextTokens}`,
    `  contextUtilization: ${features.contextUtilization.toFixed(3)}`,
    `  toolCalls: ${features.toolCalls}`,
    `  readFiles: ${features.readFiles}`,
    `  edits: ${features.edits}`,
    `  retries: ${features.retries}`,
    `  retryRate: ${features.retryRate.toFixed(3)}`,
    `  uniqueFilesRead: ${features.uniqueFilesRead}`,
    `  uniqueFilesEdited: ${features.uniqueFilesEdited}`,
    `  elapsedMs: ${features.elapsedMs}`,
    `  readToEditRatio: ${features.readToEditRatio.toFixed(3)}`,
    `  hasLoop: ${features.hasLoop}`,
    `  subAgents: ${features.subAgents}`,
    '',
    'Decide the MINIMAL model size that can complete this task. Respond with STRICT JSON only.',
  ];
  return lines.join('\n');
}

function extractText(response: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function parseLabelResponse(
  text: string,
): { label: ModelSizeLabel; confidence: number } | null {
  // 提取第一个 JSON 对象(兼容 LLM 偶尔包裹的额外文字)
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { label?: unknown; confidence?: unknown };
    if (obj.label !== 'mini' && obj.label !== 'medium' && obj.label !== 'large') return null;
    const confidence = Number(obj.confidence);
    if (!Number.isFinite(confidence)) return null;
    return { label: obj.label, confidence: Math.max(0, Math.min(1, confidence)) };
  } catch {
    return null;
  }
}
