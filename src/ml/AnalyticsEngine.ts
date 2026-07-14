// AnalyticsEngine — orchestrates all ML models into a structured report.
// v6.md: the bridge between Feature Store + Embedding Store and the LLM layer.
//
// Produces a compact AnalyticsReport (~500 tokens when serialized) that the
// InsightsEngine sends to a lightweight LLM for natural language explanation.

import type { EventStore } from '../store/EventStore.js';
import type { FeatureStore } from '../store/FeatureStore.js';
import type { EmbeddingStore } from '../embedding/EmbeddingStore.js';
import { BehaviorModel, type BehaviorReport } from './BehaviorModel.js';
import { WorkflowMiner, type WorkflowGraph } from './WorkflowMiner.js';
import { TrendAnalysis, type TrendReport } from './TrendAnalysis.js';

export interface FailureClassification {
  sessionId: string;
  failureType: string;    // 'wrong_context' | 'retry_loop' | 'context_explosion' | 'tool_error' | 'user_cancel' | 'none'
  confidence: number;
  evidence: string[];
}

export interface ContextROI {
  feature: string;
  contribution: number;   // positive = helps, negative = hurts
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
  // Compact summary for LLM input (the ~500 token payload from v6.md Section 11)
  llmPayload: Record<string, unknown>;
}

export class AnalyticsEngine {
  constructor(
    private eventStore: EventStore,
    private featureStore: FeatureStore,
    private embeddingStore: EmbeddingStore
  ) {}

  /**
   * Run full analytics pipeline and produce a structured report.
   */
  analyze(): AnalyticsReport {
    const sessionIds = this.eventStore.getSessionIds();
    const sessions = sessionIds.map((sid) => this.eventStore.getBySession(sid));
    const allEvents = sessions.flat();

    // 1. Behavior Model (Markov)
    const behaviorModel = new BehaviorModel();
    behaviorModel.train(sessions);
    const behavior = behaviorModel.report();

    // 2. Workflow Mining (Heuristic Miner)
    const miner = new WorkflowMiner();
    const workflow = miner.mine(sessions);

    // 3. Trend Analysis
    const trendAnalysis = new TrendAnalysis();
    const trends = trendAnalysis.analyze(allEvents);

    // 4. Failure Classification (rule-based, CatBoost can plug in later)
    const failures = this.classifyFailures(sessionIds);

    // 5. Context ROI (feature importance via correlation with acceptRate)
    const contextROI = this.computeContextROI();

    // 6. Build compact LLM payload
    const llmPayload = this.buildLLMPayload({
      sessions: sessionIds.length,
      events: allEvents.length,
      behavior,
      workflow,
      trends,
      failures,
      contextROI,
    });

    return {
      generatedAt: Date.now(),
      sessions: sessionIds.length,
      events: allEvents.length,
      behavior,
      workflow,
      trends,
      failures,
      contextROI,
      llmPayload,
    };
  }

  /**
   * Rule-based failure classification.
   * v6.md Section 7: categories = wrong_context, hallucination, timeout, retry_loop, user_cancel, tool_error
   */
  private classifyFailures(sessionIds: string[]): FailureClassification[] {
    const results: FailureClassification[] = [];

    for (const sid of sessionIds) {
      const events = this.eventStore.getBySession(sid);
      const behavior = this.featureStore.read('behavior', sid);
      const session = this.featureStore.read('session', sid);
      if (!events.length) continue;

      const bf = behavior?.features ?? {};
      const sf = session?.features ?? {};
      const evidence: string[] = [];
      let failureType = 'none';
      let confidence = 0;

      // Retry loop: high retryBurstScore + high retryRate
      if (bf.retryBurstScore > 0.5 && sf.retryRate > 0.3) {
        failureType = 'retry_loop';
        confidence = Math.min(1, bf.retryBurstScore + sf.retryRate);
        evidence.push(`retryBurstScore=${bf.retryBurstScore.toFixed(2)}`);
        evidence.push(`retryRate=${sf.retryRate.toFixed(2)}`);
      }
      // Context explosion: high contextExpansionSpeed + high token count
      else if (bf.contextExpansionSpeed > 500 || (sf.retryRate > 0.3 && bf.contextExpansionSpeed > 200)) {
        failureType = 'context_explosion';
        confidence = Math.min(1, bf.contextExpansionSpeed / 1000);
        evidence.push(`contextExpansionSpeed=${bf.contextExpansionSpeed.toFixed(0)}`);
      }
      // Wrong context: low workflowEntropy + high retryRate (stuck despite structured workflow)
      else if (bf.workflowEntropy < 0.7 && sf.retryRate > 0.2) {
        failureType = 'wrong_context';
        confidence = 0.6;
        evidence.push(`workflowEntropy=${bf.workflowEntropy.toFixed(2)}`);
        evidence.push(`retryRate=${sf.retryRate.toFixed(2)}`);
      }
      // User cancel: ends with reject, no accept
      else if (events[events.length - 1]?.eventType === 'reject' && sf.acceptCount === 0) {
        failureType = 'user_cancel';
        confidence = 0.8;
        evidence.push('session ends with reject, no accepts');
      }

      results.push({ sessionId: sid, failureType, confidence: Number(confidence.toFixed(3)), evidence });
    }

    return results;
  }

