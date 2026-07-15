// GraphBuilder — construct the Temporal Property Graph from EventStore + FeatureStore.
// v6.md Section 12: nodes = Session / Prompt / Workspace / Commit / Completion /
// Accept|Reject|Retry / File / Language / Dependency / Tool.

import type { EventStore } from '../store/EventStore.js';
import type { FeatureStore } from '../store/FeatureStore.js';
import type { GraphStore } from './GraphStore.js';
import type { GraphEdge, GraphNode, GraphNodeType } from './types.js';
import type { IDEEvent } from '../store/types.js';

export interface BuildResult {
  nodes: number;
  edges: number;
  sessions: number;
}

export class GraphBuilder {
  // Track edges already added in this build to avoid duplicates.
  // Some relationships (workspace_language, workspace_dependency) are intrinsic
  // to the workspace and would otherwise be re-inserted once per session.
  private edgesAdded = new Set<string>();

  constructor(
    private eventStore: EventStore,
    private featureStore: FeatureStore,
    private graphStore: GraphStore
  ) {}

  /**
   * Rebuild the entire graph from scratch.
   */
  build(): BuildResult {
    this.graphStore.clear();
    this.edgesAdded.clear();

    const sessionIds = this.eventStore.getSessionIds();
    for (const sid of sessionIds) {
      this.buildSession(sid);
    }

    const stats = this.graphStore.stats();
    return { nodes: stats.nodes, edges: stats.edges, sessions: sessionIds.length };
  }

