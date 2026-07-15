// SQLite Event Store + Feature Store end-to-end demo.
// Builds a synthetic event stream → persists to SQLite → runs Feature Pipeline
// → queries features → materializes a training matrix.

import { rmSync } from 'node:fs';
import { openDatabase } from './store/schema.js';
import { EventStore } from './store/EventStore.js';
import { FeatureRegistry } from './store/FeatureRegistry.js';
import { FeatureStore } from './store/FeatureStore.js';
import { FeaturePipeline } from './store/FeaturePipeline.js';
import { LabelStore } from './store/LabelStore.js';
import type { IDEEvent } from './store/types.js';

const DB_PATH = './data/aea.db';

function buildSyntheticEvents(): IDEEvent[] {
  const events: IDEEvent[] = [];
  const ws = 'ws-demo';
  const sessions = ['sess-good', 'sess-retry-storm', 'sess-context-explosion'];

  // Session 1: smooth workflow (read → ask → accept → run → commit)
  const t1 = Date.now() - 3_600_000;
  const s1 = sessions[0];
  events.push({ timestamp: t1, sessionId: s1, workspaceId: ws, eventType: 'session_start', metadata: { model: 'gpt-5', modelLimit: 256000 } });
  events.push({ timestamp: t1 + 1000, sessionId: s1, workspaceId: ws, eventType: 'open_file', metadata: { path: 'src/index.ts', language: 'typescript', loc: 420 } });
  events.push({ timestamp: t1 + 2000, sessionId: s1, workspaceId: ws, eventType: 'read_file', metadata: { path: 'src/index.ts' } });
  events.push({ timestamp: t1 + 3000, sessionId: s1, workspaceId: ws, eventType: 'read_file', metadata: { path: 'src/utils.ts' } });
  events.push({ timestamp: t1 + 4000, sessionId: s1, workspaceId: ws, eventType: 'chat', metadata: { promptId: 'p1', tokenCount: 1200, historyLength: 0, retrievedFiles: 2, contextToken: 1500, historyToken: 0 } });
  events.push({ timestamp: t1 + 5000, sessionId: s1, workspaceId: ws, eventType: 'completion', metadata: { tokenCount: 400 } });
  events.push({ timestamp: t1 + 6000, sessionId: s1, workspaceId: ws, eventType: 'accept', metadata: {} });
  events.push({ timestamp: t1 + 7000, sessionId: s1, workspaceId: ws, eventType: 'edit', metadata: { file: 'src/index.ts', diffLines: 12 } });
  events.push({ timestamp: t1 + 8000, sessionId: s1, workspaceId: ws, eventType: 'run_test', metadata: { passed: true } });
  events.push({ timestamp: t1 + 9000, sessionId: s1, workspaceId: ws, eventType: 'commit', metadata: { branch: 'main', files: 1 } });
  events.push({ timestamp: t1 + 10000, sessionId: s1, workspaceId: ws, eventType: 'session_end', metadata: {} });

  // Session 2: retry storm (ask → retry → retry → retry → cancel)
  const t2 = Date.now() - 1_800_000;
  const s2 = sessions[1];
  events.push({ timestamp: t2, sessionId: s2, workspaceId: ws, eventType: 'session_start', metadata: { model: 'gpt-5', modelLimit: 256000 } });
  events.push({ timestamp: t2 + 1000, sessionId: s2, workspaceId: ws, eventType: 'chat', metadata: { promptId: 'p2', tokenCount: 3000, historyLength: 1, retrievedFiles: 5, contextToken: 4000, historyToken: 800 } });
  events.push({ timestamp: t2 + 2000, sessionId: s2, workspaceId: ws, eventType: 'completion', metadata: { tokenCount: 600 } });
  events.push({ timestamp: t2 + 3000, sessionId: s2, workspaceId: ws, eventType: 'retry', metadata: {} });
  events.push({ timestamp: t2 + 4000, sessionId: s2, workspaceId: ws, eventType: 'retry', metadata: {} });
  events.push({ timestamp: t2 + 5000, sessionId: s2, workspaceId: ws, eventType: 'retry', metadata: {} });
  events.push({ timestamp: t2 + 6000, sessionId: s2, workspaceId: ws, eventType: 'reject', metadata: {} });
  events.push({ timestamp: t2 + 7000, sessionId: s2, workspaceId: ws, eventType: 'terminal', metadata: { tool: 'terminal', command: 'git status' } });
  events.push({ timestamp: t2 + 8000, sessionId: s2, workspaceId: ws, eventType: 'tool_call', metadata: { tool: 'mcp-server' } });
  events.push({ timestamp: t2 + 9000, sessionId: s2, workspaceId: ws, eventType: 'session_end', metadata: {} });

  // Session 3: context explosion (prompt grows rapidly)
  const t3 = Date.now() - 600_000;
  const s3 = sessions[2];
  events.push({ timestamp: t3, sessionId: s3, workspaceId: ws, eventType: 'session_start', metadata: { model: 'gpt-5', modelLimit: 256000 } });
  events.push({ timestamp: t3 + 1000, sessionId: s3, workspaceId: ws, eventType: 'read_file', metadata: { path: 'README.md' } });
  events.push({ timestamp: t3 + 2000, sessionId: s3, workspaceId: ws, eventType: 'read_file', metadata: { path: 'package.json' } });
  events.push({ timestamp: t3 + 3000, sessionId: s3, workspaceId: ws, eventType: 'read_file', metadata: { path: 'tsconfig.json' } });
  events.push({ timestamp: t3 + 4000, sessionId: s3, workspaceId: ws, eventType: 'read_file', metadata: { path: 'src/store/schema.ts' } });
  events.push({ timestamp: t3 + 5000, sessionId: s3, workspaceId: ws, eventType: 'chat', metadata: { promptId: 'p3', tokenCount: 8000, historyLength: 0, retrievedFiles: 10, contextToken: 12000, historyToken: 0 } });
  events.push({ timestamp: t3 + 6000, sessionId: s3, workspaceId: ws, eventType: 'completion', metadata: { tokenCount: 1500 } });
  events.push({ timestamp: t3 + 7000, sessionId: s3, workspaceId: ws, eventType: 'retry', metadata: {} });
  events.push({ timestamp: t3 + 8000, sessionId: s3, workspaceId: ws, eventType: 'chat', metadata: { promptId: 'p4', tokenCount: 18000, historyLength: 1, retrievedFiles: 15, contextToken: 25000, historyToken: 8000 } });
  events.push({ timestamp: t3 + 9000, sessionId: s3, workspaceId: ws, eventType: 'completion', metadata: { tokenCount: 2200 } });
  events.push({ timestamp: t3 + 10000, sessionId: s3, workspaceId: ws, eventType: 'retry', metadata: {} });
  events.push({ timestamp: t3 + 11000, sessionId: s3, workspaceId: ws, eventType: 'retry', metadata: {} });
  events.push({ timestamp: t3 + 12000, sessionId: s3, workspaceId: ws, eventType: 'reject', metadata: {} });
  events.push({ timestamp: t3 + 13000, sessionId: s3, workspaceId: ws, eventType: 'session_end', metadata: {} });

  return events;
}

