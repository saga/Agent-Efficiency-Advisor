// AnalyticsEngine — v7.md #8: 薄编排器，只负责 Merge。
// 原来的 Trend/ROI/Failure/Workflow/Behavior 逻辑已拆分到 5 个独立 Analyzer。
// AnalyticsEngine 只负责：调用各 Analyzer → Merge 结果 → 构建 AnalyticsSummary。
//
// v7.md #9: LLM Payload 改为 AnalyticsSummary 强类型接口（替代 loose JSON）。

import type { EventStore } from '../store/EventStore.js';
import type { FeatureStore } from '../store/FeatureStore.js';
import type { EmbeddingStore } from '../embedding/EmbeddingStore.js';
import type { BehaviorReport } from './BehaviorModel.js';
import type { WorkflowGraph } from './WorkflowMiner.js';
import type { TrendReport } from './TrendAnalysis.js';
import type { AnalyticsSummary } from './AnalyticsSummary.js';
import type { Analyzer } from './analyzers/types.js';
import { BehaviorAnalyzer } from './analyzers/BehaviorAnalyzer.js';
import { WorkflowAnalyzer } from './analyzers/WorkflowAnalyzer.js';
import { TrendAnalyzer } from './analyzers/TrendAnalyzer.js';
import { FailureAnalyzer } from './analyzers/FailureAnalyzer.js';
import { ROIAnalyzer } from './analyzers/ROIAnalyzer.js';
import { calibrateTemperature, applyTemperature } from '../v5/trust/ConfidenceCalibration.js';
import type { EvaluationSample, ModelSize } from '../v5/trust/types.js';

export interface FailureClassification {
  sessionId: string;
  failureType: string;
  confidence: number;
  evidence: string[];
}

export interface ContextROI {
  feature: string;
  contribution: number;
}

export interface AnalyticsReport {
  generatedAt: number;
  sessions: number;
  events: number;
  behavior: BehaviorReport;
  workflow: WorkflowGraph;
  trends: TrendReport;
  failures: FailureClassification[];
  contextROI: ContextROI[];
  // v7.md #9: 强类型 AnalyticsSummary 替代 loose JSON
  summary: AnalyticsSummary;
}

// V5 ModelSize 三档，用于 calibrateTemperature 的类型兼容
const MODELS: ModelSize[] = ['mini', 'medium', 'large'];

// 将 failureType 映射到 V5 ModelSize，兼容 calibrateTemperature 的类型要求
function failureTypeToModelSize(failureType: string): ModelSize {
  switch (failureType) {
    case 'none': return 'mini';
    case 'retry_loop':
    case 'wrong_context': return 'medium';
    case 'context_explosion':
    case 'user_cancel': return 'large';
    default: return 'mini';
  }
}

export class AnalyticsEngine {
  // v7.md #8/#10: Analyzer 注册表，AnalyticsEngine 只负责 Merge。
  private analyzers = new Map<string, Analyzer>();

  constructor(
    private eventStore: EventStore,
    private featureStore: FeatureStore,
    private embeddingStore: EmbeddingStore
  ) {
    // 注册默认的 5 个 Analyzer
    this.registerAnalyzer(new BehaviorAnalyzer());
    this.registerAnalyzer(new WorkflowAnalyzer());
    this.registerAnalyzer(new TrendAnalyzer());
    this.registerAnalyzer(new FailureAnalyzer());
    this.registerAnalyzer(new ROIAnalyzer());
  }

  /**
   * v7.md #10: 注册一个 Analyzer（插件化）。
   */
  registerAnalyzer(analyzer: Analyzer): void {
    this.analyzers.set(analyzer.id, analyzer);
  }

