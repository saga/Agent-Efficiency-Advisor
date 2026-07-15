// WorkflowMiner tests — verify directly-follows frequency and dependency metric.

import { describe, it, expect } from 'vitest';
import { WorkflowMiner } from '../src/ml/WorkflowMiner.js';
import type { IDEEvent } from '../src/store/types.js';

function makeSession(types: string[], sid = 's1'): IDEEvent[] {
  const t = Date.now();
  return types.map((type, i) => ({
    timestamp: t + i,
    sessionId: sid,
    workspaceId: 'ws',
    eventType: type as IDEEvent['eventType'],
    metadata: {},
  }));
}

describe('WorkflowMiner', () => {
  it('builds directly-follows frequency table', () => {
    const miner = new WorkflowMiner();
    const graph = miner.mine([
      makeSession(['session_start', 'chat', 'completion', 'accept', 'session_end']),
    ]);

    const chatToCompletion = graph.edges.find((e) => e.from === 'chat' && e.to === 'completion');
    expect(chatToCompletion).toBeDefined();
    expect(chatToCompletion!.frequency).toBe(1);
  });

  it('computes dependency metric = 1 for unidirectional flows', () => {
    // If A→B always and B→A never, dependency = freq / (freq + 0 + 1) ≈ freq/(freq+1)
    // For freq=2: dependency = (2-0)/(2+0+1) = 2/3
    const miner = new WorkflowMiner();
    const graph = miner.mine([
      makeSession(['session_start', 'chat', 'completion', 'session_end']),
      makeSession(['session_start', 'chat', 'completion', 'session_end'], 's2'),
    ]);

    const edge = graph.edges.find((e) => e.from === 'chat' && e.to === 'completion');
    expect(edge).toBeDefined();
    expect(edge!.frequency).toBe(2);
    expect(edge!.dependency).toBeCloseTo(2 / 3, 2);
  });

  it('computes dependency metric near 0 for bidirectional flows', () => {
    // If A→B and B→A both happen, dependency ≈ 0
    const miner = new WorkflowMiner();
    const graph = miner.mine([
      makeSession(['chat', 'completion']), // chat→completion
      makeSession(['completion', 'chat'], 's2'), // completion→chat
    ]);

    const edge = graph.edges.find((e) => e.from === 'chat' && e.to === 'completion');
    expect(edge).toBeDefined();
    expect(edge!.frequency).toBe(1);
    // dependency = (1-1)/(1+1+1) = 0
    expect(edge!.dependency).toBeCloseTo(0, 5);
  });

  it('identifies failure patterns (paths ending in reject without accept)', () => {
    const miner = new WorkflowMiner();
    const graph = miner.mine([
      makeSession(['session_start', 'chat', 'completion', 'retry', 'reject', 'session_end']),
    ]);

    expect(graph.failurePatterns.length).toBeGreaterThan(0);
    // At least one failure pattern should contain 'reject'
    const hasReject = graph.failurePatterns.some((p) => p.path.includes('reject'));
    expect(hasReject).toBe(true);
  });

  it('computes node inDegree and outDegree', () => {
    const miner = new WorkflowMiner();
    const graph = miner.mine([
      makeSession(['session_start', 'chat', 'completion', 'accept', 'session_end']),
    ]);

    const chatNode = graph.nodes.find((n) => n.event === 'chat');
    expect(chatNode).toBeDefined();
    expect(chatNode!.inDegree).toBe(1); // session_start → chat
    expect(chatNode!.outDegree).toBe(1); // chat → completion
  });
});
