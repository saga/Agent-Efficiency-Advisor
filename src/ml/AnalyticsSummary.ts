// AnalyticsSummary — v7.md #9: LLM Payload Schema 化。
// 替代原来的 loose JSON (llmPayload: Record<string, unknown>)。
// 以后 Prompt 固定，模型也容易升级。

export interface AnalyticsSummary {
  // 规模
  sessions: number;
  events: number;
  // 核心指标
  avgAcceptRate: number;
  avgRetryRate: number;
  // 趋势
  healthDirection: 'improving' | 'declining' | 'stable';
  trendAcceptRate: 'up' | 'down' | 'stable';
  trendRetryRate: 'up' | 'down' | 'stable';
  // 行为
  topWorkflow: string;
  anomalyScore: number;
  // 失败
  topFailure: string;
  topFailurePattern: string;
  // Context ROI
  contextROI: { feature: string; contribution: number }[];
  // V5.2 Trust Engine 接入：置信度校准后的值（P3-7）
  calibratedConfidence?: number;
  // V5.2 Trust Engine 接入：基于 permutation importance 的 top 特征（P3-7）
  shapTopFeatures?: Array<{ feature: string; importance: number }>;
}
