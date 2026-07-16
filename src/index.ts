// Real-time observability
export * from './realtime/LogSource.js';
export * from './realtime/CopilotSource.js';
export * from './realtime/MockLogSource.js';
export * from './realtime/EventBus.js';
export * from './realtime/LogParser.js';
export * from './realtime/TailManager.js';
export * from './realtime/SessionState.js';
export * from './realtime/SessionManager.js';

// Rules
export * from './rules/Rule.js';
export * from './rules/RuleEngine.js';
export * from './rules/ruleRegistry.js';

// Metrics & health
export * from './metrics/Metrics.js';
export * from './metrics/HealthScorer.js';

// Advisor
export * from './advisor/Advisor.js';

// Dashboard & notifications
export * from './dashboard/Dashboard.js';
export * from './notifications/Notifier.js';
export * from './notifications/NodeNotifier.js';

// ML model sizing
export * from './ml/index.js';

// Shared types
export * from './types.js';

// Historical analysis (V1/V2)
/** @legacy V1/V2 历史分析模块 — 保留用于离线训练数据参考,新代码应使用 V6/V7 模块 */
export * as history from './history/index.js';

// V5 Runtime Intelligence Platform
export * as v5 from './v5/index.js';
