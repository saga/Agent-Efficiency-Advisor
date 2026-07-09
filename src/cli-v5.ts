// V5 CLI demo: Runtime Engine + Plugins + Streaming prediction + Timeline.

import { RuntimeEngine } from './v5/runtime/RuntimeEngine.js';
import { PluginRegistry } from './v5/plugins/PluginRegistry.js';
import { corePlugins } from './v5/plugins/CorePlugins.js';
import { MetricsPipeline } from './v5/plugins/metrics/MetricsPipeline.js';
import { PredictionEngine } from './v5/plugins/predictors/index.js';
import { computeMultiHealth } from './v5/health/MultiHealth.js';
import { SlidingWindow, makeEvent } from './v5/streaming/SlidingWindow.js';
import { renderV5Dashboard } from './v5/dashboard/V5Dashboard.js';
import type { Alert, RuntimeEvent, RuntimeSnapshot } from './v5/runtime/types.js';

const SESSION_ID = 'v5-demo';

function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[H');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildScenario(sessionId: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  const push = (type: string, payload: Record<string, unknown> = {}) => {
    events.push(makeEvent(sessionId, type, payload));
  };

  push('session_start', { modelLimit: 256000 });
  push('llm_request', { promptTokens: 3000, completionTokens: 600, model: 'gpt-5' });
  push('tool_call', { tool: 'read_file', durationMs: 120, success: true, args: { path: 'src/index.ts' } });
  push('llm_request', { promptTokens: 6000, completionTokens: 900, model: 'gpt-5' });
  push('tool_call', { tool: 'grep', durationMs: 200, success: true, args: { query: 'interface' } });
  push('tool_call', { tool: 'read_file', durationMs: 100, success: true, args: { path: 'src/types.ts' } });
  push('tool_call', { tool: 'read_file', durationMs: 110, success: true, args: { path: 'src/utils.ts' } });
  push('llm_request', { promptTokens: 12000, completionTokens: 1500, model: 'gpt-5' });
  push('edit', { file: 'src/index.ts', diffLines: 14, success: true });
  push('tool_call', { tool: 'read_file', durationMs: 90, success: true, args: { path: 'src/index.ts' } });
  push('edit', { file: 'src/utils.ts', diffLines: 8, success: false });
  push('edit', { file: 'src/utils.ts', diffLines: 8, success: true });
  push('llm_request', { promptTokens: 18000, completionTokens: 2200, model: 'gpt-5' });
  push('tool_call', { tool: 'grep', durationMs: 180, success: true, args: { query: 'export' } });
  push('tool_call', { tool: 'grep', durationMs: 170, success: true, args: { query: 'export' } });
  push('tool_call', { tool: 'grep', durationMs: 160, success: true, args: { query: 'export' } });
  push('tool_call', { tool: 'read_file', durationMs: 100, success: true, args: { path: 'src/parser.ts' } });
  push('llm_request', { promptTokens: 22000, completionTokens: 1800, model: 'gpt-5' });
  push('session_end', {});

  return events;
}

async function main() {
  const engine = new RuntimeEngine();
  const registry = new PluginRegistry();
  for (const plugin of corePlugins()) registry.register(plugin);

  const metricsPipeline = new MetricsPipeline(registry.getMetricProviders());
  const predictionEngine = new PredictionEngine({ predictors: registry.getPredictors() });
  const window = new SlidingWindow({ maxEvents: 3, maxMs: 1000, maxTokenDelta: 5000 });

  const allAlerts: Alert[] = [];
  const events = buildScenario(SESSION_ID);

  console.log('Starting V5 Agent Runtime Intelligence demo...\n');

  for (const event of events) {
    const snapshot = engine.ingest(event);

    // Run rules
    for (const rule of registry.getRules()) {
      try {
        if (rule.match(snapshot, event)) {
          const alert = rule.action(snapshot, event);
          if (alert) allAlerts.push(alert);
        }
      } catch (err) {
        console.error(`Rule ${rule.id} failed:`, err);
      }
    }

    // Streaming prediction based on sliding window
    const check = window.check(snapshot);
    if (check.shouldPredict) {
      const metrics = metricsPipeline.compute(snapshot);
      const health = computeMultiHealth(snapshot, metrics);
      const prediction = await predictionEngine.predict({ snapshot, alerts: allAlerts, health });
      window.markPredicted(snapshot);

      clearScreen();
      console.log(renderV5Dashboard({ snapshot, metrics, health, prediction, alerts: allAlerts }));
      console.log(`\n[streaming] predicted because: ${check.reason}`);
    }

    await sleep(250);
  }

  // Final render with full timeline
  const snapshot = engine.get(SESSION_ID) as RuntimeSnapshot;
  const metrics = metricsPipeline.compute(snapshot);
  const health = computeMultiHealth(snapshot, metrics);
  const prediction = await predictionEngine.predict({ snapshot, alerts: allAlerts, health });

  clearScreen();
  console.log(renderV5Dashboard({ snapshot, metrics, health, prediction, alerts: allAlerts }));
  console.log('\nV5 session ended.');

  // Demonstrate time-travel
  console.log('\n── Time Travel ──');
  const midVersion = Math.floor(snapshot.events.length / 2);
  const midSnapshot = engine.getAtVersion(SESSION_ID, midVersion);
  if (midSnapshot) {
    console.log(`At v${midVersion}: phase=${midSnapshot.phase}, tokens=${midSnapshot.contextTokens}, tools=${midSnapshot.toolCalls}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
