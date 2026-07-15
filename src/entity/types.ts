// Canonical Entity Layer — the unified domain model.
// v7.md "我认为还可以增加一个比 Session Graph 更重要的层":
//   Event → Entity → Feature → Embedding → ML → Graph → LLM
//
// Entity 是 Event 与 Feature/Embedding/Graph 之间的统一领域模型。
// 以后：Graph 直接引用 Entity、Feature 从 Entity 聚合、Embedding 对 Entity 建向量、
// LLM 引用 Entity、Dashboard 展示 Entity。整个系统真正变成 DDD。

/** Session Entity — 一个完整的 AI 编码会话。 */
export interface SessionEntity {
  id: string;
  workspaceId: string;
  startTime: number;
  endTime: number;
  duration: number;
  // Reference to feature version (v7.md #7: Graph 存 Reference 不存 Feature)
  featureVersion?: number;
  // Outcome signal (filled by label store / outcome collector)
  outcome?: 'success' | 'failure' | 'partial' | 'unknown';
}

/** Prompt Entity — 一次用户提示。 */
export interface PromptEntity {
  id: string;
  sessionId: string;
  tokenCount: number;
  historyLength: number;
  retrievedFiles: number;
  retrievedSymbols: number;
  contextToken: number;
  historyToken: number;
  timestamp: number;
}

/** Completion Entity — 模型的一次生成。 */
export interface CompletionEntity {
  id: string;
  sessionId: string;
  promptId?: string;
  tokenCount: number;
  model: string;
  timestamp: number;
}

/** Workspace Entity — 工作区快照。 */
export interface WorkspaceEntity {
  id: string;
  files: string[];
  languages: string[];
  dependencies: string[];
  branches: string[];
  totalLOC: number;
}

/** ToolInvocation Entity — 一次工具调用。 */
export interface ToolInvocationEntity {
  id: string;
  sessionId: string;
  toolName: string;
  toolKind: 'terminal' | 'git' | 'mcp' | 'filesystem' | 'test' | 'other';
  timestamp: number;
  success?: boolean;
}

/** Failure Entity — 一次失败事件。 */
export interface FailureEntity {
  id: string;
  sessionId: string;
  failureType: 'wrong_context' | 'retry_loop' | 'context_explosion' | 'tool_error' | 'user_cancel' | 'none';
  confidence: number;
  evidence: string[];
  timestamp: number;
}

/** Recommendation Entity — 一次模型推荐。 */
export interface RecommendationEntity {
  id: string;
  sessionId: string;
  recommendedModel: string;
  reason: string;
  confidence: number;
  timestamp: number;
}

/** OutcomeMarker — accept/reject/retry 的时序标记（非独立 Entity，属于 Completion 的时序属性）。 */
export interface OutcomeMarker {
  kind: 'accept' | 'reject' | 'retry';
  completionId?: string; // 关联到最近的 completion（如果有）
  timestamp: number;
  eventRef?: number; // 原始事件 id（用于生成唯一 nodeId）
}

/** FileRef — read_file 事件的文件引用（保留时序以便 prompt_file 关联）。 */
export interface FileRef {
  path: string;
  timestamp: number;
}

/** CommitRef — commit 事件的工作区提交标记。 */
export interface CommitRef {
  branch: string;
  author: string;
  timestamp: number;
  eventRef?: number;
}

/** EntityBundle — 一次 buildSession 产出的所有 Entity 集合。 */
export interface EntityBundle {
  session: SessionEntity;
  workspace: WorkspaceEntity;
  prompts: PromptEntity[];
  completions: CompletionEntity[];
  toolInvocations: ToolInvocationEntity[];
  failures: FailureEntity[];
  outcomes: OutcomeMarker[];   // accept/reject/retry 时序标记
  files: FileRef[];            // read_file 时序标记
  commits: CommitRef[];        // commit 时序标记
  /** chat 事件与之前 read_file 的关联（promptId → file paths），用于 prompt_file 边。 */
  promptFileLinks: { promptId: string; files: string[]; timestamp: number }[];
}

/** Entity 类型联合 — 用于 Registry / Graph 引用。 */
export type EntityType =
  | 'session'
  | 'prompt'
  | 'completion'
  | 'workspace'
  | 'tool_invocation'
  | 'failure'
  | 'recommendation';
