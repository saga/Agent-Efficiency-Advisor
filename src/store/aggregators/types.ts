// Aggregate types — intermediate representations between Event and Feature.
// v7.md #1: Aggregator 只负责 Event → Intermediate Aggregate。
// 一个 Aggregate 是"未被加工的事实集合"，不包含任何派生指标（rate/entropy/complexity）。

import type { IDEEvent, IDEEventType } from '../types.js';

/** Workspace 级别的原始事实：文件集合、语言集合、依赖、分支、LOC。 */
export interface WorkspaceAggregate {
  workspaceId: string;
  files: Set<string>;
  languages: Set<string>;
  branches: Set<string>;
  totalLOC: number;
  maxDependencies: number;
}

/** Session 级别的原始事实：事件序列、计数、时间窗。 */
export interface SessionAggregate {
  sessionId: string;
  workspaceId: string;
  events: IDEEvent[];
  types: IDEEventType[];
  startTime: number;
  endTime: number;
  duration: number;
  completions: number;
  retries: number;
  accepts: number;
  rejects: number;
}

/** Prompt 级别的原始事实：token / context / history / retrieved。 */
export interface PromptAggregate {
  promptId: string;
  tokenCount: number;
  historyLength: number;
  retrievedFiles: number;
  retrievedSymbols: number;
  contextToken: number;
  historyToken: number;
}
