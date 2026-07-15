// GraphQueries — high-level analytical queries expressed as graph traversals.
// v6.md Section 12 lists four canonical questions the graph should answer:
//   1. Sessions that succeeded after 3+ retries.
//   2. Workspace failure correlation (does workspace type trigger failures?).
//   3. Long-term impact of a Tool / MCP / Prompt Pattern on Accept Rate.
//   4. Failure clustering by language / dependency / workflow stage.
//
// Implementation: pure graph traversal + FeatureStore lookup. No new ML model.

import type { EventStore } from '../store/EventStore.js';
import type { FeatureStore } from '../store/FeatureStore.js';
import type { GraphStore } from './GraphStore.js';
import type { FailureClassification } from '../ml/AnalyticsEngine.js';
import type { GraphNode } from './types.js';

export interface SessionsWithRetriesResult {
  sessionId: string;
  retryCount: number;
  acceptCount: number;
  rejectCount: number;
  succeeded: boolean;
}

export interface WorkspaceFailureResult {
  workspaceId: string;
  totalSessions: number;
  failureBreakdown: Record<string, number>; // failureType -> count
}

export interface ToolImpactResult {
  toolName: string;
  sessionCount: number;
  avgAcceptRate: number;
  avgRetryRate: number;
}

export interface FailureClusterResult {
  failureType: string;
  sessionCount: number;
  commonLanguages: { language: string; count: number }[];
  commonWorkspaces: { workspaceId: string; count: number }[];
  commonFiles: { path: string; count: number }[];
}

export class GraphQueries {
  constructor(
    private graphStore: GraphStore,
    private eventStore: EventStore,
    private featureStore: FeatureStore
  ) {}

  /**
   * Use case 1: Find sessions that eventually succeeded but went through
   * at least `minRetries` retry nodes.
   */
  findSessionsSucceededAfterRetries(minRetries = 3): SessionsWithRetriesResult[] {
    const sessionNodes = this.graphStore.getNodesByType('session');
    const results: SessionsWithRetriesResult[] = [];

    for (const sn of sessionNodes) {
      // Traverse session -> completion -> outcome
      const completions = this.graphStore.getNeighbors(sn.id, 'session_completion');
      let retryCount = 0;
      let acceptCount = 0;
      let rejectCount = 0;

      for (const comp of completions) {
        const outcomes = this.graphStore.getNeighbors(comp.id, 'completion_outcome');
        for (const o of outcomes) {
          if (o.type === 'retry') retryCount++;
          else if (o.type === 'accept') acceptCount++;
          else if (o.type === 'reject') rejectCount++;
        }
      }

      const succeeded = acceptCount > 0;
      if (retryCount >= minRetries && succeeded) {
        results.push({
          sessionId: sn.entityId,
          retryCount,
          acceptCount,
          rejectCount,
          succeeded,
        });
      }
    }

    return results.sort((a, b) => b.retryCount - a.retryCount);
  }

  /**
   * Use case 2: Workspace failure correlation.
   * For each workspace, aggregate failure types across its sessions.
   */
  workspaceFailureAnalysis(failures: FailureClassification[]): WorkspaceFailureResult[] {
    const failureBySession = new Map<string, string>();
    for (const f of failures) {
      if (f.failureType !== 'none') failureBySession.set(f.sessionId, f.failureType);
    }

    const workspaceNodes = this.graphStore.getNodesByType('workspace');
    const results: WorkspaceFailureResult[] = [];

    for (const ws of workspaceNodes) {
      const sessions = this.graphStore.getReverseNeighbors(ws.id, 'session_workspace');
      const breakdown: Record<string, number> = {};
      let failed = 0;

      for (const sn of sessions) {
        const ft = failureBySession.get(sn.entityId);
        if (ft) {
          breakdown[ft] = (breakdown[ft] ?? 0) + 1;
          failed++;
        }
      }

      if (failed > 0) {
        results.push({
          workspaceId: ws.entityId,
          totalSessions: sessions.length,
          failureBreakdown: breakdown,
        });
      }
    }

    return results.sort((a, b) => b.totalSessions - a.totalSessions);
  }

