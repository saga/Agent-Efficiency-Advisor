import { MockLogSource } from './realtime/MockLogSource.js';
import { SessionManager } from './realtime/SessionManager.js';
import { RuleEngine } from './rules/RuleEngine.js';
import { defaultRules } from './rules/ruleRegistry.js';
import { buildMetrics } from './metrics/Metrics.js';
import { computeHealthScore } from './metrics/HealthScorer.js';
import { advise } from './advisor/Advisor.js';
import { renderDashboard } from './dashboard/Dashboard.js';
import { ConsoleNotifier } from './notifications/Notifier.js';
import type { AgentLogEvent, Alert, SessionState } from './types.js';

const SESSION_ID = 'demo-session';

function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[H');
}

async function main() {
  const source = new MockLogSource({ sessionId: SESSION_ID, intervalMs: 400 });
  const sessions = new SessionManager();
  const engine = new RuleEngine(defaultRules());
  const notifier = new ConsoleNotifier();

  const allAlerts: Alert[] = [];

  console.log('Starting Agent Efficiency Advisor (mock source)...\n');

  for await (const event of source.watch()) {
    const state = sessions.apply(event);
    const alerts = engine.evaluate(state, event);
    allAlerts.push(...alerts);

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
}

function shouldRender(event: AgentLogEvent): boolean {
  return event.type === 'tool_call' || event.type === 'edit' || event.type === 'llm_request';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