  private buildSession(sessionId: string): void {
    const events = this.eventStore.getBySession(sessionId);
    if (!events.length) return;

    const startTime = events[0].timestamp;
    const endTime = events[events.length - 1].timestamp;
    const workspaceId = events[0].workspaceId;

    // --- Session node (augmented with feature snapshot) ---
    const sessionFeat = this.featureStore.read('session', sessionId)?.features ?? {};
    const sessionNode = this.makeNode('session', sessionId, {
      startTime,
      endTime,
      duration: endTime - startTime,
      acceptRate: sessionFeat.acceptRate,
      retryRate: sessionFeat.retryRate,
    }, startTime);
    this.graphStore.upsertNode(sessionNode);

    // --- Workspace node + edges ---
    const workspaceNode = this.makeNode('workspace', workspaceId, {}, startTime);
    this.graphStore.upsertNode(workspaceNode);
    this.addEdge(sessionNode.id, workspaceNode.id, 'session_workspace', {}, startTime);

    // Languages / dependencies from session_start metadata
    const startEvent = events.find((e) => e.eventType === 'session_start');
    const languages = this.readArray(startEvent, 'languages');
    const dependencies = this.readArray(startEvent, 'dependencies');
    for (const lang of languages) {
      const node = this.makeNode('language', lang, { name: lang }, startTime);
      this.graphStore.upsertNode(node);
      this.addEdge(workspaceNode.id, node.id, 'workspace_language', {}, startTime);
    }
    for (const dep of dependencies) {
      const node = this.makeNode('dependency', dep, { name: dep }, startTime);
      this.graphStore.upsertNode(node);
      this.addEdge(workspaceNode.id, node.id, 'workspace_dependency', {}, startTime);
    }

    // --- Iterate events to build temporal edges ---
    let lastCompletionNode: GraphNode | null = null;
    let filesBufferedForPrompt: GraphNode[] = [];
    const toolsInSession = new Set<string>();

    for (const ev of events) {
      switch (ev.eventType) {
        case 'read_file': {
          const path = String(ev.metadata?.path ?? 'unknown');
          const fileNode = this.makeNode('file', path, { path }, ev.timestamp);
          this.graphStore.upsertNode(fileNode);
          this.addEdge(sessionNode.id, fileNode.id, 'session_file', {}, ev.timestamp);
          filesBufferedForPrompt.push(fileNode);
          break;
        }
        case 'chat': {
          const promptId = String(ev.metadata?.promptId ?? `prompt-${ev.id ?? ev.timestamp}`);
          const promptNode = this.makeNode('prompt', promptId, {
            tokenCount: this.readNum(ev, 'tokenCount'),
            retrievedFiles: this.readNum(ev, 'retrievedFiles'),
            contextToken: this.readNum(ev, 'contextToken'),
            historyToken: this.readNum(ev, 'historyToken'),
          }, ev.timestamp);
          this.graphStore.upsertNode(promptNode);
          this.addEdge(sessionNode.id, promptNode.id, 'session_prompt', {}, ev.timestamp);

          // Files read before this prompt become its context
          for (const fileNode of filesBufferedForPrompt) {
            this.addEdge(promptNode.id, fileNode.id, 'prompt_file', {}, ev.timestamp);
          }
          filesBufferedForPrompt = [];
          break;
        }
        case 'completion': {
          const completionId = `completion:${sessionId}:${ev.id ?? ev.timestamp}`;
          const completionNode = this.makeNode('completion', completionId, {
            tokenCount: this.readNum(ev, 'tokenCount'),
          }, ev.timestamp);
          this.graphStore.upsertNode(completionNode);
          this.addEdge(sessionNode.id, completionNode.id, 'session_completion', {}, ev.timestamp);
          lastCompletionNode = completionNode;
          break;
        }
        case 'accept':
        case 'reject':
        case 'retry': {
          const outcomeId = `${ev.eventType}:${sessionId}:${ev.id ?? ev.timestamp}`;
          const outcomeNode = this.makeNode(ev.eventType, outcomeId, {}, ev.timestamp);
          this.graphStore.upsertNode(outcomeNode);
          if (lastCompletionNode) {
            this.addEdge(lastCompletionNode.id, outcomeNode.id, 'completion_outcome', { kind: ev.eventType }, ev.timestamp);
          }
          break;
        }
        case 'commit': {
          const commitId = `commit:${sessionId}:${ev.id ?? ev.timestamp}`;
          const commitNode = this.makeNode('commit', commitId, {
            branch: String(ev.metadata?.branch ?? 'unknown'),
            author: String(ev.metadata?.author ?? 'unknown'),
          }, ev.timestamp);
          this.graphStore.upsertNode(commitNode);
          this.addEdge(sessionNode.id, commitNode.id, 'session_commit', {}, ev.timestamp);
          break;
        }
        case 'run_test':
        case 'terminal':
        case 'tool_call': {
          const toolName = String(ev.metadata?.toolName ?? ev.eventType);
          const dedupKey = `${toolName}@${sessionId}`;
          if (toolsInSession.has(dedupKey)) break;
          toolsInSession.add(dedupKey);
          const toolNode = this.makeNode('tool', dedupKey, { name: toolName, sessionId }, ev.timestamp);
          this.graphStore.upsertNode(toolNode);
          this.addEdge(sessionNode.id, toolNode.id, 'session_tool', {}, ev.timestamp);
          break;
        }
      }
    }
  }

  private makeNode(type: GraphNodeType, entityId: string, properties: Record<string, unknown>, createdAt: number): GraphNode {
    return {
      id: `${type}:${entityId}`,
      type,
      entityId,
      properties,
      createdAt,
    };
  }

  private addEdge(sourceId: string, targetId: string, type: GraphEdge['type'], properties: Record<string, unknown>, timestamp: number): void {
    const key = `${sourceId}|${targetId}|${type}`;
    if (this.edgesAdded.has(key)) return;
    this.edgesAdded.add(key);
    this.graphStore.insertEdge({ sourceId, targetId, type, properties, timestamp });
  }

  private readArray(ev: IDEEvent | undefined, key: string): string[] {
    if (!ev) return [];
    const v = ev.metadata?.[key];
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
    return [];
  }

  private readNum(ev: IDEEvent, key: string): number {
    const v = ev.metadata?.[key];
    return typeof v === 'number' ? v : 0;
  }
}
