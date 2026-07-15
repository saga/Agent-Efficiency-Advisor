// GraphBuilder — construct the Temporal Property Graph from Canonical Entities.
// v7.md #2: Graph 不应该直接耦合 Event，应该来自 Canonical Entity。
//           "Graph 不应该知道 Event，应该知道 Session/Prompt/Workspace/Completion/Tool/Failure 这些 Entity。"
// v7.md #7: Graph 不应该存 Feature，应该存 Reference。
//           "Node Attribute: featureVersion=4，真正 Feature 仍然 Feature Store。"
//
// 数据流: EventStore → EntityBuilder → EntityBundle → GraphBuilder → Graph
// GraphBuilder 只读取 EntityBundle + FeatureStore(仅读 featureVersion Reference)，不再读 Event。

import type { EventStore } from '../store/EventStore.js';
import type { FeatureStore } from '../store/FeatureStore.js';
import type { GraphStore } from './GraphStore.js';
import type { GraphEdge, GraphNode, GraphNodeType } from './types.js';
import type { EntityBuilder } from '../entity/index.js';

export interface BuildResult {
  nodes: number;
  edges: number;
  sessions: number;
}

export class GraphBuilder {
  private edgesAdded = new Set<string>();

  constructor(
    private eventStore: EventStore,
    private featureStore: FeatureStore,
    private graphStore: GraphStore,
    private entityBuilder: EntityBuilder
  ) {}

  /**
   * Rebuild the entire graph from scratch via EntityBuilder.
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
    // v7.md #2: GraphBuilder 不直接读 Event。通过 EventStore 获取事件传给 EntityBuilder
    //           是可接受的（EventStore 是存储层，不是 Event 本身的语义耦合），
    //           但所有语义解析由 EntityBuilder 完成，GraphBuilder 只消费 EntityBundle。
    const events = this.eventStore.getBySession(sessionId);
    if (!events.length) return;

    // v7.md #7: 读取 featureVersion 作为 Reference，但不把 Feature 数据塞进 Node。
    const featureVersion = this.featureStore.read('session', sessionId)?.version;

    const bundle = this.entityBuilder.buildBundle(events, featureVersion);
    if (!bundle) return;

    const { session, workspace, prompts, completions, toolInvocations, outcomes, files, commits, promptFileLinks } = bundle;

    // --- Session node (v7.md #7: 存 featureVersion Reference，不存 Feature 数据) ---
    const sessionNode = this.makeNode('session', session.id, {
      startTime: session.startTime,
      endTime: session.endTime,
      duration: session.duration,
      featureVersion: session.featureVersion, // Reference only
      outcome: session.outcome,
    }, session.startTime);
    this.graphStore.upsertNode(sessionNode);

    // --- Workspace node + edges ---
    const workspaceNode = this.makeNode('workspace', workspace.id, {}, session.startTime);
    this.graphStore.upsertNode(workspaceNode);
    this.addEdge(sessionNode.id, workspaceNode.id, 'session_workspace', {}, session.startTime);

    for (const lang of workspace.languages) {
      const node = this.makeNode('language', lang, { name: lang }, session.startTime);
      this.graphStore.upsertNode(node);
      this.addEdge(workspaceNode.id, node.id, 'workspace_language', {}, session.startTime);
    }
    for (const dep of workspace.dependencies) {
      const node = this.makeNode('dependency', dep, { name: dep }, session.startTime);
      this.graphStore.upsertNode(node);
      this.addEdge(workspaceNode.id, node.id, 'workspace_dependency', {}, session.startTime);
    }

    // --- Prompt nodes ---
    for (const p of prompts) {
      const promptNode = this.makeNode('prompt', p.id, {
        tokenCount: p.tokenCount,
        retrievedFiles: p.retrievedFiles,
        contextToken: p.contextToken,
        historyToken: p.historyToken,
      }, p.timestamp);
      this.graphStore.upsertNode(promptNode);
      this.addEdge(sessionNode.id, promptNode.id, 'session_prompt', {}, p.timestamp);
    }

    // --- Completion nodes ---
    const completionById = new Map<string, GraphNode>();
    for (const c of completions) {
      const node = this.makeNode('completion', c.id, { tokenCount: c.tokenCount, model: c.model }, c.timestamp);
      this.graphStore.upsertNode(node);
      this.addEdge(sessionNode.id, node.id, 'session_completion', {}, c.timestamp);
      completionById.set(c.id, node);
    }

    // --- Outcome nodes (accept/reject/retry) from EntityBundle.outcomes ---
    for (const o of outcomes) {
      const outcomeId = `${o.kind}:${sessionId}:${o.eventRef ?? o.timestamp}`;
      const outcomeNode = this.makeNode(o.kind, outcomeId, {}, o.timestamp);
      this.graphStore.upsertNode(outcomeNode);
      if (o.completionId) {
        const completionNode = completionById.get(o.completionId);
        if (completionNode) {
          this.addEdge(completionNode.id, outcomeNode.id, 'completion_outcome', { kind: o.kind }, o.timestamp);
        }
      }
    }

    // --- File nodes from EntityBundle.files ---
    for (const f of files) {
      const fileNode = this.makeNode('file', f.path, { path: f.path }, f.timestamp);
      this.graphStore.upsertNode(fileNode);
      this.addEdge(sessionNode.id, fileNode.id, 'session_file', {}, f.timestamp);
    }

    // --- prompt_file edges from EntityBundle.promptFileLinks ---
    for (const link of promptFileLinks) {
      const promptNodeId = `prompt:${link.promptId}`;
      for (const filePath of link.files) {
        const fileNodeId = `file:${filePath}`;
        this.addEdge(promptNodeId, fileNodeId, 'prompt_file', {}, link.timestamp);
      }
    }

    // --- Tool nodes from EntityBundle.toolInvocations ---
    for (const t of toolInvocations) {
      const toolNode = this.makeNode('tool', t.id, { name: t.toolName, kind: t.toolKind, sessionId }, t.timestamp);
      this.graphStore.upsertNode(toolNode);
      this.addEdge(sessionNode.id, toolNode.id, 'session_tool', {}, t.timestamp);
    }

    // --- Commit nodes from EntityBundle.commits ---
    for (const c of commits) {
      const commitId = `commit:${sessionId}:${c.eventRef ?? c.timestamp}`;
      const commitNode = this.makeNode('commit', commitId, {
        branch: c.branch,
        author: c.author,
      }, c.timestamp);
      this.graphStore.upsertNode(commitNode);
      this.addEdge(sessionNode.id, commitNode.id, 'session_commit', {}, c.timestamp);
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
}
