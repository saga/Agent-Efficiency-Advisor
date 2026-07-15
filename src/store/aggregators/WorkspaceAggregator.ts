// WorkspaceAggregator — Event → WorkspaceAggregate.
// v7.md #1: 只负责聚合，不计算任何派生指标（complexity 留给 Calculator）。

import type { IDEEvent } from '../types.js';
import type { WorkspaceAggregate } from './types.js';

export class WorkspaceAggregator {
  aggregate(workspaceId: string, events: IDEEvent[]): WorkspaceAggregate {
    const files = new Set<string>();
    const languages = new Set<string>();
    const branches = new Set<string>();
    let totalLOC = 0;
    let maxDependencies = 0;

    for (const e of events) {
      const path = String(e.metadata.path ?? e.metadata.file ?? '');
      if (path) files.add(path);
      const lang = String(e.metadata.language ?? '');
      if (lang) languages.add(lang);
      const branch = String(e.metadata.branch ?? '');
      if (branch) branches.add(branch);
      if (typeof e.metadata.loc === 'number') totalLOC += e.metadata.loc;
      if (typeof e.metadata.dependencies === 'number') {
        maxDependencies = Math.max(maxDependencies, e.metadata.dependencies);
      }
    }

    return { workspaceId, files, languages, branches, totalLOC, maxDependencies };
  }
}