  /**
   * Context ROI — SHAP-like feature contribution to acceptRate.
   * v6.md Section 8: which context features actually contribute to success?
   * Uses simple correlation as a proxy for SHAP (CatBoost SHAP can plug in later).
   */
  private computeContextROI(): ContextROI[] {
    const sessionIds = this.eventStore.getSessionIds();
    const data: { features: Record<string, number>; acceptRate: number }[] = [];

    for (const sid of sessionIds) {
      const behavior = this.featureStore.read('behavior', sid);
      const session = this.featureStore.read('session', sid);
      if (!behavior || !session) continue;
      data.push({
        features: { ...behavior.features, ...session.features },
        acceptRate: session.features.acceptRate ?? 0,
      });
    }

    if (data.length < 2) return [];

    // Compute correlation of each feature with acceptRate
    const allKeys = new Set<string>();
    for (const d of data) for (const k of Object.keys(d.features)) allKeys.add(k);

    const roi: ContextROI[] = [];
    for (const key of allKeys) {
      const corr = this.correlation(
        data.map((d) => d.features[key] ?? 0),
        data.map((d) => d.acceptRate)
      );
      if (Math.abs(corr) > 0.1) {
        roi.push({ feature: key, contribution: Number(corr.toFixed(3)) });
      }
    }
    roi.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    return roi.slice(0, 8);
  }

  private correlation(xs: number[], ys: number[]): number {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    const denom = Math.sqrt(dx * dy);
    return denom === 0 ? 0 : num / denom;
  }

  /**
   * Build the compact payload for the LLM (v6.md Section 11).
   * Target: ~500 tokens of structured JSON.
   */
  private buildLLMPayload(ctx: {
    sessions: number;
    events: number;
    behavior: BehaviorReport;
    workflow: WorkflowGraph;
    trends: TrendReport;
    failures: FailureClassification[];
    contextROI: ContextROI[];
  }): Record<string, unknown> {
    const topFailure = ctx.failures
      .filter((f) => f.failureType !== 'none')
      .sort((a, b) => b.confidence - a.confidence)[0];

    const topWorkflow = ctx.behavior.topWorkflows[0];
    const topFailurePattern = ctx.workflow.failurePatterns[0];

    return {
      sessions: ctx.sessions,
      events: ctx.events,
      avgAcceptRate: Number(ctx.trends.trends.find((t) => t.metric === 'acceptRate')?.rollingAvg.toFixed(3) ?? 0),
      avgRetryRate: Number(ctx.trends.trends.find((t) => t.metric === 'retryRate')?.rollingAvg.toFixed(3) ?? 0),
      healthDirection: ctx.trends.summary.healthDirection,
      topWorkflow: topWorkflow ? topWorkflow.sequence.join('→') : 'n/a',
      topFailure: topFailure ? topFailure.failureType : 'none',
      topFailurePattern: topFailurePattern ? topFailurePattern.path.join('→') : 'n/a',
      anomalyScore: ctx.behavior.anomalyScore,
      contextROI: ctx.contextROI.slice(0, 3).map((r) => ({ [r.feature]: r.contribution })),
      trendAcceptRate: ctx.trends.trends.find((t) => t.metric === 'acceptRate')?.direction ?? 'stable',
      trendRetryRate: ctx.trends.trends.find((t) => t.metric === 'retryRate')?.direction ?? 'stable',
    };
  }
}
