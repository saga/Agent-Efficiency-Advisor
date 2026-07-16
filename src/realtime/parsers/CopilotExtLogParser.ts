// CopilotExtLogParser — 解析 logs/{timestamp}/window*/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log
//
// 该日志包含扩展宿主级信息:
//   - copilot token sku: free_limited_copilot | pro | max | ...
//   - Copilot Chat 版本和 VS Code 版本
//   - MCP server 启动状态
//   - code-referencing 启用状态
//   - activation blocker 耗时
//
// 价值:捕获用户订阅等级(token sku)— 有用的分层特征。

import fs from 'node:fs';
import type { CopilotExtLogSummary } from './types.js';

export class CopilotExtLogParser {
  /**
   * 解析 GitHub Copilot Chat.log 文件。
   * @param filePath 日志文件路径
   */
  parseFile(filePath: string): CopilotExtLogSummary | null {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return this.parseString(raw, filePath);
  }

  /**
   * 解析日志字符串内容。
   */
  parseString(raw: string, logFile: string): CopilotExtLogSummary {
    const lines = raw.split(/\r?\n/);

    let copilotVersion: string | undefined;
    let vscodeVersion: string | undefined;
    let tokenSku: string | undefined;
    let mcpServerStarted = false;
    let codeReferencingEnabled = false;
    let activationBlockerMs: number | undefined;
    let firstSeenTimestamp: string | undefined;

    for (const line of lines) {
      if (!firstSeenTimestamp) {
        // 日志行格式: "2026-07-13 08:10:26.075 [info] ..."
        const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/);
        if (tsMatch) firstSeenTimestamp = tsMatch[1];
      }

      // "Copilot Chat: 0.56.0, VS Code: 1.128.0"
      const versionMatch = line.match(/Copilot Chat:\s*([\d.]+),?\s*VS Code:\s*([\d.]+)/);
      if (versionMatch) {
        copilotVersion = versionMatch[1];
        vscodeVersion = versionMatch[2];
      }

      // "copilot token sku: free_limited_copilot"
      const skuMatch = line.match(/copilot token sku:\s*(\S+)/);
      if (skuMatch) {
        tokenSku = skuMatch[1];
      }

      // "[CopilotCLI] MCP server started."
      if (line.includes('MCP server started')) {
        mcpServerStarted = true;
      }

      // "[code-referencing] Public code references are enabled."
      if (line.includes('code-referencing') && line.includes('enabled')) {
        codeReferencingEnabled = true;
      }

      // "activationBlocker from 'conversationFeature' took for 279ms"
      const blockerMatch = line.match(/activationBlocker.*took\s*for\s*(\d+)ms/);
      if (blockerMatch) {
        activationBlockerMs = Number(blockerMatch[1]);
      }
    }

    return {
      logFile,
      copilotVersion,
      vscodeVersion,
      tokenSku,
      mcpServerStarted,
      codeReferencingEnabled,
      activationBlockerMs,
      firstSeenTimestamp,
    };
  }
}
