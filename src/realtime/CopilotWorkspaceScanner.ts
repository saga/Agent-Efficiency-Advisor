// CopilotWorkspaceScanner — 统一扫描 VSCode Copilot 所有数据源
//
// 扫描以下数据源并汇总为 WorkspaceScanResult:
//   1. debug-logs/{sessionId}/models.json          — 模型权威元数据
//   2. chatSessions/{sessionId}.jsonl              — 结构化会话日志(含 autoModeResolution)
//   3. debug-logs/{sessionId}/system_prompt_*.json — 系统提示
//   4. debug-logs/{sessionId}/tools_*.json         — 工具目录
//   5. chatEditingSessions/{sessionId}/state.json  — 编辑会话状态
//   6. transcripts/{sessionId}.jsonl               — 会话生命周期事件
//   7. emptyWindowChatSessions/*.jsonl             — 空窗口会话
//   8. logs/*/GitHub Copilot Chat.log              — 扩展宿主日志(token sku)
//
// 同时将结构化数据转换为 IDEEvent 流,供 V6+ pipeline 消费。

import fs from 'node:fs';
import path from 'node:path';
import type { IDEEvent, IDEEventType } from '../store/types.js';
import { ModelsMetadataParser } from './parsers/ModelsMetadataParser.js';
import { ChatSessionsParser } from './parsers/ChatSessionsParser.js';
import { SystemPromptToolsParser } from './parsers/SystemPromptToolsParser.js';
import { ChatEditingSessionsParser } from './parsers/ChatEditingSessionsParser.js';
import { TranscriptsParser } from './parsers/TranscriptsParser.js';
import { CopilotExtLogParser } from './parsers/CopilotExtLogParser.js';
import type { WorkspaceScanResult } from './parsers/types.js';

const DEFAULT_HOME = process.env.HOME ?? process.env.USERPROFILE ?? '/Users/saga';
const DEFAULT_USER_DIR = `${DEFAULT_HOME}/Library/Application Support/Code/User`;
const DEFAULT_WORKSPACE_STORAGE = `${DEFAULT_USER_DIR}/workspaceStorage`;
const DEFAULT_GLOBAL_STORAGE = `${DEFAULT_USER_DIR}/globalStorage`;
const DEFAULT_LOGS_DIR = `${DEFAULT_HOME}/Library/Application Support/Code/logs`;

export interface CopilotWorkspaceScannerOptions {
  /** User 目录,默认 ~/Library/Application Support/Code/User */
  userDir?: string;
  /** logs 目录,默认 ~/Library/Application Support/Code/logs */
  logsDir?: string;
  /** 是否扫描空窗口会话,默认 true */
  scanEmptyWindowSessions?: boolean;
  /** 是否扫描扩展宿主日志,默认 true */
  scanExtLogs?: boolean;
}

export class CopilotWorkspaceScanner {
  private readonly userDir: string;
  private readonly logsDir: string;
  private readonly scanEmptyWindow: boolean;
  private readonly scanExt: boolean;

  private readonly modelsParser = new ModelsMetadataParser();
  private readonly chatSessionsParser = new ChatSessionsParser();
  private readonly systemPromptToolsParser = new SystemPromptToolsParser();
  private readonly editingSessionsParser = new ChatEditingSessionsParser();
  private readonly transcriptsParser = new TranscriptsParser();
  private readonly extLogParser = new CopilotExtLogParser();

  constructor(options: CopilotWorkspaceScannerOptions = {}) {
    this.userDir = options.userDir ?? DEFAULT_USER_DIR;
    this.logsDir = options.logsDir ?? DEFAULT_LOGS_DIR;
    this.scanEmptyWindow = options.scanEmptyWindowSessions ?? true;
    this.scanExt = options.scanExtLogs ?? true;
  }

  /**
   * 扫描所有 workspaceStorage 下的 Copilot 数据。
   */
  scan(): WorkspaceScanResult[] {
    const results: WorkspaceScanResult[] = [];
    if (!fs.existsSync(DEFAULT_WORKSPACE_STORAGE)) return results;

    const entries = fs.readdirSync(DEFAULT_WORKSPACE_STORAGE, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsPath = path.join(DEFAULT_WORKSPACE_STORAGE, entry.name);
      const wsId = entry.name;
      const result = this.scanWorkspace(wsPath, wsId);
      if (result) results.push(result);
    }

    return results;
  }

