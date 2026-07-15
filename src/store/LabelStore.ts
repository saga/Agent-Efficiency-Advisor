// LabelStore — v7.md #5: Label 独立于 FeatureStore。
// Label 的生命周期与 Feature 完全不同：
//   - 今天 Label 更新，Feature 可能没有更新。
//   - Label 来源多样（shadow / outcome / manual）。
//   - Feature 是不可变的版本化数据，Label 是可变的结果信号。
//
// FeatureStore 不再负责 writeLabel，Label 独立存储、独立查询。

import type Database from 'better-sqlite3';
import type { FeatureDomain } from './types.js';

export interface LabelRow {
  entityId: string;
  domain: FeatureDomain;
  label: string;
  source: string;
  createdAt: number;
}

export class LabelStore {
  constructor(private db: Database.Database) {}

  /**
   * 写入或更新一个 Label（同一 entity+domain+source 唯一）。
   */
  write(entityId: string, domain: FeatureDomain, label: string, source: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO labels (entity_id, domain, label, source, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entityId, domain, label, source, Date.now());
  }

  /**
   * 批量写入 Label。
   */
  writeBatch(rows: Omit<LabelRow, 'createdAt'>[]): void {
    const tx = this.db.transaction((items: Omit<LabelRow, 'createdAt'>[]) => {
      for (const r of items) {
        this.write(r.entityId, r.domain, r.label, r.source);
      }
    });
    tx(rows);
  }

  /**
   * 读取一个 entity 的 Label（指定 source）。
   */
  read(entityId: string, domain: FeatureDomain, source: string): LabelRow | undefined {
    const row = this.db.prepare(
      'SELECT * FROM labels WHERE entity_id = ? AND domain = ? AND source = ?'
    ).get(entityId, domain, source) as any;
    if (!row) return undefined;
    return {
      entityId: row.entity_id,
      domain: row.domain,
      label: row.label,
      source: row.source,
      createdAt: row.created_at,
    };
  }

  /**
   * 读取一个 domain 下所有 Label。
   */
  readByDomain(domain: FeatureDomain, source?: string): LabelRow[] {
    const sql = source
      ? 'SELECT * FROM labels WHERE domain = ? AND source = ?'
      : 'SELECT * FROM labels WHERE domain = ?';
    const params = source ? [domain, source] : [domain];
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      entityId: r.entity_id,
      domain: r.domain,
      label: r.label,
      source: r.source,
      createdAt: r.created_at,
    }));
  }

  /**
   * 构建 Training Matrix：join Feature + Label。
   * v7.md #5: FeatureStore 和 LabelStore 独立后，Training Matrix 由 LabelStore 负责组装。
   */
  getTrainingMatrix(
    features: { entityId: string; features: Record<string, number> }[],
    domain: FeatureDomain,
    source: string
  ): { features: Record<string, number>; label: string; entityId: string }[] {
    const labelRows = this.readByDomain(domain, source);
    const labelMap = new Map(labelRows.map((l) => [l.entityId, l.label]));
    return features
      .filter((f) => labelMap.has(f.entityId))
      .map((f) => ({ features: f.features, label: labelMap.get(f.entityId)!, entityId: f.entityId }));
  }
}
