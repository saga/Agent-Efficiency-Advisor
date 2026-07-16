// 共享类型 — Copilot 工作区数据源解析结果
//
// 这些类型覆盖 VSCode Copilot Chat 在 globalStorage 和 workspaceStorage 下
// 写出的所有结构化数据源,供 CopilotWorkspaceScanner 统一汇总。

import type { IDEEvent } from '../../store/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. models.json — 模型权威元数据目录
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelTokenPrices {
  batch_size?: number;
  default?: {
    cache_price?: number;
    cache_write_price?: number;
    context_max?: number;
    input_price?: number;
    output_price?: number;
  };
  long_context?: {
    cache_price?: number;
    cache_write_price?: number;
    context_max?: number;
    input_price?: number;
    output_price?: number;
  };
}

export interface ModelCapabilities {
  family?: string;
  limits?: {
    max_context_window_tokens?: number;
    max_output_tokens?: number;
    max_prompt_tokens?: number;
    max_non_streaming_output_tokens?: number;
    vision?: {
      max_prompt_image_size?: number;
      max_prompt_images?: number;
      supported_media_types?: string[];
    };
  };
  supports?: {
    adaptive_thinking?: boolean;
    max_thinking_budget?: number;
    min_thinking_budget?: number;
    parallel_tool_calls?: boolean;
    reasoning_effort?: string[];
    streaming?: boolean;
    structured_outputs?: boolean;
    tool_calls?: boolean;
    vision?: boolean;
  };
  tokenizer?: string;
  type?: string;
}

export interface ModelEntry {
  id: string;
  name?: string;
  vendor?: string;
  version?: string;
  family?: string;
  preview?: boolean;
  is_chat_default?: boolean;
  is_chat_fallback?: boolean;
  model_picker_category?: string; // lightweight | versatile | powerful
  model_picker_price_category?: string; // low | medium | high | very_high
  model_picker_enabled?: boolean;
  policy_state?: string; // enabled | disabled
  capabilities?: ModelCapabilities;
  billing?: {
    restricted_to?: string[];
    token_prices?: ModelTokenPrices;
  };
  supported_endpoints?: string[];
  info_messages?: { code: string; message: string }[];
}

