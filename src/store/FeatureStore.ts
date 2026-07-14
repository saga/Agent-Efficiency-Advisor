// FeatureStore — versioned read/write of feature rows per domain.
// Never overwrites: each (entity_id, version) is immutable.

import type Database from 'better-sqlite3';
import type { FeatureDomain, FeatureRow } from './types.js';

export class FeatureStore {
  constructor(private db: Database.Database) {}

  write(domain: FeatureDomain, entityId: string, version: number, features: Record<string, number>): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO feature_${domain} (entity_id, version, computed_at, features)
      VALUES (?, ?, ?, ?)
    `).run(entityId, version, Date.now(), JSON.stringify(features));
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

  // Materialize a training matrix: join features with labels.
  getTrainingMatrix(domain: FeatureDomain, version: number, labelSource: string): { features: Record<string, number>; label: string; entityId: string }[] {
    const features = this.readAll(domain, version);
    const labelRows = this.db.prepare('SELECT entity_id, label FROM labels WHERE domain = ? AND source = ?').all(domain, labelSource) as { entity_id: string; label: string }[];
    const labelMap = new Map(labelRows.map((l) => [l.entity_id, l.label]));
    return features
      .filter((f) => labelMap.has(f.entityId))
      .map((f) => ({ features: f.features, label: labelMap.get(f.entityId)!, entityId: f.entityId }));
  }

  writeLabel(entityId: string, domain: FeatureDomain, label: string, source: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO labels (entity_id, domain, label, source, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entityId, domain, label, source, Date.now());
  }

  latestVersion(domain: FeatureDomain): number {
    const row = this.db.prepare(`SELECT MAX(version) AS v FROM feature_${domain}`).get() as { v: number | null };
    return row.v ?? 0;
  }
}
