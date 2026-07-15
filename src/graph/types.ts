// Session Graph — Temporal Property Graph types.
// v6.md Section 12: model relationships between Session / Prompt / Workspace /
// GitCommit / Completion / Accept|Reject|Retry / File / Language / Dependency / Tool.

export type GraphNodeType =
  | 'session'
  | 'prompt'
  | 'workspace'
  | 'commit'
  | 'completion'
  | 'accept'
  | 'reject'
  | 'retry'
  | 'file'
  | 'language'
  | 'dependency'
  | 'tool';

export type GraphEdgeType =
  | 'session_workspace'
  | 'session_prompt'
  | 'session_completion'
  | 'session_commit'
  | 'session_file'
  | 'session_tool'
  | 'completion_outcome' // completion -> accept|reject|retry
  | 'prompt_file'
  | 'workspace_language'
  | 'workspace_dependency';

export interface GraphNode {
  id: string; // synthetic: `${type}:${entityId}`
  type: GraphNodeType;
  entityId: string;
  properties: Record<string, unknown>;
  createdAt: number;
}

export interface GraphEdge {
  id?: number;
  sourceId: string;
  targetId: string;
  type: GraphEdgeType;
  properties: Record<string, unknown>;
  timestamp: number;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
}
