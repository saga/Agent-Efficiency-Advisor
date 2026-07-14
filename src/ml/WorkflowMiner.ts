// WorkflowMiner — Heuristic Miner for process discovery.
// v6.md Section 6: "Alpha Miner / Heuristic Miner / Inductive Miner"
//
// Implements the Heuristic Miner algorithm: builds a dependency/frequency
// table of directly-follows relationships, then extracts a workflow graph
// with significance and dependency thresholds.

import type { IDEEvent, IDEEventType } from '../store/types.js';

export interface WorkflowEdge {
  from: IDEEventType;
  to: IDEEventType;
  frequency: number;     // raw count of A→B
  dependency: number;    // (|A→B| - |B→A|) / (|A→B| + |B→A| + 1) — Heuristic Miner metric
}

export interface WorkflowNode {
  event: IDEEventType;
  inDegree: number;
  outDegree: number;
  frequency: number;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  // Most frequent paths (top-N)
  frequentPaths: { path: IDEEventType[]; frequency: number }[];
  // Failure patterns: paths ending in reject/session_end without accept
  failurePatterns: { path: IDEEventType[]; frequency: number }[];
}

export class WorkflowMiner {
  private directlyFollows = new Map<string, number>(); // "A→B" → count
  private nodeFrequency = new Map<string, number>();
  private sessionCount = 0;

  /**
   * Mine workflow patterns from event sequences.
   */
  mine(sessions: IDEEvent[][]): WorkflowGraph {
    this.directlyFollows.clear();
    this.nodeFrequency.clear();
    this.sessionCount = sessions.length;

    const allPaths: { path: IDEEventType[]; frequency: number }[] = [];

    for (const events of sessions) {
      const types = events.map((e) => e.eventType);
      for (let i = 0; i < types.length; i++) {
        this.nodeFrequency.set(types[i], (this.nodeFrequency.get(types[i]) ?? 0) + 1);
        if (i < types.length - 1) {
          const key = `${types[i]}→${types[i + 1]}`;
          this.directlyFollows.set(key, (this.directlyFollows.get(key) ?? 0) + 1);
        }
      }

      // Record complete path as a simplified sequence (remove consecutive duplicates)
      const simplified: IDEEventType[] = [];
      let prev: string | null = null;
      for (const t of types) {
        if (t !== prev) simplified.push(t);
        prev = t;
      }
      allPaths.push({ path: simplified, frequency: 1 });
    }

    // Merge identical paths
    const pathMap = new Map<string, { path: IDEEventType[]; frequency: number }>();
    for (const p of allPaths) {
      const key = p.path.join('→');
      if (pathMap.has(key)) {
        pathMap.get(key)!.frequency++;
      } else {
        pathMap.set(key, { path: p.path, frequency: 1 });
      }
    }

    // Build nodes
    const nodes: WorkflowNode[] = [];
    for (const [event, freq] of this.nodeFrequency) {
      let inDeg = 0, outDeg = 0;
      for (const [key] of this.directlyFollows) {
        const [from, to] = key.split('→');
        if (to === event) inDeg++;
        if (from === event) outDeg++;
      }
      nodes.push({ event: event as IDEEventType, inDegree: inDeg, outDegree: outDeg, frequency: freq });
    }
    nodes.sort((a, b) => b.frequency - a.frequency);

    // Build edges with dependency metric
    const edges: WorkflowEdge[] = [];
    for (const [key, freq] of this.directlyFollows) {
      const [from, to] = key.split('→') as [IDEEventType, IDEEventType];
      const reverseKey = `${to}→${from}`;
      const reverseFreq = this.directlyFollows.get(reverseKey) ?? 0;
      const dependency = (freq - reverseFreq) / (freq + reverseFreq + 1);
      edges.push({ from, to, frequency: freq, dependency: Number(dependency.toFixed(3)) });
    }
    edges.sort((a, b) => b.frequency - a.frequency);

    // Frequent paths (top 5)
    const frequentPaths = Array.from(pathMap.values())
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5);

    // Failure patterns: paths with retry but no accept, or ending in reject
    const failurePatterns = Array.from(pathMap.values())
      .filter((p) => {
        const hasRetry = p.path.includes('retry');
        const hasAccept = p.path.includes('accept');
        const endsReject = p.path[p.path.length - 1] === 'reject';
        return (hasRetry && !hasAccept) || endsReject;
      })
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 3);

    return { nodes, edges, frequentPaths, failurePatterns };
  }
}