export interface ModelsMetadata {
  models: ModelEntry[];
  /** 按模型 id 索引 */
  byId: Map<string, ModelEntry>;
  /** 按 family 索引 */
  byFamily: Map<string, ModelEntry[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. chatSessions/*.jsonl — 结构化会话日志(JSONL patch 格式)
// ─────────────────────────────────────────────────────────────────────────────

/** Copilot 自身的 Auto Mode 预测信号 — 极高价值的半监督标签 */
export interface AutoModeResolution {
  resolvedModel: string;
  resolvedModelName?: string;
  predictedLabel: string; // 如 "needs_reasoning"
  confidence: number; // 0-1
}

export interface ChatSessionRequest {
  requestId: string;
  timestamp: number;
  agent?: {
    name?: string;
    extensionId?: { value?: string };
    extensionVersion?: string;
  };
  modelId?: string;
  responseId?: string;
  message?: {
    text?: string;
    parts?: unknown[];
  };
  variableData?: {
    variables?: Array<{
      kind?: string;
      value?: unknown;
      id?: string;
      name?: string;
    }>;
  };
  response?: Array<Record<string, unknown>>;
  result?: {
    timings?: {
      firstProgress?: number;
      totalElapsed?: number;
    };
    metadata?: {
      promptTokens?: number;
      outputTokens?: number;
      renderedUserMessage?: unknown[];
      renderedGlobalContext?: unknown[];
    };
    resolvedModel?: string;
    modelMessageId?: string;
    responseId?: string;
    sessionId?: string;
    agentId?: string;
    details?: string;
  };
  completionTokens?: number;
  modeInfo?: {
    kind?: string;
    isBuiltin?: boolean;
    telemetryModeId?: string;
    permissionLevel?: string;
  };
  followups?: unknown[];
  modelState?: { value?: number; completedAt?: number };
  /** 重建后提取的 autoModeResolution(从 response 数组中提取) */
  autoModeResolution?: AutoModeResolution;
}

export interface ChatSessionModel {
  identifier?: string;
  metadata?: {
    id?: string;
    vendor?: string;
    name?: string;
    family?: string;
    version?: string;
    tooltip?: string;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    capabilities?: {
      vision?: boolean;
      toolCalling?: boolean;
      agentMode?: boolean;
    };
  };
}

export interface ChatSessionSummary {
  sessionId: string;
  creationDate: number;
  version?: number;
  initialLocation?: string;
  responderUsername?: string;
  customTitle?: string;
  selectedModel?: ChatSessionModel;
  mode?: { id?: string; kind?: string };
  permissionLevel?: string;
  requests: ChatSessionRequest[];
  /** 来源文件路径 */
  sourceFile: string;
  /** 该会话是否来自空窗口(不属于任何 workspace) */
  isEmptyWindow: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. system_prompt_*.json + tools_*.json — 系统提示与工具目录
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description?: string;
  category: ToolCategory;
  raw: Record<string, unknown>;
}

export type ToolCategory =
  | 'file'
  | 'browser'
  | 'terminal'
  | 'memory'
  | 'search'
  | 'python'
  | 'vscode'
  | 'task'
  | 'subagent'
  | 'web'
  | 'notebook'
  | 'mcp'
  | 'unknown';

export interface SkillDefinition {
  name: string;
  description?: string;
  file?: string;
}

export interface SubagentDefinition {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface SystemPromptAndTools {
  sessionId: string;
  systemPromptText: string;
  tools: ToolDefinition[];
  skills: SkillDefinition[];
  subagents: SubagentDefinition[];
  /** 按类别统计的工具数 */
  toolCategoryCounts: Record<ToolCategory, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. chatEditingSessions/state.json — 编辑会话状态
// ─────────────────────────────────────────────────────────────────────────────

export interface EditingCheckpoint {
  checkpointId: string;
  epoch: number;
  label?: string;
  description?: string;
  requestId?: string;
}

export interface EditingSessionState {
  sessionId: string;
  version: number;
  initialFileContents: Record<string, string>;
  fileBaselines: unknown[];
  operations: unknown[];
  checkpoints: EditingCheckpoint[];
  currentEpoch: number;
  epochCounter: number;
  recentSnapshot: { entries: unknown[] };
  sourceFile: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. transcripts/*.jsonl — 会话生命周期事件
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscriptEvent {
  type: string; // session.start 等
  sessionId: string;
  timestamp: string;
  data: Record<string, unknown>;
  id?: string;
  parentId?: string;
  raw: Record<string, unknown>;
}

export interface TranscriptSummary {
  sessionId: string;
  events: TranscriptEvent[];
  startTime?: string;
  endTime?: string;
  producer?: string;
  copilotVersion?: string;
  vscodeVersion?: string;
  sourceFile: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. GitHub Copilot Chat.log — 扩展宿主日志(token sku 等)
// ─────────────────────────────────────────────────────────────────────────────

export interface CopilotExtLogSummary {
  logFile: string;
  copilotVersion?: string;
  vscodeVersion?: string;
  tokenSku?: string; // free_limited_copilot | pro | max | ...
  mcpServerStarted: boolean;
  codeReferencingEnabled: boolean;
  activationBlockerMs?: number;
  firstSeenTimestamp?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 统一扫描结果
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkspaceScanResult {
  workspaceId: string;
  workspacePath: string;
  modelsMetadata?: ModelsMetadata;
  chatSessions: ChatSessionSummary[];
  emptyWindowChatSessions: ChatSessionSummary[];
  systemPromptAndTools: SystemPromptAndTools[];
  editingSessions: EditingSessionState[];
  transcripts: TranscriptSummary[];
  extLogs: CopilotExtLogSummary[];
  /** 由所有数据源汇总得到的 IDEEvent 流 */
  events: IDEEvent[];
  /** 由 chatSessions 中提取的 autoModeResolution 信号 */
  autoModeSignals: Array<{
    sessionId: string;
    requestId: string;
    timestamp: number;
    resolvedModel: string;
    predictedLabel: string;
    confidence: number;
    userMessageText?: string;
  }>;
}
