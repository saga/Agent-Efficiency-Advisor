// V6 full 5-layer architecture demo:
// Event Store → Feature Store → Embedding Store → ML → LLM
//
// Demonstrates v6.md's complete vision: from raw events to natural language insights.
// Uses pi-ai (@earendil-works/pi-ai) as the LLM framework.

import { rmSync } from 'node:fs';
import { openDatabase } from './store/schema.js';
import { EventStore } from './store/EventStore.js';
import { FeatureRegistry } from './store/FeatureRegistry.js';
import { FeatureStore } from './store/FeatureStore.js';
import { FeaturePipeline } from './store/FeaturePipeline.js';
import { EmbeddingStore } from './embedding/EmbeddingStore.js';
import { EmbeddingPipeline } from './embedding/EmbeddingPipeline.js';
import { AnalyticsEngine } from './ml/AnalyticsEngine.js';
import { InsightsEngine } from './llm/InsightsEngine.js';
import type { IDEEvent } from './store/types.js';

const DB_PATH = './data/aea-v6.db';

function buildSyntheticEvents(): IDEEvent[] {
  const events: IDEEvent[] = [];
  const ws = 'ws-demo';
  const now = Date.now();
  const DAY = 86_400_000;

  // Generate 3 days of sessions to make trend analysis meaningful
  for (let day = 2; day >= 0; day--) {
    const dayOffset = day * DAY;
    const daySuffix = day === 0 ? '' : day === 1 ? '-d1' : '-d2';

    // --- Good session ---
    const t1 = now - dayOffset - 3_600_000;
    const s1 = `sess-good${daySuffix}`;
    events.push({ timestamp: t1, sessionId: s1, workspaceId: ws, eventType: 'session_start', metadata: { model: 'gpt-5' } });
    events.push({ timestamp: t1 + 1000, sessionId: s1, workspaceId: ws, eventType: 'read_file', metadata: { path: 'src/index.ts' } });
    events.push({ timestamp: t1 + 2000, sessionId: s1, workspaceId: ws, eventType: 'read_file', metadata: { path: 'src/utils.ts' } });
    events.push({ timestamp: t1 + 3000, sessionId: s1, workspaceId: ws, eventType: 'chat', metadata: { promptId: `p-good${daySuffix}`, tokenCount: 1200, retrievedFiles: 2, contextToken: 1500, historyToken: 0 } });
    events.push({ timestamp: t1 + 4000, sessionId: s1, workspaceId: ws, eventType: 'completion', metadata: { tokenCount: 400 } });
    events.push({ timestamp: t1 + 5000, sessionId: s1, workspaceId: ws, eventType: 'accept', metadata: {} });
    events.push({ timestamp: t1 + 6000, sessionId: s1, workspaceId: ws, eventType: 'edit', metadata: { file: 'src/index.ts' } });
    events.push({ timestamp: t1 + 7000, sessionId: s1, workspaceId: ws, eventType: 'run_test', metadata: { passed: true } });
    events.push({ timestamp: t1 + 8000, sessionId: s1, workspaceId: ws, eventType: 'commit', metadata: { branch: 'main' } });
    events.push({ timestamp: t1 + 9000, sessionId: s1, workspaceId: ws, eventType: 'session_end', metadata: {} });

    // --- Retry storm session ---
    const t2 = now - dayOffset - 1_800_000;
    const s2 = `sess-retry${daySuffix}`;
    events.push({ timestamp: t2, sessionId: s2, workspaceId: ws, eventType: 'session_start', metadata: { model: 'gpt-5' } });
    events.push({ timestamp: t2 + 1000, sessionId: s2, workspaceId: ws, eventType: 'chat', metadata: { promptId: `p-retry${daySuffix}`, tokenCount: 3000, retrievedFiles: 5, contextToken: 4000, historyToken: 800 } });
    events.push({ timestamp: t2 + 2000, sessionId: s2, workspaceId: ws, eventType: 'completion', metadata: { tokenCount: 600 } });
    events.push({ timestamp: t2 + 3000, sessionId: s2, workspaceId: ws, eventType: 'retry', metadata: {} });
    events.push({ timestamp: t2 + 4000, sessionId: s2, workspaceId: ws, eventType: 'retry', metadata: {} });
    events.push({ timestamp: t2 + 5000, sessionId: s2, workspaceId: ws, eventType: 'retry', metadata: {} });
    events.push({ timestamp: t2 + 6000, sessionId: s2, workspaceId: ws, eventType: 'reject', metadata: {} });
    events.push({ timestamp: t2 + 7000, sessionId: s2, workspaceId: ws, eventType: 'session_end', metadata: {} });

    // --- Context explosion session (only on recent days to show trend) ---
    if (day < 2) {
      const t3 = now - dayOffset - 600_000;
      const s3 = `sess-explode${daySuffix}`;
      events.push({ timestamp: t3, sessionId: s3, workspaceId: ws, eventType: 'session_start', metadata: { model: 'gpt-5' } });
      events.push({ timestamp: t3 + 1000, sessionId: s3, workspaceId: ws, eventType: 'read_file', metadata: { path: 'README.md' } });
      events.push({ timestamp: t3 + 2000, sessionId: s3, workspaceId: ws, eventType: 'read_file', metadata: { path: 'package.json' } });
      events.push({ timestamp: t3 + 3000, sessionId: s3, workspaceId: ws, eventType: 'read_file', metadata: { path: 'tsconfig.json' } });
      events.push({ timestamp: t3 + 4000, sessionId: s3, workspaceId: ws, eventType: 'read_file', metadata: { path: 'src/store/schema.ts' } });
      events.push({ timestamp: t3 + 5000, sessionId: s3, workspaceId: ws, eventType: 'chat', metadata: { promptId: `p-explode${daySuffix}`, tokenCount: 8000, retrievedFiles: 10, contextToken: 12000, historyToken: 0 } });
      events.push({ timestamp: t3 + 6000, sessionId: s3, workspaceId: ws, eventType: 'completion', metadata: { tokenCount: 1500 } });
      events.push({ timestamp: t3 + 7000, sessionId: s3, workspaceId: ws, eventType: 'retry', metadata: {} });
      events.push({ timestamp: t3 + 8000, sessionId: s3, workspaceId: ws, eventType: 'retry', metadata: {} });
      events.push({ timestamp: t3 + 9000, sessionId: s3, workspaceId: ws, eventType: 'reject', metadata: {} });
      events.push({ timestamp: t3 + 10000, sessionId: s3, workspaceId: ws, eventType: 'session_end', metadata: {} });
    }
  }

  return events;
}

