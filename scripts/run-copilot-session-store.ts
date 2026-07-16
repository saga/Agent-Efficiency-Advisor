// Ingest real VSCode Copilot Chat session-state SQLite into AEA V6+ pipeline.
//
// Reads: ~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/session-store.db
// Writes: ./data/aea-session-store.db
//
// This complements demo:real-copilot (which reads low-level debug-logs/main.jsonl):
//   - session-store.db  → high-level chat semantics (prompts, responses, repo, branch, cwd)
//   - debug-logs        → low-level execution trace (tokens, model, tool calls, duration)

import { rmSync, existsSync } from 'node:fs';
import { openDatabase } from '../src/store/schema.js';
import { EventStore } from '../src/store/EventStore.js';
import { FeatureRegistry } from '../src/store/FeatureRegistry.js';
import { FeatureStore } from '../src/store/FeatureStore.js';
import { FeaturePipeline } from '../src/store/FeaturePipeline.js';
import { CopilotSessionStore } from '../src/realtime/CopilotSessionStore.js';
import { AnalyticsEngine } from '../src/ml/AnalyticsEngine.js';
import { EmbeddingStore } from '../src/embedding/EmbeddingStore.js';

const OUT_DB = './data/aea-real.db';

function main() {
  // Fresh output DB
  rmSync(OUT_DB, { force: true });
  rmSync(`${OUT_DB}-wal`, { force: true });
  rmSync(`${OUT_DB}-shm`, { force: true });

  const source = new CopilotSessionStore();
  const db = openDatabase(OUT_DB);
  const eventStore = new EventStore(db);
  const registry = new FeatureRegistry(db);
  const featureStore = new FeatureStore(db);
  const pipeline = new FeaturePipeline(featureStore, eventStore, registry);

  pipeline.initializeRegistry();

  const sessions = source.getSessions();
  console.log(`═══ Copilot Session Store: ${sessions.length} session(s) ═══`);

  let totalEvents = 0;
  for (const session of sessions) {
    console.log(`\nSession ${session.id}`);
    console.log(`  createdAt: ${new Date(session.createdAt).toISOString()}`);
    console.log(`  repo: ${session.repository ?? 'unknown'}`);
    console.log(`  branch: ${session.branch ?? 'unknown'}`);
    console.log(`  cwd: ${session.cwd ?? 'unknown'}`);
    console.log(`  summary: ${session.summary ?? '(none)'}`);

    const events = source.toIDEEvents(session);
    totalEvents += events.length;
    eventStore.insertBatch(events);
    pipeline.computeSession(session.id);
  }

  source.close();

  console.log(`\n═══ Ingested ${totalEvents} IDEEvent(s) across ${sessions.length} session(s) ═══`);
  console.log(`  distinct sessions in EventStore: ${eventStore.getSessionIds().length}`);
  console.log(`  total events in EventStore: ${eventStore.count()}`);

  // Show session + behavior features
  console.log('\n═══ Session Features ═══');
  for (const sid of eventStore.getSessionIds()) {
    const sf = featureStore.read('session', sid);
    const bf = featureStore.read('behavior', sid);
    if (!sf) continue;
    console.log(`  ${sid}`);
    console.log(`    duration: ${sf.features.duration} ms`);
    console.log(`    acceptRate: ${sf.features.acceptRate}`);
    console.log(`    retryRate: ${sf.features.retryRate}`);
    if (bf) {
      console.log(`    workflowEntropy: ${bf.features.workflowEntropy}`);
      console.log(`    retryBurstScore: ${bf.features.retryBurstScore}`);
      console.log(`    workflowLength: ${bf.features.workflowLength}`);
    }
  }

  // Run analytics if we have data
  if (eventStore.count() > 0) {
    const embeddingStore = new EmbeddingStore(db);
    const engine = new AnalyticsEngine(eventStore, featureStore, embeddingStore);
    const report = engine.analyze();
    console.log('\n═══ Analytics Summary ═══');
    console.log(`  sessions: ${report.summary.sessions}`);
    console.log(`  events: ${report.summary.events}`);
    console.log(`  avgAcceptRate: ${report.summary.avgAcceptRate}`);
    console.log(`  avgRetryRate: ${report.summary.avgRetryRate}`);
    console.log(`  healthDirection: ${report.summary.healthDirection}`);
    console.log(`  topFailure: ${report.summary.topFailure}`);
    console.log(`  topFailurePattern: ${report.summary.topFailurePattern}`);
    console.log(`  topWorkflow: ${report.summary.topWorkflow}`);
    console.log(`  anomalyScore: ${report.summary.anomalyScore}`);
  }

  db.close();
  console.log(`\nDone. Output database: ${OUT_DB}`);
}

main();
