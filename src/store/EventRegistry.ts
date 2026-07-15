// EventRegistry — v7.md #10: Event Schema / Provider Mapping / 版本管理。
// 补齐整个系统的元数据体系，让 Event 也成为可查询的 Schema。
//
// | Registry          | 作用                                                |
// | Feature Registry  | Feature 定义                                        |
// | Event Registry    | Event Schema、Provider Mapping、版本管理                |
// | Analyzer Registry | 注册 Behavior、Trend、Workflow、Failure、ROI 等 Analyzer |

import type { IDEEventType } from './types.js';

/** Event 来源 Provider 标识。 */
export type EventProvider = 'copilot' | 'cursor' | 'claude_code' | 'codex_cli' | 'continue' | 'mock' | 'generic';

export interface EventSchemaDefinition {
  eventType: IDEEventType;
  description: string;
  version: number;
  /** 该事件类型由哪些 Provider 产生。 */
  providers: EventProvider[];
  /** 期望的 metadata 字段（键名 → 描述）。 */
  metadataFields: Record<string, string>;
  /** 是否是 session 边界事件。 */
  isSessionBoundary?: boolean;
}

/** 内置的 Event Schema 定义。 */
export const CORE_EVENT_DEFINITIONS: EventSchemaDefinition[] = [
  {
    eventType: 'session_start',
    description: 'Session 开始',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    isSessionBoundary: true,
    metadataFields: {
      model: '使用的模型名',
      modelLimit: '模型 context window 上限',
      languages: '工作区编程语言列表',
      dependencies: '工作区依赖列表',
    },
  },
  {
    eventType: 'session_end',
    description: 'Session 结束',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    isSessionBoundary: true,
    metadataFields: {},
  },
  {
    eventType: 'read_file',
    description: '读取文件',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    metadataFields: { path: '文件路径' },
  },
  {
    eventType: 'edit',
    description: '编辑文件',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    metadataFields: { file: '文件路径', diffLines: '变更行数', success: '是否成功' },
  },
  {
    eventType: 'chat',
    description: '用户发送 Prompt',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    metadataFields: {
      promptId: 'Prompt 唯一标识',
      tokenCount: 'Prompt token 数',
      historyLength: '历史轮数',
      retrievedFiles: '检索到的文件数',
      retrievedSymbols: '检索到的符号数',
      contextToken: 'Context token 数',
      historyToken: '历史 token 数',
    },
  },
  {
    eventType: 'completion',
    description: '模型生成 Completion',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    metadataFields: { tokenCount: '生成 token 数', model: '模型名' },
  },
  {
    eventType: 'accept',
    description: '用户接受 Completion',
    version: 1,
    providers: ['copilot', 'cursor', 'mock'],
    metadataFields: {},
  },
  {
    eventType: 'reject',
    description: '用户拒绝 Completion',
    version: 1,
    providers: ['copilot', 'cursor', 'mock'],
    metadataFields: {},
  },
  {
    eventType: 'retry',
    description: '重试（失败后重新生成）',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    metadataFields: {},
  },
  {
    eventType: 'tool_call',
    description: '通用工具调用',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    metadataFields: { tool: '工具名', toolName: '工具名（别名）', durationMs: '耗时', success: '是否成功' },
  },
  {
    eventType: 'terminal',
    description: '终端命令执行',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    metadataFields: { toolName: '工具名' },
  },
  {
    eventType: 'run_test',
    description: '运行测试',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    metadataFields: { toolName: '工具名', passed: '是否通过' },
  },
  {
    eventType: 'commit',
    description: 'Git 提交',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    metadataFields: { branch: '分支名', author: '作者', toolName: '工具名' },
  },
  {
    eventType: 'error',
    description: '错误事件',
    version: 1,
    providers: ['copilot', 'cursor', 'claude_code', 'mock'],
    metadataFields: { message: '错误信息', code: '错误码' },
  },
];

export class EventRegistry {
  private schemas = new Map<IDEEventType, EventSchemaDefinition>();

  constructor() {
    for (const def of CORE_EVENT_DEFINITIONS) {
      this.register(def);
    }
  }

  register(def: EventSchemaDefinition): void {
    this.schemas.set(def.eventType, def);
  }

  get(eventType: IDEEventType): EventSchemaDefinition | undefined {
    return this.schemas.get(eventType);
  }

  getAll(): EventSchemaDefinition[] {
    return Array.from(this.schemas.values());
  }

  /** 查询某个 Provider 能产生的所有事件类型。 */
  getByProvider(provider: EventProvider): EventSchemaDefinition[] {
    return this.getAll().filter((s) => s.providers.includes(provider));
  }

  /** 验证一个事件的 metadata 是否符合 Schema（返回缺失的字段）。 */
  validateMetadata(eventType: IDEEventType, metadata: Record<string, unknown>): string[] {
    const schema = this.schemas.get(eventType);
    if (!schema) return [];
    const required = Object.keys(schema.metadataFields);
    return required.filter((key) => !(key in metadata) || metadata[key] === undefined);
  }
}
