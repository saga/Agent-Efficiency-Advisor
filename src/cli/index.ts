import { MockLogSource } from '../realtime/MockLogSource.js';
import { SessionManager } from '../realtime/SessionManager.js';
import { RuleEngine } from '../rules/RuleEngine.js';
import { defaultRules } from '../rules/ruleRegistry.js';
import { buildMetrics } from '../metrics/Metrics.js';
import { computeHealthScore } from '../metrics/HealthScorer.js';
import { advise } from '../advisor/Advisor.js';
import { renderDashboard } from '../dashboard/Dashboard.js';
import { ConsoleNotifier } from '../notifications/Notifier.js';
import { V6Sink } from '../realtime/V6Sink.js';
import { openDatabase } from '../store/schema.js';
import { EventStore } from '../store/EventStore.js';
import { FeatureRegistry } from '../store/FeatureRegistry.js';
import { FeatureStore } from '../store/FeatureStore.js';
import { FeaturePipeline } from '../store/FeaturePipeline.js';
import type { AgentLogEvent, Alert } from '../types.js';

const SESSION_ID = 'demo-session';
const DB_PATH = './data/aea-realtime.db';

function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[H');
}

async function main() {
  const source = new MockLogSource({ sessionId: SESSION_ID, intervalMs: 400 });
  const sessions = new SessionManager();
  const engine = new RuleEngine(defaultRules());
  const notifier = new ConsoleNotifier();

  // --- V6 bridge: realtime events → SQLite EventStore + FeatureStore ---
  const db = openDatabase(DB_PATH);
  const eventStore = new EventStore(db);
  const registry = new FeatureRegistry(db);
  const featureStore = new FeatureStore(db);
  const pipeline = new FeaturePipeline(featureStore, eventStore, registry);
  const v6sink = new V6Sink(eventStore, pipeline, {
    workspaceId: 'realtime-workspace',
    languages: ['TypeScript'],
  });

  const allAlerts: Alert[] = [];

  console.log('Starting Agent Efficiency Advisor (mock source)...\n');

  for await (const event of source.watch()) {
    const state = sessions.apply(event);
    const alerts = engine.evaluate(state, event);
    allAlerts.push(...alerts);

    // Bridge: write event to V6 SQLite
    v6sink.ingest(event);

    for (const alert of alerts) {
      notifier.notify(alert);
    }

    if (shouldRender(event)) {
      const metrics = buildMetrics(state);
      const health = computeHealthScore(state, metrics);
      const advisor = advise(state, allAlerts, health);

      clearScreen();
      console.log(renderDashboard(state, metrics, advisor));
    }
  }

  console.log('\nSession ended.');

  // --- V6 post-session analytics ---
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  V6 Analytics (from realtime SQLite bridge)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const events = eventStore.getBySession(SESSION_ID);
  console.log(`  Events written to V6 EventStore: ${events.length}`);

  // Show event type distribution
  const typeCounts: Record<string, number> = {};
  for (const ev of events) {
    typeCounts[ev.eventType] = (typeCounts[ev.eventType] ?? 0) + 1;
  }
  console.log('  Event type distribution:');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(16)} ${count}`);
  }

  // Show computed features
  const sessionFeat = featureStore.read('session', SESSION_ID);
  const behaviorFeat = featureStore.read('behavior', SESSION_ID);
  if (sessionFeat) {
    console.log('\n  Session features:');
    for (const [k, v] of Object.entries(sessionFeat.features)) {
      console.log(`    ${k.padEnd(24)} ${v}`);
    }
  }
  if (behaviorFeat) {
    console.log('\n  Behavior features:');
    for (const [k, v] of Object.entries(behaviorFeat.features)) {
      console.log(`    ${k.padEnd(24)} ${v.toFixed(4)}`);
    }
  }

  console.log(`\n  Database: ${DB_PATH}`);
  db.close();
}

function shouldRender(event: AgentLogEvent): boolean {
  return event.type === 'tool_call' || event.type === 'edit' || event.type === 'llm_request';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
