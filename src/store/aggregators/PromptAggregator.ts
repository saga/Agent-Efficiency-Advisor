// PromptAggregator — Event → PromptAggregate[].
// v7.md #1: 按 promptId 分组 chat 事件，提取原始 token/context 字段。
// 不计算 promptDensity / historyRatio（留给 ContextFeatureCalculator）。

import type { IDEEvent } from '../types.js';
import type { PromptAggregate } from './types.js';

export class PromptAggregator {
  aggregate(events: IDEEvent[]): PromptAggregate[] {
    const byPrompt = new Map<string, IDEEvent[]>();
    for (const e of events) {
      if (e.eventType === 'chat') {
        const pid = String(e.metadata.promptId ?? e.id ?? `prompt-${e.timestamp}`);
        if (!byPrompt.has(pid)) byPrompt.set(pid, []);
        byPrompt.get(pid)!.push(e);
      }
    }

    const out: PromptAggregate[] = [];
    for (const [promptId, evts] of byPrompt) {
      const first = evts[0];
      out.push({
        promptId,
        tokenCount: Number(first.metadata.tokenCount ?? 0),
        historyLength: Number(first.metadata.historyLength ?? 0),
        retrievedFiles: Number(first.metadata.retrievedFiles ?? 0),
        retrievedSymbols: Number(first.metadata.retrievedSymbols ?? 0),
        contextToken: Number(first.metadata.contextToken ?? first.metadata.tokenCount ?? 0),
        historyToken: Number(first.metadata.historyToken ?? 0),
      });
    }
    return out;
  }
}
