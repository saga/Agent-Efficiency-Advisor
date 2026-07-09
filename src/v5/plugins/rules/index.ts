// Built-in V5 rules (state-machine aware) as a Plugin.

import type { Plugin, RuntimeRule, RuntimeSnapshot, RuntimeEvent, Alert } from '../../runtime/types.js';

function alert(ruleId: string, snap: RuntimeSnapshot, severity: Alert['severity'], message: string, details?: Record<string, unknown>): Alert {
  return {
    id: `${ruleId}-${snap.sessionId}-${snap.version}`,
    ruleId,
    sessionId: snap.sessionId,
    severity,
    message,
    timestamp: Date.now(),
    details,
  };
}

const ContextTooLargeRule: RuntimeRule = {
  id: 'ctx-too-large',
  name: 'Context Too Large',
  match(snap) {
    return snap.modelLimit > 0 && snap.contextTokens / snap.modelLimit >= 0.8;
  },
  action(snap) {
    const util = snap.contextTokens / snap.modelLimit;
    return alert('ctx-too-large', snap, util >= 0.95 ? 'critical' : 'warning', `Context at ${Math.round(util * 100)}%`);
  },
};

const StuckInPlanningRule: RuntimeRule = {
  id: 'stuck-planning',
  name: 'Stuck in Planning',
  match(snap, event) {
    if (event.type !== 'llm_request') return false;
    let count = 0;
    for (let i = snap.transitions.length - 1; i >= 0; i--) {
      if (snap.transitions[i].to === 'Planning') count++;
      else break;
    }
    return count >= 4;
  },
  action(snap) {
    return alert('stuck-planning', snap, 'warning', `Stuck in Planning for ${snap.transitions.length} transitions`);
  },
};

const ToolLoopRule: RuntimeRule = {
  id: 'tool-loop-v5',
  name: 'Tool Loop',
  match(snap, event) {
    if (event.type !== 'tool_call') return false;
    const seq = snap.recentTools;
    if (seq.length < 8) return false;
    for (let len = 2; len <= 5; len++) {
      const tail = seq.slice(-len * 3);
      let reps = 1;
      for (let i = len; i < tail.length; i += len) {
        const a = tail.slice(i - len, i).join(',');
        const b = tail.slice(i, i + len).join(',');
        if (a === b) reps++;
        else break;
      }
      if (reps >= 3) return true;
    }
    return false;
  },
  action(snap) {
    return alert('tool-loop-v5', snap, 'warning', `Tool loop detected: ${snap.recentTools.slice(-6).join(' → ')}`);
  },
};

const PhaseFailedRule: RuntimeRule = {
  id: 'phase-failed',
  name: 'Phase Failed',
  match(snap) {
    return snap.phase === 'Failed';
  },
  action(snap, event) {
    return alert('phase-failed', snap, 'critical', `Agent entered Failed state: ${event.payload.message ?? event.type}`);
  },
};

export const CoreRulesPlugin: Plugin = {
  id: 'core-rules',
  name: 'Core Rules',
  rules: [ContextTooLargeRule, StuckInPlanningRule, ToolLoopRule, PhaseFailedRule],
};