function main() {
  // Fresh start for a clean demo
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });

  const db = openDatabase(DB_PATH);
  const eventStore = new EventStore(db);
  const registry = new FeatureRegistry(db);
  const featureStore = new FeatureStore(db);
  const pipeline = new FeaturePipeline(featureStore, eventStore, registry);
  const labelStore = new LabelStore(db);

  // 1. Register feature definitions
  pipeline.initializeRegistry();
  const allDefs = registry.getAll();
  console.log(`═══ Feature Registry: ${allDefs.length} definitions ═══`);
  const byDomain = new Map<string, number>();
  for (const d of allDefs) byDomain.set(d.domain, (byDomain.get(d.domain) ?? 0) + 1);
  for (const [domain, count] of byDomain) {
    console.log(`  ${domain.padEnd(10)} ${count} features`);
  }
  console.log();

  // 2. Ingest events
  const events = buildSyntheticEvents();
  const inserted = eventStore.insertBatch(events);
  console.log(`═══ Event Store: inserted ${inserted} events ═══`);
  console.log(`  sessions: ${eventStore.getSessionIds().length}`);
  console.log(`  total events: ${eventStore.count()}`);
  console.log();

  // 3. Run feature pipeline
  const result = pipeline.computeAllSessions();
  console.log(`═══ Feature Pipeline: computed ${result.features} feature rows across ${result.sessions} sessions ═══`);
  console.log();

  // 4. Show session features
  console.log('═══ Session Features ═══');
  for (const sid of eventStore.getSessionIds()) {
    const sf = featureStore.read('session', sid);
    if (!sf) continue;
    console.log(`  ${sid}`);
    for (const [k, v] of Object.entries(sf.features)) {
      console.log(`    ${k.padEnd(20)} ${typeof v === 'number' ? v.toFixed(3) : v}`);
    }
  }
  console.log();

  // 5. Show behavior features — the innovation
  console.log('═══ Behavior Features (innovation) ═══');
  for (const sid of eventStore.getSessionIds()) {
    const bf = featureStore.read('behavior', sid);
    if (!bf) continue;
    console.log(`  ${sid}`);
    for (const [k, v] of Object.entries(bf.features)) {
      console.log(`    ${k.padEnd(26)} ${typeof v === 'number' ? v.toFixed(3) : v}`);
    }
  }
  console.log();

  // 6. Show prompt features
  console.log('═══ Prompt Features ═══');
  for (const sid of eventStore.getSessionIds()) {
    const evts = eventStore.getBySession(sid).filter((e) => e.eventType === 'chat');
    for (const e of evts) {
      const pid = String(e.metadata.promptId);
      const pf = featureStore.read('prompt', pid);
      if (!pf) continue;
      console.log(`  ${pid} (session ${sid})`);
      for (const [k, v] of Object.entries(pf.features)) {
        console.log(`    ${k.padEnd(20)} ${typeof v === 'number' ? v.toFixed(3) : v}`);
      }
    }
  }
  console.log();

  // 7. Materialize a training matrix with synthetic labels
  // v7.md #5: Label 独立于 FeatureStore，使用 LabelStore 写入和组装 Training Matrix。
  console.log('═══ Training Matrix (behavior features + labels) ═══');
  labelStore.write('sess-good', 'behavior', 'mini', 'outcome');
  labelStore.write('sess-retry-storm', 'behavior', 'large', 'outcome');
  labelStore.write('sess-context-explosion', 'behavior', 'large', 'outcome');

  const behaviorFeatures = featureStore.readAll('behavior', 1).map((f) => ({ entityId: f.entityId, features: f.features }));
  const matrix = labelStore.getTrainingMatrix(behaviorFeatures, 'behavior', 'outcome');
  console.log(`  rows: ${matrix.length}`);
  for (const row of matrix) {
    console.log(`  ${row.entityId.padEnd(24)} → label=${row.label.padEnd(6)} features={workflowEntropy=${row.features.workflowEntropy}, retryBurstScore=${row.features.retryBurstScore}, toolSwitchFrequency=${row.features.toolSwitchFrequency}}`);
  }
  console.log();

  // 8. SQL query demo (v6.md style)
  console.log('═══ SQL Query: sessions with retryRate > 0.3 ═══');
  const highRetry = db.prepare(`
    SELECT entity_id, json_extract(features, '$.retryRate') AS retryRate
    FROM feature_session
    WHERE json_extract(features, '$.retryRate') > 0.3
    ORDER BY retryRate DESC
  `).all() as { entity_id: string; retryRate: number }[];
  for (const r of highRetry) {
    console.log(`  ${r.entity_id.padEnd(24)} retryRate=${r.retryRate}`);
  }

  db.close();
  console.log('\nDemo complete. Database at', DB_PATH);
}

main();
