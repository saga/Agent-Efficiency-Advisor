/**
 * @legacy V1/V2 历史分析模块
 *
 * 此模块属于 V1/V2 遗留代码,保留用于离线训练数据参考。
 * 新代码应使用 V6/V7 的 src/store/ (EventStore/FeatureStore) 和 src/ml/ 模块。
 * 详见 docs/ARCHITECTURE.md 和 IMPROVEMENT_PLAN.md。
 */
export * from './collector.js';
export * from './featureExtractor.js';
export * from './evaluator.js';
export * from './outcomeSignals.js';
