// ChatEditingSessionsParser — 解析 chatEditingSessions/{sessionId}/state.json
//
// state.json 记录了 Copilot 编辑会话的完整状态:
//   - initialFileContents: 编辑前的文件内容 baseline
//   - fileBaselines: 文件级 baseline 记录
//   - operations: 操作链(每次 edit 的 patch)
//   - checkpoints: checkpoint 列表(epoch、label、description、requestId)
//   - recentSnapshot: 最近快照
//
// 价值:比从 agent_response 推断 edit 更精确,可直接获得文件级 baseline 和
//      operations 链,用于构建精确的"编辑行为"特征。

import fs from 'node:fs';
import type { EditingSessionState } from './types.js';

export class ChatEditingSessionsParser {
  /**
   * 解析 chatEditingSessions/{sessionId}/state.json。
   * @param stateFilePath state.json 的绝对路径
   * @param sessionId 会话 ID(从目录名推断)
   */
  parseFile(stateFilePath: string, sessionId: string): EditingSessionState | null {
    if (!fs.existsSync(stateFilePath)) return null;
    const raw = fs.readFileSync(stateFilePath, 'utf-8');
    return this.parseString(raw, stateFilePath, sessionId);
  }

  /**
   * 解析 state.json 字符串内容。
   */
  parseString(raw: string, sourceFile: string, sessionId: string): EditingSessionState | null {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const timeline = (parsed.timeline as Record<string, unknown>) ?? {};
    const checkpointsRaw = (timeline.checkpoints as Array<Record<string, unknown>>) ?? [];

    return {
      sessionId,
      version: Number(parsed.version ?? 1),
      initialFileContents: (parsed.initialFileContents as Record<string, string>) ?? {},
      fileBaselines: (parsed.fileBaselines as unknown[]) ?? [],
      operations: (timeline.operations as unknown[]) ?? [],
      checkpoints: checkpointsRaw.map((c) => ({
        checkpointId: String(c.checkpointId ?? ''),
        epoch: Number(c.epoch ?? 0),
        label: c.label as string | undefined,
        description: c.description as string | undefined,
        requestId: c.requestId as string | undefined,
      })),
      currentEpoch: Number(timeline.currentEpoch ?? 0),
      epochCounter: Number(timeline.epochCounter ?? 0),
      recentSnapshot: (parsed.recentSnapshot as { entries: unknown[] }) ?? { entries: [] },
      sourceFile,
    };
  }
}
