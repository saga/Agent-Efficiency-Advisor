// TranscriptsParser — 解析 debug-logs/../transcripts/{sessionId}.jsonl
//
// transcripts/{sessionId}.jsonl 是会话生命周期事件的清晰记录:
//   {"type":"session.start","data":{"sessionId":"...","producer":"copilot-agent",
//    "copilotVersion":"0.57.0","vscodeVersion":"1.129.0","startTime":"..."},
//    "id":"...","timestamp":"...","parentId":null}
//
// 比 main.jsonl 简洁,易于解析会话边界和版本信息。

import fs from 'node:fs';
import type { TranscriptEvent, TranscriptSummary } from './types.js';

export class TranscriptsParser {
  /**
   * 解析 transcripts/{sessionId}.jsonl 文件。
   * @param filePath jsonl 文件路径
   */
  parseFile(filePath: string): TranscriptSummary | null {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return this.parseString(raw, filePath);
  }

  /**
   * 解析 jsonl 字符串内容。
   */
  parseString(raw: string, sourceFile: string): TranscriptSummary | null {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;

    const events: TranscriptEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const type = String(parsed.type ?? '');
        const data = (parsed.data as Record<string, unknown>) ?? {};
        const sessionId = String(data.sessionId ?? parsed.sid ?? '');
        if (!type) continue;
        events.push({
          type,
          sessionId,
          timestamp: String(parsed.timestamp ?? ''),
          data,
          id: parsed.id as string | undefined,
          parentId: parsed.parentId as string | undefined,
          raw: parsed,
        });
      } catch {
        // 跳过无法解析的行
      }
    }

    if (events.length === 0) return null;

    const first = events[0];
    const last = events[events.length - 1];
    const startData = first.type === 'session.start' ? first.data : {};

    return {
      sessionId: first.sessionId,
      events,
      startTime: first.timestamp || (startData.startTime as string | undefined),
      endTime: last.timestamp,
      producer: startData.producer as string | undefined,
      copilotVersion: startData.copilotVersion as string | undefined,
      vscodeVersion: startData.vscodeVersion as string | undefined,
      sourceFile,
    };
  }
}
