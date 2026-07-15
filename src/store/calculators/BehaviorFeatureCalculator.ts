// BehaviorFeatureCalculator — SessionAggregate → session + tool + behavior features.
// v7.md #1: Calculator 只负责派生指标计算。
//
// 该 Calculator 产出三个域的特征（共 19 个），因为它们都派生自同一个
// SessionAggregate（事件序列 + 基础计数）：
//   - session (7): duration / completionCount / retryCount / acceptCount /
//                  rejectCount / acceptRate / retryRate
//   - tool (4): terminalCalls / gitCalls / mcpCalls / filesystemCalls
//   - behavior (8): avgReadBeforeAsk / avgRetryDistance / toolSwitchFrequency /
//                   contextExpansionSpeed / workflowEntropy / retryBurstScore /
//                   editAfterAcceptRatio / workflowLength

import type { SessionAggregate } from '../aggregators/types.js';

export interface BehaviorCalcResult {
  session: Record<string, number>;
  tool: Record<string, number>;
  behavior: Record<string, number>;
}

export class BehaviorFeatureCalculator {
  calculate(agg: SessionAggregate): BehaviorCalcResult {
    return {
      session: this.calcSession(agg),
      tool: this.calcTool(agg),
      behavior: this.calcBehavior(agg),
    };
  }

  private calcSession(agg: SessionAggregate): Record<string, number> {
    return {
      duration: agg.duration,
      completionCount: agg.completions,
      retryCount: agg.retries,
      acceptCount: agg.accepts,
      rejectCount: agg.rejects,
      acceptRate: agg.accepts + agg.rejects > 0
        ? Number((agg.accepts / (agg.accepts + agg.rejects)).toFixed(3))
        : 0,
      retryRate: agg.completions > 0
        ? Number((agg.retries / agg.completions).toFixed(3))
        : 0,
    };
  }

  private calcTool(agg: SessionAggregate): Record<string, number> {
    let terminal = 0, git = 0, mcp = 0, fs = 0;
    for (const e of agg.events) {
      const tool = String(e.metadata.tool ?? '');
      if (e.eventType === 'terminal' || tool.includes('terminal')) terminal++;
      else if (e.eventType === 'commit' || tool.includes('git')) git++;
      else if (tool.includes('mcp')) mcp++;
      else if (e.eventType === 'read_file' || e.eventType === 'edit'
        || tool.includes('read') || tool.includes('file') || tool.includes('edit')) fs++;
      else if (e.eventType === 'tool_call') {
        if (tool.includes('terminal')) terminal++;
        else if (tool.includes('git')) git++;
        else if (tool.includes('mcp')) mcp++;
        else fs++;
      }
    }
    return { terminalCalls: terminal, gitCalls: git, mcpCalls: mcp, filesystemCalls: fs };
  }

  /**
   * Behavior features — describe the dynamics of development, not just counts.
   * v6.md 的高价值创新，v7.md #1 保留并迁入 Calculator 层。
   */
  private calcBehavior(agg: SessionAggregate): Record<string, number> {
    const types = agg.types;
    const n = types.length;

    // avgReadBeforeAsk: 每个 chat/completion 之前累计的 read_file/open_file 数
    let reads = 0, asks = 0, readsBeforeAsk = 0;
    for (const t of types) {
      if (t === 'read_file' || t === 'open_file') reads++;
      if (t === 'chat' || t === 'completion') {
        asks++;
        readsBeforeAsk += reads;
        reads = 0;
      }
    }
    const avgReadBeforeAsk = asks > 0 ? readsBeforeAsk / asks : 0;

    // avgRetryDistance: 连续 retry 之间的平均事件距离
    const retryIdx = types.map((t, i) => (t === 'retry' ? i : -1)).filter((i) => i >= 0);
    let totalDistance = 0;
    for (let i = 1; i < retryIdx.length; i++) totalDistance += retryIdx[i] - retryIdx[i - 1];
    const avgRetryDistance = retryIdx.length > 1 ? totalDistance / (retryIdx.length - 1) : 0;

    // toolSwitchFrequency: 相邻事件类型变化频率
    let switches = 0;
    for (let i = 1; i < types.length; i++) {
      if (types[i] !== types[i - 1]) switches++;
    }
    const toolSwitchFrequency = n > 1 ? switches / (n - 1) : 0;

    // contextExpansionSpeed: 每事件平均 token 增长
    let totalTokens = 0;
    for (const e of agg.events) {
      totalTokens += Number(e.metadata.promptTokens ?? e.metadata.tokenCount ?? 0);
    }
    const contextExpansionSpeed = n > 0 ? totalTokens / n : 0;

    // workflowEntropy: 事件类型分布的 Shannon 熵（归一化到 0..1）
    const counts = new Map<string, number>();
    for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
    let entropy = 0;
    for (const c of counts.values()) {
      const p = c / n;
      entropy -= p * Math.log(p);
    }
    const workflowEntropy = n > 1 ? Number((entropy / Math.log(n)).toFixed(3)) : 0;

    // retryBurstScore: 最长连续 retry / 总 retry
    let maxBurst = 0, currentBurst = 0, totalRetries = 0;
    for (const t of types) {
      if (t === 'retry') {
        currentBurst++;
        totalRetries++;
        if (currentBurst > maxBurst) maxBurst = currentBurst;
      } else {
        currentBurst = 0;
      }
    }
    const retryBurstScore = totalRetries > 0 ? maxBurst / totalRetries : 0;

    // editAfterAcceptRatio: accept 之后立即 edit 的比例
    let editsAfterAccept = 0, accepts = 0;
    for (let i = 1; i < types.length; i++) {
      if (types[i - 1] === 'accept') {
        accepts++;
        if (types[i] === 'edit') editsAfterAccept++;
      }
    }
    const editAfterAcceptRatio = accepts > 0 ? editsAfterAccept / accepts : 0;

    return {
      avgReadBeforeAsk: Number(avgReadBeforeAsk.toFixed(3)),
      avgRetryDistance: Number(avgRetryDistance.toFixed(3)),
      toolSwitchFrequency: Number(toolSwitchFrequency.toFixed(3)),
      contextExpansionSpeed: Number(contextExpansionSpeed.toFixed(3)),
      workflowEntropy,
      retryBurstScore: Number(retryBurstScore.toFixed(3)),
      editAfterAcceptRatio: Number(editAfterAcceptRatio.toFixed(3)),
      workflowLength: n,
    };
  }
}
