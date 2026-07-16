import fs from 'node:fs';
import path from 'node:path';
import { CopilotParser } from '../src/realtime/LogParser.js';
import { SessionManager } from '../src/realtime/SessionManager.js';
import { RuleEngine } from '../src/rules/RuleEngine.js';
import { defaultRules } from '../src/rules/ruleRegistry.js';
import { V6Sink } from '../src/realtime/V6Sink.js';
import { openDatabase } from '../src/store/schema.js';
import { EventStore } from '../src/store/EventStore.js';
import { FeatureRegistry } from '../src/store/FeatureRegistry.js';
import { FeatureStore } from '../src/store/FeatureStore.js';
import { FeaturePipeline } from '../src/store/FeaturePipeline.js';
import { AnalyticsEngine } from '../src/ml/AnalyticsEngine.js';
import { EmbeddingStore } from '../src/embedding/EmbeddingStore.js';
import { buildMetrics } from '../src/metrics/Metrics.js';
import { computeHealthScore } from '../src/metrics/HealthScorer.js';
import type { Alert } from '../src/types.js';

const LOG_DIR = process.env.COPILOT_LOG_DIR ?? '/Users/saga/Library/Application Support/Code/User/workspaceStorage';
const DB_PATH = process.env.AEA_REAL_COPILOT_DB ?? './data/aea-real-copilot.db';

function scan(dir: string, depth = 0): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 5) {
      found.push(...scan(full, depth + 1));
    } else if (entry.isFile() && entry.name === 'main.jsonl' && full.includes('debug-logs')) {
      found.push(full);
    }
  }
  return found;
}

async function main() {
  const files = scan(LOG_DIR);
  const parser = new CopilotParser();
  const sessions = new SessionManager();
  const engine = new RuleEngine(defaultRules());

  const db = openDatabase(DB_PATH);
  const eventStore = new EventStore(db);
  const registry = new FeatureRegistry(db);
  const featureStore = new FeatureStore(db);
  const pipeline = new FeaturePipeline(featureStore, eventStore, registry);
  const embeddingStore = new EmbeddingStore(db);
  const analytics = new AnalyticsEngine(eventStore, featureStore, embeddingStore);
  const v6sink = new V6Sink(eventStore, pipeline, {
    workspaceId: 'real-copilot-workspace',
    languages: ['TypeScript'],
  });

  const allAlerts: Alert[] = [];
  let lineCount = 0;
  let parsedCount = 0;
  const typeCounts: Record<string, number> = {};
  const unmappedTypes = new Map<string, number>();

  console.log(`Found ${files.length} real Copilot debug log files\n`);

  for (const file of files) {
    const sessionId = path.basename(path.dirname(file));
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);
    console.log(`  ${file} (${lines.length} lines, session=${sessionId})`);

    for (const line of lines) {
      lineCount++;
      const event = parser.parse(line, sessionId);
      if (event) {
        parsedCount++;
        typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1;
        const state = sessions.apply(event);
        const alerts = engine.evaluate(state, event);
        allAlerts.push(...alerts);
        v6sink.ingest(event);
      } else {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const t = String(obj.type ?? 'unknown');
          unmappedTypes.set(t, (unmappedTypes.get(t) ?? 0) + 1);
        } catch {
          // ignore invalid json
        }
      }
    }

    // Real Copilot logs do not emit session_end; trigger feature computation here.
    v6sink.flushSession(sessionId);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Real Copilot Log Ingestion Report');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`Total JSONL lines: ${lineCount}`);
  console.log(`Parsed by AEA:     ${parsedCount} (${((parsedCount / lineCount) * 100).toFixed(1)}%)`);
  console.log(`Unmapped types:    ${Array.from(unmappedTypes.entries()).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`Mapped types:      ${JSON.stringify(typeCounts, null, 2)}`);
  console.log(`Alerts generated:  ${allAlerts.length}`);
  console.log(`Sessions tracked:  ${sessions.all().length}`);

  for (const session of sessions.all()) {
    const metrics = buildMetrics(session);
    const health = computeHealthScore(session, metrics);
    console.log(`\n  Session ${session.sessionId}:`);
    console.log(`    events:    ${session.events.length}`);
    console.log(`    tokens:    prompt=${session.promptTokens} completion=${session.completionTokens} cache=${session.cacheTokens}`);
    console.log(`    tools:     ${session.toolCalls}  edits: ${session.edits}  retries: ${session.retries}`);
    console.log(`    health:    ${health.score} (${health.label})`);
  }

  const report = analytics.analyze();
  console.log('\n  Analytics Summary:');
  console.log(`    sessions: ${report.summary.sessions}`);
  console.log(`    events:   ${report.summary.events}`);
  console.log(`    avgAcceptRate: ${report.summary.avgAcceptRate}`);
  console.log(`    avgRetryRate:  ${report.summary.avgRetryRate}`);
  console.log(`    healthDirection: ${report.summary.healthDirection}`);
  console.log(`    topFailure: ${report.summary.topFailure}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
