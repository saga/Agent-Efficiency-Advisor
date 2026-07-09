import type { AgentLogEvent, Alert, Rule, SessionState } from '../types.js';

export class RuleEngine {
  constructor(private rules: Rule[]) {}

  evaluate(state: SessionState, event: AgentLogEvent): Alert[] {
    const alerts: Alert[] = [];
    for (const rule of this.rules) {
      try {
        if (rule.match(state, event)) {
          const alert = rule.action(state, event);
          if (alert) alerts.push(alert);
        }
      } catch (err) {
        console.error(`Rule ${rule.id} failed:`, err);
      }
    }
    return alerts;
  }
}
