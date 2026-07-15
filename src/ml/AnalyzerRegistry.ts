// AnalyzerRegistry — v7.md #10: 注册 Behavior/Trend/Workflow/Failure/ROI 等 Analyzer。
// 补齐整个系统的元数据体系，让 Analyzer 也成为可查询、可插拔的组件。
//
// | Registry          | 作用                                                |
// | Feature Registry  | Feature 定义                                        |
// | Event Registry    | Event Schema、Provider Mapping、版本管理                |
// | Analyzer Registry | 注册 Behavior、Trend、Workflow、Failure、ROI 等 Analyzer |

import type { Analyzer } from './analyzers/types.js';
import { BehaviorAnalyzer } from './analyzers/BehaviorAnalyzer.js';
import { WorkflowAnalyzer } from './analyzers/WorkflowAnalyzer.js';
import { TrendAnalyzer } from './analyzers/TrendAnalyzer.js';
import { FailureAnalyzer } from './analyzers/FailureAnalyzer.js';
import { ROIAnalyzer } from './analyzers/ROIAnalyzer.js';

export interface AnalyzerMetadata {
  id: string;
  description: string;
  /** 该 Analyzer 产出哪些指标（用于 Dashboard 展示）。 */
  outputs: string[];
}

/** 内置 Analyzer 元数据。 */
export const CORE_ANALYZER_METADATA: AnalyzerMetadata[] = [
  { id: 'behavior', description: '一阶 Markov 链 + 行为模式', outputs: ['topWorkflows', 'anomalyScore', 'transitionMatrix'] },
  { id: 'workflow', description: 'Heuristic Miner 工作流挖掘', outputs: ['frequentPaths', 'failurePatterns', 'dependencyGraph'] },
  { id: 'trend', description: '线性回归 + 7 日滚动平均', outputs: ['trends', 'healthDirection', 'rollingAvg'] },
  { id: 'failure', description: '规则驱动的失败分类', outputs: ['failureType', 'confidence', 'evidence'] },
  { id: 'roi', description: 'Context ROI 特征贡献度', outputs: ['feature', 'contribution'] },
];

export class AnalyzerRegistry {
  private analyzers = new Map<string, Analyzer>();
  private metadata = new Map<string, AnalyzerMetadata>();

  constructor() {
    // 注册内置 Analyzer
    this.register(new BehaviorAnalyzer(), CORE_ANALYZER_METADATA[0]);
    this.register(new WorkflowAnalyzer(), CORE_ANALYZER_METADATA[1]);
    this.register(new TrendAnalyzer(), CORE_ANALYZER_METADATA[2]);
    this.register(new FailureAnalyzer(), CORE_ANALYZER_METADATA[3]);
    this.register(new ROIAnalyzer(), CORE_ANALYZER_METADATA[4]);
  }

  /**
   * 注册一个 Analyzer 及其元数据。
   */
  register(analyzer: Analyzer, metadata?: AnalyzerMetadata): void {
    this.analyzers.set(analyzer.id, analyzer);
    if (metadata) {
      this.metadata.set(analyzer.id, metadata);
    } else {
      // 自动生成基本元数据
      this.metadata.set(analyzer.id, {
        id: analyzer.id,
        description: `Analyzer: ${analyzer.id}`,
        outputs: [],
      });
    }
  }

  /**
   * 获取一个 Analyzer 实例。
   */
  get(id: string): Analyzer | undefined {
    return this.analyzers.get(id);
  }

  /**
   * 获取所有已注册的 Analyzer。
   */
  getAll(): Analyzer[] {
    return Array.from(this.analyzers.values());
  }

  /**
   * 获取所有 Analyzer 元数据（用于 Dashboard 展示）。
   */
  getAllMetadata(): AnalyzerMetadata[] {
    return Array.from(this.metadata.values());
  }

  /**
   * 获取一个 Analyzer 的元数据。
   */
  getMetadata(id: string): AnalyzerMetadata | undefined {
    return this.metadata.get(id);
  }
}
