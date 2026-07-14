// BehaviorModel — Markov chain over event sequences.
// v6.md Section 5: "Markov 或者 Sequence Mining" — learn developer behavior patterns.
//
// Builds a first-order Markov chain: P(next_event | current_event).
// Can generate typical workflows and score sequence probability.

import type { IDEEvent, IDEEventType } from '../store/types.js';

export interface Transition {
  from: IDEEventType;
  to: IDEEventType;
  probability: number;
  count: number;
}

export interface BehaviorReport {
  states: IDEEventType[];
  transitions: Transition[];
  startDistribution: Record<string, number>;
  topWorkflows: { sequence: IDEEventType[]; probability: number }[];
  anomalyScore: number; // 0..1, how anomalous the observed sequences are
}

export class BehaviorModel {
  private transitions = new Map<string, number>(); // "from→to" → count
  private fromCounts = new Map<string, number>();
  private startCounts = new Map<string, number>();
  private totalSequences = 0;
  private states = new Set<string>();

  /**
   * Train the Markov chain from event sequences (one per session).
   */
  train(sessions: IDEEvent[][]): void {
    for (const events of sessions) {
      const types = events.map((e) => e.eventType);
      if (types.length === 0) continue;

      this.totalSequences++;
      this.startCounts.set(types[0], (this.startCounts.get(types[0]) ?? 0) + 1);

      for (let i = 0; i < types.length; i++) {
        this.states.add(types[i]);
        if (i < types.length - 1) {
          const key = `${types[i]}→${types[i + 1]}`;
          this.transitions.set(key, (this.transitions.get(key) ?? 0) + 1);
          this.fromCounts.set(types[i], (this.fromCounts.get(types[i]) ?? 0) + 1);
        }
      }
    }
  }

  /**
   * Get the probability of a transition.
   */
  probability(from: IDEEventType, to: IDEEventType): number {
    const count = this.transitions.get(`${from}→${to}`) ?? 0;
    const total = this.fromCounts.get(from) ?? 0;
    return total > 0 ? count / total : 0;
  }

  /**
   * Score the log-probability of an event sequence.
   * Lower (more negative) = more anomalous.
   */
  scoreSequence(types: IDEEventType[]): number {
    let logProb = 0;
    for (let i = 0; i < types.length - 1; i++) {
      const p = this.probability(types[i], types[i + 1]);
      logProb += Math.log(p + 1e-10);
    }
    return logProb;
  }

  /**
   * Generate the most likely workflow starting from a state (greedy).
   */
  generateTypicalWorkflow(start: IDEEventType, maxLen = 10): { sequence: IDEEventType[]; probability: number } {
    const sequence: IDEEventType[] = [start];
    let prob = 1;
    let current = start;

    for (let step = 0; step < maxLen - 1; step++) {
      let bestNext: IDEEventType | null = null;
      let bestProb = 0;
      for (const state of this.states) {
        const p = this.probability(current, state as IDEEventType);
        if (p > bestProb) {
          bestProb = p;
          bestNext = state as IDEEventType;
        }
      }
      if (!bestNext || bestProb < 0.01) break;
      sequence.push(bestNext);
      prob *= bestProb;
      current = bestNext;
      if (current === 'session_end') break;
    }

    return { sequence, probability: Number(prob.toFixed(4)) };
  }

  /**
   * Generate a full behavior report.
   */
  report(): BehaviorReport {
    const stateList = Array.from(this.states) as IDEEventType[];
    const transitions: Transition[] = [];
    for (const [key, count] of this.transitions) {
      const [from, to] = key.split('→') as [IDEEventType, IDEEventType];
      const total = this.fromCounts.get(from) ?? 0;
      transitions.push({
        from,
        to,
        count,
        probability: Number((count / total).toFixed(4)),
      });
    }
    transitions.sort((a, b) => b.count - a.count);

    // Top workflows from most common start states
    const startDist: Record<string, number> = {};
    for (const [state, count] of this.startCounts) {
      startDist[state] = Number((count / this.totalSequences).toFixed(4));
    }
    const topStarts = Object.entries(startDist)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([s]) => s as IDEEventType);

    const topWorkflows = topStarts.map((s) => this.generateTypicalWorkflow(s, 8));

    // Anomaly score: average negative log-prob of transitions (higher = more chaotic)
    const avgNegLogProb = transitions.length > 0
      ? transitions.reduce((s, t) => s - Math.log(t.probability + 1e-10) * t.count, 0) /
        transitions.reduce((s, t) => s + t.count, 0)
      : 0;
    const anomalyScore = Number(Math.min(1, avgNegLogProb / 5).toFixed(3)); // normalize to 0..1

    return { states: stateList, transitions, startDistribution: startDist, topWorkflows, anomalyScore };
  }
}
