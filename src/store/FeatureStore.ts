// FeatureStore — versioned read/write of feature rows per domain.
// Never overwrites: each (entity_id, version) is immutable.
//
// v7.md #4: 保留 JSON Blob（features TEXT），同时增加 Materialized View
//           （session_feature_view 真实列），让 DuckDB/SQLite/SQL/CatBoost 直接查询。
// v7.md #5: Label 相关逻辑已移至 LabelStore，FeatureStore 不再负责 writeLabel。

import type Database from 'better-sqlite3';
import type { FeatureDomain, FeatureRow } from './types.js';

// v7.md #4: session_feature_view 的真实列（从 behavior + session 特征中选取高频分析字段）。
// 这些列会被 FeatureStore.writeSessionView() 同步更新，无需 JSON_EXTRACT 即可查询。
export const SESSION_VIEW_COLUMNS = [
  'accept_rate',
  'retry_rate',
  'completion_count',
  'retry_count',
  'accept_count',
  'reject_count',
  'duration',
  'workflow_entropy',
  'retry_burst_score',
  'tool_switch_frequency',
  'context_expansion_speed',
  'workflow_length',
  'avg_read_before_ask',
  'edit_after_accept_ratio',
] as const;

export class FeatureStore {
  constructor(private db: Database.Database) {}

  write(domain: FeatureDomain, entityId: string, version: number, features: Record<string, number>): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO feature_${domain} (entity_id, version, computed_at, features)
      VALUES (?, ?, ?, ?)
    `).run(entityId, version, Date.now(), JSON.stringify(features));

    // v7.md #4: 同步更新 session_feature_view 物化视图
    if (domain === 'session' || domain === 'behavior') {
      this.updateSessionView(entityId);
    }
  }

  writeBatch(domain: FeatureDomain, rows: FeatureRow[]): void {
    const tx = this.db.transaction((items: FeatureRow[]) => {
      for (const r of items) {
        this.write(domain, r.entityId, r.version, r.features);
      }
    });
    tx(rows);
  }

  read(domain: FeatureDomain, entityId: string, version?: number): FeatureRow | undefined {
    const sql = version !== undefined
      ? `SELECT * FROM feature_${domain} WHERE entity_id = ? AND version = ?`
      : `SELECT * FROM feature_${domain} WHERE entity_id = ? ORDER BY version DESC LIMIT 1`;
    const params = version !== undefined ? [entityId, version] : [entityId];
    const row = this.db.prepare(sql).get(...params) as any;
    if (!row) return undefined;
    return {
      entityId: row.entity_id,
      version: row.version,
      computedAt: row.computed_at,
      features: JSON.parse(row.features),
    };
  }

  readAll(domain: FeatureDomain, version?: number): FeatureRow[] {
    const sql = version !== undefined
      ? `SELECT * FROM feature_${domain} WHERE version = ?`
      : `SELECT * FROM feature_${domain}`;
    const rows = (version !== undefined ? this.db.prepare(sql).all(version) : this.db.prepare(sql).all()) as any[];
    return rows.map((r) => ({
      entityId: r.entity_id,
      version: r.version,
      computedAt: r.computed_at,
      features: JSON.parse(r.features),
    }));
  }

  latestVersion(domain: FeatureDomain): number {
    const row = this.db.prepare(`SELECT MAX(version) AS v FROM feature_${domain}`).get() as { v: number | null };
    return row.v ?? 0;
  }

  /**
   * v7.md #4: 查询 session_feature_view 物化视图（真实列，无需 JSON_EXTRACT）。
   * 返回所有 session 的关键分析字段，可直接用于 SQL/DuckDB/CatBoost。
   */
  readSessionView(): Record<string, number | string>[] {
    const cols = SESSION_VIEW_COLUMNS.join(', ');
    return this.db.prepare(`SELECT session_id, ${cols} FROM session_feature_view ORDER BY session_id`).all() as any[];
  }

  /**
   * v7.md #4: 同步更新 session_feature_view。
   * 合并 session + behavior 特征到真实列。
   */
  private updateSessionView(entityId: string): void {
    const session = this.read('session', entityId);
    const behavior = this.read('behavior', entityId);
    if (!session) return;

    const sf = session.features;
    const bf = behavior?.features ?? {};

    // INSERT OR REPLACE with real columns
    const placeholders = SESSION_VIEW_COLUMNS.map(() => '?').join(', ');
    const values = SESSION_VIEW_COLUMNS.map((col) => {
      // Map snake_case back to camelCase feature name
      const featureName = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      return Number(sf[featureName] ?? bf[featureName] ?? 0);
    });

    this.db.prepare(`
      INSERT OR REPLACE INTO session_feature_view (session_id, ${SESSION_VIEW_COLUMNS.join(', ')})
      VALUES (?, ${placeholders})
    `).run(entityId, ...values);
  }
}
