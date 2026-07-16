// 全量扫描 VSCode Copilot 工作区所有数据源,展示解析结果并写入 EventStore。
//
// 数据源:
//   1. models.json          — 模型权威元数据目录
//   2. chatSessions/*.jsonl — 结构化会话日志(含 autoModeResolution)
//   3. system_prompt/tools  — 系统提示与工具目录
//   4. chatEditingSessions  — 编辑会话状态
//   5. transcripts          — 会话生命周期事件
//   6. emptyWindowChatSessions — 空窗口会话
//   7. GitHub Copilot Chat.log — 扩展宿主日志(token sku)
//
// 用法:npm run demo:workspace-scan

import { rmSync } from 'node:fs';
import { CopilotWorkspaceScanner } from '../src/realtime/CopilotWorkspaceScanner.js';
import { ModelsMetadataParser } from '../src/realtime/parsers/ModelsMetadataParser.js';
import { openDatabase } from '../src/store/schema.js';
import { EventStore } from '../src/store/EventStore.js';
import { FeatureRegistry } from '../src/store/FeatureRegistry.js';
import { FeatureStore } from '../src/store/FeatureStore.js';
import { FeaturePipeline } from '../src/store/FeaturePipeline.js';
import { AnalyticsEngine } from '../src/ml/AnalyticsEngine.js';
import { EmbeddingStore } from '../src/embedding/EmbeddingStore.js';

const OUT_DB = './data/aea-real.db';