  /**
   * 扫描单个 workspaceStorage/{workspaceId}/ 目录。
   */
  scanWorkspace(workspacePath: string, workspaceId: string): WorkspaceScanResult | null {
    if (!fs.existsSync(workspacePath)) return null;

    const copilotDir = path.join(workspacePath, 'GitHub.copilot-chat');
    const hasCopilotData = fs.existsSync(copilotDir);
    const hasChatSessions = fs.existsSync(path.join(workspacePath, 'chatSessions'));
    if (!hasCopilotData && !hasChatSessions) return null;

    const chatSessions: WorkspaceScanResult['chatSessions'] = [];
    const emptyWindowChatSessions: WorkspaceScanResult['emptyWindowChatSessions'] = [];
    const systemPromptAndTools: WorkspaceScanResult['systemPromptAndTools'] = [];
    const editingSessions: WorkspaceScanResult['editingSessions'] = [];
    const transcripts: WorkspaceScanResult['transcripts'] = [];
    let modelsMetadata: WorkspaceScanResult['modelsMetadata'];

    // 1. 扫描 chatSessions/{sessionId}.jsonl
    const chatSessionsDir = path.join(workspacePath, 'chatSessions');
    if (fs.existsSync(chatSessionsDir)) {
      for (const f of fs.readdirSync(chatSessionsDir).filter((f) => f.endsWith('.jsonl'))) {
        const summary = this.chatSessionsParser.parseFile(path.join(chatSessionsDir, f), false);
        if (summary) chatSessions.push(summary);
      }
    }

    // 2. 扫描 GitHub.copilot-chat/ 下的数据
    if (hasCopilotData) {
      const debugLogsDir = path.join(copilotDir, 'debug-logs');
      const transcriptsDir = path.join(copilotDir, 'transcripts');

      // 2a. debug-logs/{sessionId}/ — models.json, system_prompt, tools
      if (fs.existsSync(debugLogsDir)) {
        for (const sessionDir of fs.readdirSync(debugLogsDir, { withFileTypes: true })) {
          if (!sessionDir.isDirectory()) continue;
          const sd = path.join(debugLogsDir, sessionDir.name);
          const sessionId = sessionDir.name;

          // models.json(每个 session 都有一份,取最新的)
          const modelsFile = path.join(sd, 'models.json');
          if (fs.existsSync(modelsFile) && !modelsMetadata) {
            try {
              modelsMetadata = this.modelsParser.parseFile(modelsFile);
            } catch {
              // 忽略
            }
          }

          // system_prompt + tools
          try {
            const spt = this.systemPromptToolsParser.parseDir(sd, sessionId);
            if (spt.tools.length > 0 || spt.systemPromptText.length > 0) {
              systemPromptAndTools.push(spt);
            }
          } catch {
            // 忽略
          }
        }
      }

      // 2b. transcripts/{sessionId}.jsonl
      if (fs.existsSync(transcriptsDir)) {
        for (const f of fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.jsonl'))) {
          const summary = this.transcriptsParser.parseFile(path.join(transcriptsDir, f));
          if (summary) transcripts.push(summary);
        }
      }
    }

    // 3. 扫描 chatEditingSessions/{sessionId}/state.json
    const editingDir = path.join(workspacePath, 'chatEditingSessions');
    if (fs.existsSync(editingDir)) {
      for (const entry of fs.readdirSync(editingDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const stateFile = path.join(editingDir, entry.name, 'state.json');
        const parsed = this.editingSessionsParser.parseFile(stateFile, entry.name);
        if (parsed) editingSessions.push(parsed);
      }
    }

    // 4. 扫描空窗口会话 globalStorage/emptyWindowChatSessions/*.jsonl
    if (this.scanEmptyWindow) {
      const emptyDir = path.join(DEFAULT_GLOBAL_STORAGE, 'emptyWindowChatSessions');
      if (fs.existsSync(emptyDir)) {
        for (const f of fs.readdirSync(emptyDir).filter((f) => f.endsWith('.jsonl'))) {
          const summary = this.chatSessionsParser.parseFile(path.join(emptyDir, f), true);
          if (summary) emptyWindowChatSessions.push(summary);
        }
      }
    }

    // 5. 扫描扩展宿主日志(所有时间窗口下的 GitHub Copilot Chat.log)
    const extLogs: WorkspaceScanResult['extLogs'] = [];
    if (this.scanExt && fs.existsSync(this.logsDir)) {
      for (const tsDir of fs.readdirSync(this.logsDir, { withFileTypes: true })) {
        if (!tsDir.isDirectory()) continue;
        const tsPath = path.join(this.logsDir, tsDir.name);
        for (const winDir of fs.readdirSync(tsPath, { withFileTypes: true })) {
          if (!winDir.isDirectory() || !winDir.name.startsWith('window')) continue;
          const extHostDir = path.join(tsPath, winDir.name, 'exthost', 'GitHub.copilot-chat');
          const logFile = path.join(extHostDir, 'GitHub Copilot Chat.log');
          if (fs.existsSync(logFile)) {
            const summary = this.extLogParser.parseFile(logFile);
            if (summary) extLogs.push(summary);
          }
        }
      }
    }

    // 6. 提取 autoModeResolution 信号
    const autoModeSignals: WorkspaceScanResult['autoModeSignals'] = [];
    for (const session of chatSessions) {
      autoModeSignals.push(...this.chatSessionsParser.extractAutoModeSignals(session));
    }
    for (const session of emptyWindowChatSessions) {
      autoModeSignals.push(...this.chatSessionsParser.extractAutoModeSignals(session));
    }

    // 7. 将 chatSessions 转换为 IDEEvent 流
    const events = this.convertToIDEEvents(chatSessions, workspaceId);

    return {
      workspaceId,
      workspacePath,
      modelsMetadata,
      chatSessions,
      emptyWindowChatSessions,
      systemPromptAndTools,
      editingSessions,
      transcripts,
      extLogs,
      events,
      autoModeSignals,
    };
  }

  /**
   * 将 ChatSessionSummary 列表转换为 IDEEvent 流。
   */
  private convertToIDEEvents(
    sessions: WorkspaceScanResult['chatSessions'],
    workspaceId: string,
  ): IDEEvent[] {
    const events: IDEEvent[] = [];

    for (const session of sessions) {
      // session_start
      events.push({
        timestamp: session.creationDate,
        sessionId: session.sessionId,
        workspaceId,
        eventType: 'session_start' as IDEEventType,
        metadata: {
          source: 'chatSessions',
          initialLocation: session.initialLocation,
          mode: session.mode?.id,
          selectedModelId: session.selectedModel?.identifier,
          selectedModelFamily: session.selectedModel?.metadata?.family,
          selectedModelVersion: session.selectedModel?.metadata?.version,
          permissionLevel: session.permissionLevel,
          customTitle: session.customTitle,
        },
      });

      // 每个 request → chat + completion + (可能的 autoModeResolution 信号)
      for (const req of session.requests) {
        const promptId = req.requestId;
        const ts = req.timestamp;

        // user message → chat event
        if (req.message?.text) {
          events.push({
            timestamp: ts,
            sessionId: session.sessionId,
            workspaceId,
            eventType: 'chat' as IDEEventType,
            metadata: {
              source: 'chatSessions',
              promptId,
              turnIndex: 0,
              messageLength: req.message.text.length,
              messageText: req.message.text,
              agentName: req.agent?.name,
              modelId: req.modelId,
              modeKind: req.modeInfo?.kind,
              permissionLevel: req.modeInfo?.permissionLevel,
            },
          });
        }

        // assistant response → completion event
        if (req.result) {
          const timings = req.result.timings;
          events.push({
            timestamp: ts + 1,
            sessionId: session.sessionId,
            workspaceId,
            eventType: 'completion' as IDEEventType,
            metadata: {
              source: 'chatSessions',
              promptId,
              responseId: req.responseId ?? req.result.responseId,
              resolvedModel: req.result.resolvedModel,
              promptTokens: req.result.metadata?.promptTokens ?? 0,
              outputTokens: req.result.metadata?.outputTokens ?? 0,
              completionTokens: req.completionTokens ?? 0,
              firstProgressMs: timings?.firstProgress,
              totalElapsedMs: timings?.totalElapsed,
              details: req.result.details,
              // 关键:Copilot 自身的 ML 预测信号
              autoModePredictedLabel: req.autoModeResolution?.predictedLabel,
              autoModeConfidence: req.autoModeResolution?.confidence,
              autoModeResolvedModel: req.autoModeResolution?.resolvedModel,
            },
          });
        }

        // session_end(在最后一个 request 完成时)
        if (req.modelState?.completedAt) {
          events.push({
            timestamp: req.modelState.completedAt,
            sessionId: session.sessionId,
            workspaceId,
            eventType: 'session_end' as IDEEventType,
            metadata: {
              source: 'chatSessions',
              finalModel: req.result?.resolvedModel,
              totalElapsedMs: req.result?.timings?.totalElapsed,
            },
          });
        }
      }
    }

    return events.sort((a, b) => a.timestamp - b.timestamp);
  }
}
