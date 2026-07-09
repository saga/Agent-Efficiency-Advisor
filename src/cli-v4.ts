import { MockLogSource } from './realtime/MockLogSource.js';
import { SessionManager } from './realtime/SessionManager.js';
import { RuleEngine } from './rules/RuleEngine.js';
import { defaultRules } from './rules/ruleRegistry.js';
import { buildMetrics } from './metrics/Metrics.js';
import { computeHealthScore } from './metrics/HealthScorer.js';
import { renderDashboard } from './dashboard/Dashboard.js';
import { CatBoostAdvisor } from './ml/CatBoostAdvisor.js';
import { ShadowRunner, MockShadowTaskRunner } from './ml/shadow/ShadowRunner.js';
import { FeedbackCollector } from './ml/feedback/FeedbackCollector.js';
import type { Alert, OutcomeSignal, SessionState } from './types.js';

const SESSION_ID = 'v4-demo';

function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[H');
}

function simulateOutcome(state: SessionState): OutcomeSignal {
  const isHealthy = state.retries === 0 && state.contextTokens < 50000;
  return {
    testPassed: isHealthy || Math.random() > 0.3,
    committed: isHealthy || Math.random() > 0.4,
    noRetry: state.retries === 0,
    noRevert: isHealthy || Math.random() > 0.5,
  };
}

async function main() {
  const source = new MockLogSource({ sessionId: SESSION_ID, intervalMs: 400 });
  const sessions = new SessionManager();
  const engine = new RuleEngine(defaultRules());
  const advisor = new CatBoostAdvisor({ modelPath: './data/ml/model.cbm' });
  const shadow = new ShadowRunner({
    sampleRate: 0.15,
    shadowModel: 'gpt-5-mini',
    runner: new MockShadowTaskRunner({ shadowModel: 'gpt-5-mini' }),
  });
  const feedback = new FeedbackCollector('./data/ml/feedback.csv');

  const allAlerts: Alert[] = [];
  let recommendation = await advisor.recommendFromFeatures({
    promptTokens: 0,
    completionTokens: 0,
    contextTokens: 0,
    toolCalls: 0,
    readFiles: 0,
    edits: 0,
    retries: 0,
    uniqueFilesRead: 0,
    uniqueFilesEdited: 0,
    elapsedMs: 0,
    contextUtilization: 0,
    readToEditRatio: 0,
    retryRate: 0,
    hasLoop: 0,
    subAgents: 0,
  });

  console.log('Starting Agent Efficiency Advisor V4...\n');

  for await (const event of source.watch()) {
    const state = sessions.apply(event);
    const alerts = engine.evaluate(state, event);
    allAlerts.push(...alerts);

    if (event.type === 'llm_request' || event.type === 'tool_call' || event.type === 'edit') {
      recommendation = await advisor.recommend(state);
    }

    if (event.type === 'session_end') {
      const shadowResult = await shadow.evaluate(state, recommendation.model);
      if (shadowResult) {
        allAlerts.push({
          id: `shadow-${state.sessionId}-${Date.now()}`,
          ruleId: 'shadow-evaluation',
          sessionId: state.sessionId,
          severity: shadowResult.shadowSuccess ? 'info' : 'warning',
          message: `Shadow ${shadowResult.shadowModel} ${shadowResult.shadowSuccess ? 'succeeded' : 'failed'}; label=${shadowResult.label}`,
          timestamp: Date.now(),
        });
        feedback.recordShadowResult(state, shadowResult.label, shadowResult.confidence);
      }

      const outcome = simulateOutcome(state);
      feedback.recordOutcome(state, outcome, recommendation.model);
      feedback.flush();
    }

    if (event.type === 'llm_request' || event.type === 'tool_call' || event.type === 'edit' || event.type === 'session_end') {
      const metrics = buildMetrics(state);
      const health = computeHealthScore(state, metrics);

      clearScreen();
      const taskComplexity = recommendation.model === 'mini' ? 25 : recommendation.model === 'medium' ? 60 : 90;
      console.log(renderDashboard(state, metrics, { taskComplexity, recommendation, alerts: allAlerts.slice(-5), health }));
      console.log(`\nShadow samples: ${shadow.stats().sampled}/${shadow.stats().total}`);
      console.log(`Feedback buffer: ${feedback.pendingCount()} pending (flushed on session_end)`);
    }
  }

  console.log('\nV4 session ended.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
