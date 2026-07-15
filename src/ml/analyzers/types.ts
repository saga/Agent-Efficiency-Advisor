// Analyzer 插件接口 — v7.md #8: AnalyticsEngine 拆分为 5 个 Analyzer + 编排器。
// v7.md #10: Analyzer Registry 注册 Behavior/Trend/Workflow/Failure/ROI 等 Analyzer。
//
// 每个 Analyzer 只负责自己的分析维度，输出结构化结果。
// AnalyticsEngine 只负责 Merge，不再包含任何分析逻辑。

import type { IDEEvent } from '../../store/types.js';
import type { FeatureStore } from '../../store/FeatureStore.js';
import type { EventStore } from '../../store/EventStore.js';

/** Analyzer 上下文 — 提供给每个 Analyzer 的输入。 */
export interface AnalyzerContext {
  eventStore: EventStore;
  featureStore: FeatureStore;
  sessionIds: string[];
  sessions: IDEEvent[][];   // 每个 session 的事件序列
  allEvents: IDEEvent[];    // 所有事件（已展平）
}

/** Analyzer 接口 — v7.md #8/#10: 插件化。 */
export interface Analyzer<T = unknown> {
  /** 唯一标识。 */
  id: string;
  /** 执行分析，返回结构化结果。 */
  analyze(ctx: AnalyzerContext): T;
}