  /**
   * v7.md #8: 只负责 Merge — 调用各 Analyzer → 组装报告。
   */
  analyze(): AnalyticsReport {
    const sessionIds = this.eventStore.getSessionIds();
    const sessions = sessionIds.map((sid) => this.eventStore.getBySession(sid));
    const allEvents = sessions.flat();

    const ctx = {
      eventStore: this.eventStore,
      featureStore: this.featureStore,
      sessionIds,
      sessions,
      allEvents,
    };

    // 调用各 Analyzer（v7.md #8: 编排器只 Merge）
    const behavior = this.run('behavior', ctx) as BehaviorReport;
    const workflow = this.run('workflow', ctx) as WorkflowGraph;
    const trends = this.run('trend', ctx) as TrendReport;
    const failures = this.run('failure', ctx) as FailureClassification[];
    const contextROI = this.run('roi', ctx) as ContextROI[];

    // v7.md #9: 构建强类型 AnalyticsSummary
    const summary = this.buildSummary({
      sessions: sessionIds.length,
      events: allEvents.length,
      behavior,
      workflow,
      trends,
      failures,
      contextROI,
    });

    // V5.2 Trust Engine 接入（P3-7）：置信度校准
    // 对 failures 中存在非 'none' 失败分类的情况，用 V5 calibrateTemperature 做校准
    const nonNoneFailures = failures.filter((f) => f.failureType !== 'none');
    if (nonNoneFailures.length > 0) {
      // 从 failures 构造 EvaluationSample[]：predictedLabel 映射自 failureType，
      // confidence 取自 failure.confidence，correct 表示 failureType === 'none'
      const samples: EvaluationSample[] = failures.map((f) => {
        const predictedLabel = failureTypeToModelSize(f.failureType);
        const correct = f.failureType === 'none';
        // correct 时 trueLabel 与 predictedLabel 一致；否则取另一个标签表示预测错误
        const trueLabel: ModelSize = correct ? predictedLabel : (predictedLabel === 'mini' ? 'large' : 'mini');
        // 把 confidence 放在 predictedLabel 上，剩余均分给其他两个模型档位
        const probabilities = { mini: 0, medium: 0, large: 0 } as Record<ModelSize, number>;
        probabilities[predictedLabel] = f.confidence;
        const rest = (1 - f.confidence) / 2;
        for (const m of MODELS) {
          if (m !== predictedLabel) probabilities[m] = rest;
        }
        return { features: {}, trueLabel, predictedLabel, probabilities, correct };
      });
      const calibration = calibrateTemperature(samples);
      // 用校准后的 temperature 对 top failure（置信度最高的非 none 失败）做校准
      const topFailure = nonNoneFailures.sort((a, b) => b.confidence - a.confidence)[0];
      const topPred = failureTypeToModelSize(topFailure.failureType);
      const topProbs = { mini: 0, medium: 0, large: 0 } as Record<ModelSize, number>;
      topProbs[topPred] = topFailure.confidence;
      const topRest = (1 - topFailure.confidence) / 2;
      for (const m of MODELS) {
        if (m !== topPred) topProbs[m] = topRest;
      }
      const calibratedProbs = applyTemperature(topProbs, calibration.temperature);
      summary.calibratedConfidence = Number(Math.max(...MODELS.map((m) => calibratedProbs[m])).toFixed(3));
    }

    // V5.2 Trust Engine 接入（P3-7）：特征重要性
    // 简化版：直接用 contextROI 中已有的 contribution 值作为 importance，
    // 按绝对值排序取 top 5（sessions >= 10 时才计算）
    if (sessionIds.length >= 10) {
      summary.shapTopFeatures = contextROI
        .slice()
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 5)
        .map((r) => ({ feature: r.feature, importance: r.contribution }));
    }

    return {
      generatedAt: Date.now(),
      sessions: sessionIds.length,
      events: allEvents.length,
      behavior,
      workflow,
      trends,
      failures,
      contextROI,
      summary,
    };
  }

  private run(id: string, ctx: any): unknown {
    const analyzer = this.analyzers.get(id);
    if (!analyzer) throw new Error(`Analyzer '${id}' not registered`);
    return analyzer.analyze(ctx);
  }

  /**
   * v7.md #9: 构建强类型 AnalyticsSummary（替代 loose JSON llmPayload）。
   */
  private buildSummary(data: {
    sessions: number;
    events: number;
    behavior: BehaviorReport;
    workflow: WorkflowGraph;
    trends: TrendReport;
    failures: FailureClassification[];
    contextROI: ContextROI[];
  }): AnalyticsSummary {
    const topFailure = data.failures
      .filter((f) => f.failureType !== 'none')
      .sort((a, b) => b.confidence - a.confidence)[0];

    const topWorkflow = data.behavior.topWorkflows[0];
    const topFailurePattern = data.workflow.failurePatterns[0];

    const acceptTrend = data.trends.trends.find((t) => t.metric === 'acceptRate');
    const retryTrend = data.trends.trends.find((t) => t.metric === 'retryRate');

    return {
      sessions: data.sessions,
      events: data.events,
      avgAcceptRate: Number(acceptTrend?.rollingAvg.toFixed(3) ?? 0),
      avgRetryRate: Number(retryTrend?.rollingAvg.toFixed(3) ?? 0),
      healthDirection: data.trends.summary.healthDirection,
      trendAcceptRate: (acceptTrend?.direction ?? 'stable') as 'up' | 'down' | 'stable',
      trendRetryRate: (retryTrend?.direction ?? 'stable') as 'up' | 'down' | 'stable',
      topWorkflow: topWorkflow ? topWorkflow.sequence.join('→') : 'n/a',
      anomalyScore: data.behavior.anomalyScore,
      topFailure: topFailure ? topFailure.failureType : 'none',
      topFailurePattern: topFailurePattern ? topFailurePattern.path.join('→') : 'n/a',
      contextROI: data.contextROI.slice(0, 3).map((r) => ({ feature: r.feature, contribution: r.contribution })),
    };
  }
}
