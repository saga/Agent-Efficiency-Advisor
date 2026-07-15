// GraphStore — SQLite-backed storage for the Session Graph.
// Nodes are upserted by synthetic id `${type}:${entityId}`; edges are append-only.
// Properties are stored as JSON blobs.

import type Database from 'better-sqlite3';
import type { GraphEdge, GraphNode, GraphNodeType, GraphEdgeType, GraphStats } from './types.js';

export class GraphStore {
  constructor(private db: Database.Database) {}

  /** Remove all nodes and edges. Used before rebuild. */
  clear(): void {
    this.db.exec(`
      DELETE FROM graph_edges;
      DELETE FROM graph_nodes;
    `);
  }

  upsertNode(node: GraphNode): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO graph_nodes (id, type, entity_id, properties, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(node.id, node.type, node.entityId, JSON.stringify(node.properties ?? {}), node.createdAt);
  }

  upsertNodeBatch(nodes: GraphNode[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO graph_nodes (id, type, entity_id, properties, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((items: GraphNode[]) => {
      for (const n of items) {
        stmt.run(n.id, n.type, n.entityId, JSON.stringify(n.properties ?? {}), n.createdAt);
      }
    });
    tx(nodes);
  }

  insertEdge(edge: GraphEdge): number {
    const result = this.db.prepare(`
      INSERT INTO graph_edges (source_id, target_id, type, properties, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(edge.sourceId, edge.targetId, edge.type, JSON.stringify(edge.properties ?? {}), edge.timestamp);
    return Number(result.lastInsertRowid);
  }

  insertEdgeBatch(edges: GraphEdge[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO graph_edges (source_id, target_id, type, properties, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((items: GraphEdge[]) => {
      for (const e of items) {
        stmt.run(e.sourceId, e.targetId, e.type, JSON.stringify(e.properties ?? {}), e.timestamp);
      }
    });
    tx(edges);
  }

  getNode(id: string): GraphNode | undefined {
    const row = this.db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(id) as GraphNodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  getNodesByType(type: GraphNodeType): GraphNode[] {
    const rows = this.db.prepare('SELECT * FROM graph_nodes WHERE type = ?').all(type) as GraphNodeRow[];
    return rows.map(rowToNode);
  }

  getEdgesByType(type: GraphEdgeType): GraphEdge[] {
    const rows = this.db.prepare('SELECT * FROM graph_edges WHERE type = ?').all(type) as GraphEdgeRow[];
    return rows.map(rowToEdge);
  }

  getEdgesFrom(sourceId: string): GraphEdge[] {
    const rows = this.db.prepare('SELECT * FROM graph_edges WHERE source_id = ?').all(sourceId) as GraphEdgeRow[];
    return rows.map(rowToEdge);
  }

  getEdgesTo(targetId: string): GraphEdge[] {
    const rows = this.db.prepare('SELECT * FROM graph_edges WHERE target_id = ?').all(targetId) as GraphEdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * One-hop neighbors: nodes reachable from `sourceId` via edges of (optional) type.
   * Returns the target nodes.
   */
  getNeighbors(sourceId: string, edgeType?: GraphEdgeType): GraphNode[] {
    const sql = edgeType
      ? 'SELECT n.* FROM graph_nodes n JOIN graph_edges e ON e.target_id = n.id WHERE e.source_id = ? AND e.type = ?'
      : 'SELECT n.* FROM graph_nodes n JOIN graph_edges e ON e.target_id = n.id WHERE e.source_id = ?';
    const rows = (edgeType ? this.db.prepare(sql).all(sourceId, edgeType) : this.db.prepare(sql).all(sourceId)) as GraphNodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Reverse neighbors: nodes that point TO `targetId` via edges of (optional) type.
   */
  getReverseNeighbors(targetId: string, edgeType?: GraphEdgeType): GraphNode[] {
    const sql = edgeType
      ? 'SELECT n.* FROM graph_nodes n JOIN graph_edges e ON e.source_id = n.id WHERE e.target_id = ? AND e.type = ?'
      : 'SELECT n.* FROM graph_nodes n JOIN graph_edges e ON e.source_id = n.id WHERE e.target_id = ?';
    const rows = (edgeType ? this.db.prepare(sql).all(targetId, edgeType) : this.db.prepare(sql).all(targetId)) as GraphNodeRow[];
    return rows.map(rowToNode);
  }

  count(): { nodes: number; edges: number } {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM graph_nodes').get() as { n: number };
    const e = this.db.prepare('SELECT COUNT(*) AS n FROM graph_edges').get() as { n: number };
    return { nodes: n.n, edges: e.n };
  }

  stats(): GraphStats {
    const nodeRows = this.db.prepare('SELECT type, COUNT(*) AS n FROM graph_nodes GROUP BY type').all() as { type: string; n: number }[];
    const edgeRows = this.db.prepare('SELECT type, COUNT(*) AS n FROM graph_edges GROUP BY type').all() as { type: string; n: number }[];
    const nodesByType: Record<string, number> = {};
    let nodes = 0;
    for (const r of nodeRows) { nodesByType[r.type] = r.n; nodes += r.n; }
    const edgesByType: Record<string, number> = {};
    let edges = 0;
    for (const r of edgeRows) { edgesByType[r.type] = r.n; edges += r.n; }
    return { nodes, edges, nodesByType, edgesByType };
  }
}

interface GraphNodeRow {
  id: string;
  type: string;
  entity_id: string;
  properties: string;
  created_at: number;
}

interface GraphEdgeRow {
  id: number;
  source_id: string;
  target_id: string;
  type: string;
  properties: string;
  timestamp: number;
}

function rowToNode(row: GraphNodeRow): GraphNode {
  return {
    id: row.id,
    type: row.type as GraphNodeType,
    entityId: row.entity_id,
    properties: JSON.parse(row.properties ?? '{}'),
    createdAt: row.created_at,
  };
}

function rowToEdge(row: GraphEdgeRow): GraphEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type as GraphEdgeType,
    properties: JSON.parse(row.properties ?? '{}'),
    timestamp: row.timestamp,
  };
}
