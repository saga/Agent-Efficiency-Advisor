// ChatSessionsParser — 解析 chatSessions/{sessionId}.jsonl 和
//                      globalStorage/emptyWindowChatSessions/{sessionId}.jsonl
//
// chatSessions/*.jsonl 使用 JSONL patch 格式(不是普通 JSONL),每行是:
//   {"kind":0,"v":{...初始状态}}              — 初始化整个会话对象
//   {"kind":1,"k":["path","to","field"],"v":val} — 在路径 k 设置值 v
//   {"kind":2,"k":["requests"],"v":[item]}      — 在数组路径 k 追加元素 v
//
// 核心价值:每个 request 的 response 数组中可能包含 autoModeResolution:
//   {"kind":"autoModeResolution","resolvedModel":"oswe-vscode-prime",
//    "resolvedModelName":"Raptor mini","predictedLabel":"needs_reasoning",
//    "confidence":0.43}
// 这是 GitHub Copilot 内部 ML 模型对每个用户请求的难度预测,可作为半监督标签。

import fs from 'node:fs';
import type {
  AutoModeResolution,
  ChatSessionRequest,
  ChatSessionSummary,
} from './types.js';

interface PatchLine {
  kind: 0 | 1 | 2;
  v?: unknown;
  k?: string[];
}

export class ChatSessionsParser {
  /**
   * 解析单个 chatSessions/*.jsonl 文件,返回重建后的会话摘要。
   * @param filePath jsonl 文件路径
   * @param isEmptyWindow 是否来自 emptyWindowChatSessions(不属于任何 workspace)
   */
  parseFile(filePath: string, isEmptyWindow = false): ChatSessionSummary | null {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return this.parseString(raw, filePath, isEmptyWindow);
  }

  /**
   * 解析 jsonl 字符串内容。
   */
  parseString(
    raw: string,
    sourceFile: string,
    isEmptyWindow = false,
  ): ChatSessionSummary | null {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;

    // 第一行应为 kind:0 初始化
    let state: Record<string, unknown> = {};
    for (const line of lines) {
      try {
        const patch = JSON.parse(line) as PatchLine;
        state = this.applyPatch(state, patch);
      } catch {
        // 跳过无法解析的行
      }
    }

    return this.extractSummary(state, sourceFile, isEmptyWindow);
  }

  /**
   * 应用一个 patch 到当前状态,返回新状态(不可变)。
   */
  private applyPatch(state: Record<string, unknown>, patch: PatchLine): Record<string, unknown> {
    if (patch.kind === 0) {
      // 初始化:用 v 替换整个状态
      return (patch.v as Record<string, unknown>) ?? {};
    }
    if (patch.kind === 1 && patch.k) {
      // 设置:path k = v
      return this.setPath(state, patch.k, patch.v);
    }
    if (patch.kind === 2 && patch.k) {
      // 追加:在数组 path k 上 append v(可能是单个元素或数组)
      return this.appendPath(state, patch.k, patch.v);
    }
    return state;
  }

  private setPath(
    obj: Record<string, unknown>,
    path: string[],
    value: unknown,
  ): Record<string, unknown> {
    const next = this.deepClone(obj);
    let cursor: any = next;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (cursor[key] === undefined || cursor[key] === null) {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
    cursor[path[path.length - 1]] = value;
    return next;
  }

  private appendPath(
    obj: Record<string, unknown>,
    path: string[],
    value: unknown,
  ): Record<string, unknown> {
    const next = this.deepClone(obj);
    let cursor: any = next;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (cursor[key] === undefined || cursor[key] === null) {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
    const lastKey = path[path.length - 1];
    if (!Array.isArray(cursor[lastKey])) {
      cursor[lastKey] = [];
    }
    // kind:2 的 v 可以是单个元素或数组(批量追加)
    if (Array.isArray(value)) {
      cursor[lastKey].push(...value);
    } else {
      cursor[lastKey].push(value);
    }
    return next;
  }

  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }

  private extractSummary(
    state: Record<string, unknown>,
    sourceFile: string,
    isEmptyWindow: boolean,
  ): ChatSessionSummary | null {
    const sessionId = String(state.sessionId ?? '');
    if (!sessionId) return null;

    const creationDate = Number(state.creationDate ?? 0);
    const requestsRaw = (state.requests as ChatSessionRequest[]) ?? [];

    // 为每个 request 提取 autoModeResolution(从 response 数组中查找)
    const requests: ChatSessionRequest[] = requestsRaw.map((r) => ({
      ...r,
      autoModeResolution: this.extractAutoMode(r),
    }));

    // selectedModel 和 mode 嵌套在 inputState 下
    const inputState = (state.inputState as Record<string, unknown>) ?? {};

    return {
      sessionId,
      creationDate,
      version: Number(state.version ?? undefined),
      initialLocation: String(state.initialLocation ?? undefined),
      responderUsername: String(state.responderUsername ?? undefined),
      customTitle: String(state.customTitle ?? undefined),
      selectedModel: inputState.selectedModel as ChatSessionSummary['selectedModel'],
      mode: inputState.mode as ChatSessionSummary['mode'],
      permissionLevel: String(state.permissionLevel ?? inputState.permissionLevel ?? undefined),
      requests,
      sourceFile,
      isEmptyWindow,
    };
  }

  /**
   * 从 request.response 数组中提取 autoModeResolution 信号。
   */
  private extractAutoMode(request: ChatSessionRequest): AutoModeResolution | undefined {
    if (!Array.isArray(request.response)) return undefined;
    for (const item of request.response) {
      const obj = item as Record<string, unknown>;
      if (obj.kind === 'autoModeResolution') {
        return {
          resolvedModel: String(obj.resolvedModel ?? ''),
          resolvedModelName: String(obj.resolvedModelName ?? undefined),
          predictedLabel: String(obj.predictedLabel ?? ''),
          confidence: Number(obj.confidence ?? 0),
        };
      }
    }
    return undefined;
  }

  /**
   * 从一个已解析的 ChatSessionSummary 中提取所有 autoModeResolution 信号。
   */
  extractAutoModeSignals(session: ChatSessionSummary) {
    return session.requests
      .filter((r) => r.autoModeResolution)
      .map((r) => ({
        sessionId: session.sessionId,
        requestId: r.requestId,
        timestamp: r.timestamp,
        resolvedModel: r.autoModeResolution!.resolvedModel,
        predictedLabel: r.autoModeResolution!.predictedLabel,
        confidence: r.autoModeResolution!.confidence,
        userMessageText: r.message?.text,
      }));
  }
}