async function main() {
  // Fresh start
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });

  const db = openDatabase(DB_PATH);
  const eventStore = new EventStore(db);
  const registry = new FeatureRegistry(db);
  const featureStore = new FeatureStore(db);
  const pipeline = new FeaturePipeline(db, eventStore, featureStore, registry);
  const embeddingStore = new EmbeddingStore(db);
  const embeddingPipeline = new EmbeddingPipeline(eventStore, featureStore, embeddingStore);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  V6 Five-Layer Architecture Demo');
  console.log('  Event Store → Feature Store → Embedding → ML → LLM');
  console.log('═══════════════════════════════════════════════════════════\n');

  // ═══ Layer 1: Event Store ═══
  console.log('─── Layer 1: Event Store ───');
  pipeline.initializeRegistry();
  const events = buildSyntheticEvents();
  const inserted = eventStore.insertBatch(events);
  const sessionIds = eventStore.getSessionIds();
  console.log(`  Inserted ${inserted} events across ${sessionIds.length} sessions`);
  console.log();

  // ═══ Layer 2: Feature Store ═══
  console.log('─── Layer 2: Feature Store ───');
  const result = pipeline.computeAllSessions();
  console.log(`  Computed ${result.features} feature rows across ${result.sessions} sessions`);
  // Show behavior features for one session
  const sampleSession = sessionIds[0];
  const bf = featureStore.read('behavior', sampleSession);
  if (bf) {
    console.log(`  Sample [${sampleSession}]:`);
    for (const [k, v] of Object.entries(bf.features)) {
      console.log(`    ${k.padEnd(26)} ${typeof v === 'number' ? v.toFixed(3) : v}`);
    }
  }
  console.log();

  // ═══ Layer 3: Embedding Store ═══
  console.log('─── Layer 3: Embedding Store ───');
  const embResult = embeddingPipeline.computeAll();
  console.log(`  Generated embeddings: ${embResult.sessions} sessions, ${embResult.prompts} prompts`);

  // Similar session search
  const querySession = sessionIds[0];
  const similar = embeddingPipeline.findSimilarSessions(querySession, 5);
  console.log(`  Similar to [${querySession}]:`);
  for (const s of similar) {
    console.log(`    ${s.entityId.padEnd(24)} similarity=${s.similarity.toFixed(4)}`);
  }
  console.log();

  // ═══ Layer 4: ML (Analytics Engine) ═══
  console.log('─── Layer 4: ML (Analytics Engine) ───');
  const analytics = new AnalyticsEngine(eventStore, featureStore, embeddingStore);
  const report = analytics.analyze();

  // Behavior Model
  console.log('  [Behavior Model — Markov]');
  console.log(`    anomalyScore: ${report.behavior.anomalyScore}`);
  console.log(`    topWorkflow: ${report.behavior.topWorkflows[0]?.sequence.join('→') ?? 'n/a'}`);
  console.log(`    transitions: ${report.behavior.transitions.length} learned`);

  // Workflow Mining
  console.log('  [Workflow Mining — Heuristic Miner]');
  console.log(`    nodes: ${report.workflow.nodes.length}, edges: ${report.workflow.edges.length}`);
  if (report.workflow.frequentPaths[0]) {
    console.log(`    most frequent path: ${report.workflow.frequentPaths[0].path.join('→')} (×${report.workflow.frequentPaths[0].frequency})`);
  }
  if (report.workflow.failurePatterns[0]) {
    console.log(`    failure pattern: ${report.workflow.failurePatterns[0].path.join('→')} (×${report.workflow.failurePatterns[0].frequency})`);
  }

  // Trend Analysis
  console.log('  [Trend Analysis]');
  console.log(`    days analyzed: ${report.trends.summary.daysAnalyzed}`);
  console.log(`    health direction: ${report.trends.summary.healthDirection}`);
  for (const t of report.trends.trends) {
    console.log(`    ${t.metric.padEnd(16)} ${t.direction.padEnd(12)} rollingAvg=${t.rollingAvg} slope=${t.slope}`);
  }

  // Failure Classification
  console.log('  [Failure Classification]');
  for (const f of report.failures.filter((f) => f.failureType !== 'none')) {
    console.log(`    ${f.sessionId.padEnd(24)} → ${f.failureType} (conf=${f.confidence}) ${f.evidence.join(', ')}`);
  }

  // Context ROI
  console.log('  [Context ROI — feature correlation with acceptRate]');
  for (const r of report.contextROI.slice(0, 5)) {
    const sign = r.contribution > 0 ? '+' : '';
    console.log(`    ${r.feature.padEnd(26)} ${sign}${r.contribution}`);
  }

  // LLM Payload
  console.log('\n  [LLM Payload — ~500 tokens of structured JSON]');
  console.log(JSON.stringify(report.llmPayload, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
  console.log();

  // ═══ Layer 5: LLM (Insights Engine) ═══
  console.log('─── Layer 5: LLM (Insights Engine via pi-ai) ───');
  const insights = new InsightsEngine();
  const available = await insights.isAvailable();
  console.log(`  model available: ${available ? 'yes' : 'no (using template fallback)'}`);
  const insight = await insights.generate(report);
  console.log(`  source: ${insight.source}${insight.model ? ` (${insight.model})` : ''}`);
  if (insight.tokensUsed) {
    console.log(`  tokens: ${insight.tokensUsed.input} in, ${insight.tokensUsed.output} out`);
  }
  console.log('\n  ── Insight ──');
  for (const line of insight.text.split('\n')) {
    console.log(`  ${line}`);
  }
  console.log();

  db.close();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Demo complete. Database at', DB_PATH);
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(console.error);