  /**
   * Use case 3: Long-term impact of each Tool on Accept Rate / Retry Rate.
   */
  toolAcceptRateImpact(): ToolImpactResult[] {
    const toolNodes = this.graphStore.getNodesByType('tool');
    const byTool = new Map<string, string[]>(); // toolName -> sessionIds

    for (const tn of toolNodes) {
      const name = String(tn.properties.name ?? tn.entityId);
      const sessions = this.graphStore.getReverseNeighbors(tn.id, 'session_tool');
      const sids = byTool.get(name) ?? [];
      for (const sn of sessions) sids.push(sn.entityId);
      byTool.set(name, sids);
    }

    const results: ToolImpactResult[] = [];
    for (const [toolName, sids] of byTool) {
      const unique = [...new Set(sids)];
      let accSum = 0, retrySum = 0, n = 0;
      for (const sid of unique) {
        const sf = this.featureStore.read('session', sid)?.features;
        if (!sf) continue;
        accSum += sf.acceptRate ?? 0;
        retrySum += sf.retryRate ?? 0;
        n++;
      }
      if (n === 0) continue;
      results.push({
        toolName,
        sessionCount: n,
        avgAcceptRate: Number((accSum / n).toFixed(3)),
        avgRetryRate: Number((retrySum / n).toFixed(3)),
      });
    }

    return results.sort((a, b) => b.sessionCount - a.sessionCount);
  }

  /**
   * Use case 4: Failure clustering — for each failure type, find common
   * languages, workspaces, and files among affected sessions.
   */
  failureClusterAnalysis(failures: FailureClassification[]): FailureClusterResult[] {
    const byFailure = new Map<string, string[]>();
    for (const f of failures) {
      if (f.failureType === 'none') continue;
      const arr = byFailure.get(f.failureType) ?? [];
      arr.push(f.sessionId);
      byFailure.set(f.failureType, arr);
    }

    const results: FailureClusterResult[] = [];
    for (const [failureType, sessionIds] of byFailure) {
      const langCounts = new Map<string, number>();
      const wsCounts = new Map<string, number>();
      const fileCounts = new Map<string, number>();

      for (const sid of sessionIds) {
        const sessionNode = this.graphStore.getNode(`session:${sid}`);
        if (!sessionNode) continue;

        // workspace -> languages
        const workspaces = this.graphStore.getNeighbors(sessionNode.id, 'session_workspace');
        for (const ws of workspaces) {
          wsCounts.set(ws.entityId, (wsCounts.get(ws.entityId) ?? 0) + 1);
          const langs = this.graphStore.getNeighbors(ws.id, 'workspace_language');
          for (const ln of langs) {
            langCounts.set(ln.entityId, (langCounts.get(ln.entityId) ?? 0) + 1);
          }
        }

        // files touched by session
        const files = this.graphStore.getNeighbors(sessionNode.id, 'session_file');
        for (const fn of files) {
          const path = String(fn.properties.path ?? fn.entityId);
          fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
        }
      }

      results.push({
        failureType,
        sessionCount: sessionIds.length,
        commonLanguages: this.topEntries(langCounts, 5, (key, count) => ({ language: key, count })),
        commonWorkspaces: this.topEntries(wsCounts, 3, (key, count) => ({ workspaceId: key, count })),
        commonFiles: this.topEntries(fileCounts, 5, (key, count) => ({ path: key, count })),
      });
    }

    return results.sort((a, b) => b.sessionCount - a.sessionCount);
  }

  private topEntries<T>(
    map: Map<string, number>,
    limit: number,
    mapper: (key: string, count: number) => T
  ): T[] {
    const arr = [...map.entries()].map(([key, count]) => mapper(key, count));
    arr.sort((a, b) => (b as { count: number }).count - (a as { count: number }).count);
    return arr.slice(0, limit);
  }
}