function main() {
  rmSync(OUT_DB, { force: true });
  rmSync(`${OUT_DB}-wal`, { force: true });
  rmSync(`${OUT_DB}-shm`, { force: true });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Copilot Workspace Scanner — 全量数据源扫描');
  console.log('═══════════════════════════════════════════════════════════\n');

  const scanner = new CopilotWorkspaceScanner();
  const results = scanner.scan();

  console.log(`Found ${results.length} workspace(s) with Copilot data\n`);

  const db = openDatabase(OUT_DB);
  const eventStore = new EventStore(db);
  const registry = new FeatureRegistry(db);
  const featureStore = new FeatureStore(db);
  const pipeline = new FeaturePipeline(featureStore, eventStore, registry);
  const embeddingStore = new EmbeddingStore(db);
  const analytics = new AnalyticsEngine(eventStore, featureStore, embeddingStore);

  pipeline.initializeRegistry();

  const modelsParser = new ModelsMetadataParser();
  let totalEvents = 0;
  let totalAutoModeSignals = 0;

  for (const ws of results) {
    console.log(`\n───────── Workspace: ${ws.workspaceId} ─────────`);
    console.log(`  path: ${ws.workspacePath}`);

    // 1. 模型元数据
    if (ws.modelsMetadata) {
      const meta = ws.modelsMetadata;
      console.log(`\n  📦 models.json: ${meta.models.length} models`);
      const categories = new Map<string, number>();
      for (const m of meta.models) {
        const cat = m.model_picker_category ?? 'unknown';
        categories.set(cat, (categories.get(cat) ?? 0) + 1);
      }
      console.log(`     categories: ${[...categories.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
      const fallback = meta.models.find((m) => m.is_chat_fallback);
      if (fallback) console.log(`     fallback: ${fallback.id} (${fallback.name})`);
    }

    // 2. chatSessions
    console.log(`\n  💬 chatSessions: ${ws.chatSessions.length} session(s)`);
    for (const s of ws.chatSessions) {
      console.log(`     ${s.sessionId}`);
      console.log(`       title: ${s.customTitle ?? '(none)'}`);
      console.log(`       model: ${s.selectedModel?.metadata?.name ?? s.selectedModel?.identifier ?? 'unknown'}`);
      console.log(`       requests: ${s.requests.length}`);
    }

    // 3. 空窗口会话
    if (ws.emptyWindowChatSessions.length > 0) {
      console.log(`\n  🪟 emptyWindowChatSessions: ${ws.emptyWindowChatSessions.length} session(s)`);
      for (const s of ws.emptyWindowChatSessions) {
        console.log(`     ${s.sessionId} (${s.requests.length} requests)`);
      }
    }

    // 4. system_prompt + tools
    if (ws.systemPromptAndTools.length > 0) {
      console.log(`\n  🔧 system_prompt + tools: ${ws.systemPromptAndTools.length} session(s)`);
      const spt = ws.systemPromptAndTools[0];
      console.log(`     tools: ${spt.tools.length}`);
      console.log(`     tool categories: ${Object.entries(spt.toolCategoryCounts)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`);
      console.log(`     skills: ${spt.skills.map((s) => s.name).join(', ')}`);
      console.log(`     subagents: ${spt.subagents.map((a) => a.name).join(', ')}`);
    }

    // 5. editingSessions
    if (ws.editingSessions.length > 0) {
      console.log(`\n  ✏️  chatEditingSessions: ${ws.editingSessions.length} session(s)`);
      for (const es of ws.editingSessions) {
        console.log(`     ${es.sessionId}: ${es.checkpoints.length} checkpoints, epoch=${es.currentEpoch}`);
      }
    }

    // 6. transcripts
    if (ws.transcripts.length > 0) {
      console.log(`\n  📜 transcripts: ${ws.transcripts.length} session(s)`);
      for (const t of ws.transcripts) {
        console.log(`     ${t.sessionId}: ${t.events.length} events, copilot ${t.copilotVersion}, vscode ${t.vscodeVersion}`);
      }
    }

    // 7. 扩展宿主日志
    if (ws.extLogs.length > 0) {
      console.log(`\n  📋 extLogs: ${ws.extLogs.length} log file(s)`);
      const latest = ws.extLogs[ws.extLogs.length - 1];
      console.log(`     latest: copilot ${latest.copilotVersion}, vscode ${latest.vscodeVersion}`);
      console.log(`     tokenSku: ${latest.tokenSku ?? 'unknown'}`);
      console.log(`     mcpServer: ${latest.mcpServerStarted}, codeReferencing: ${latest.codeReferencingEnabled}`);
    }

    // 8. autoModeResolution 信号(最重要的发现)
    if (ws.autoModeSignals.length > 0) {
      console.log(`\n  🎯 autoModeResolution signals: ${ws.autoModeSignals.length} signal(s)`);
      for (const sig of ws.autoModeSignals) {
        console.log(`     [${sig.predictedLabel} conf=${sig.confidence.toFixed(2)}] → ${sig.resolvedModel}`);
        if (sig.userMessageText) {
          const preview = sig.userMessageText.slice(0, 60);
          console.log(`       "${preview}${sig.userMessageText.length > 60 ? '...' : ''}"`);
        }
      }
      totalAutoModeSignals += ws.autoModeSignals.length;
    }

    // 9. 写入 EventStore 并计算特征
    if (ws.events.length > 0) {
      eventStore.insertBatch(ws.events);
      totalEvents += ws.events.length;
      for (const sid of new Set(ws.events.map((e) => e.sessionId))) {
        try {
          pipeline.computeSession(sid);
        } catch {
          // 跳过计算失败的 session
        }
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Scan Summary');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`  workspaces scanned:    ${results.length}`);
  console.log(`  total IDEEvents:       ${totalEvents}`);
  console.log(`  autoModeSignals:       ${totalAutoModeSignals}`);
  console.log(`  events in EventStore:  ${eventStore.count()}`);
  console.log(`  sessions in EventStore: ${eventStore.getSessionIds().length}`);

  // 模型成本估算示例
  const firstWs = results.find((r) => r.modelsMetadata && r.chatSessions.length > 0);
  if (firstWs?.modelsMetadata) {
    console.log('\n  💰 Cost Estimation (using models.json metadata):');
    let totalCost = 0;
    for (const session of firstWs.chatSessions) {
      for (const req of session.requests) {
        if (req.result?.resolvedModel && req.result.metadata) {
          const cost = modelsParser.estimateCostUsd(
            firstWs.modelsMetadata,
            req.result.resolvedModel,
            req.result.metadata.promptTokens ?? 0,
            req.result.metadata.outputTokens ?? 0,
          );
          totalCost += cost;
        }
      }
    }
    console.log(`     estimated total cost: $${totalCost.toFixed(6)}`);
  }

  // Analytics
  if (eventStore.count() > 0) {
    const report = analytics.analyze();
    console.log('\n  📊 Analytics Summary:');
    console.log(`     sessions: ${report.summary.sessions}`);
    console.log(`     events:   ${report.summary.events}`);
    console.log(`     avgAcceptRate: ${report.summary.avgAcceptRate}`);
    console.log(`     avgRetryRate:  ${report.summary.avgRetryRate}`);
  }

  db.close();
  console.log(`\nDone. Output database: ${OUT_DB}`);
}

main();
