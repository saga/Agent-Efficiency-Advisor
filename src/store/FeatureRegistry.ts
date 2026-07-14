// FeatureRegistry — central catalog of feature definitions.
// Dashboard / CatBoost / GPT all query this to know what features exist.

import type Database from 'better-sqlite3';
import type { FeatureDefinition, FeatureDomain } from './types.js';

export class FeatureRegistry {
  constructor(private db: Database.Database) {}

  register(def: FeatureDefinition): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO feature_registry (name, domain, description, version, owner)
      VALUES (?, ?, ?, ?, ?)
    `).run(def.name, def.domain, def.description, def.version, def.owner);
  }

  registerBatch(defs: FeatureDefinition[]): void {
    const tx = this.db.transaction((items: FeatureDefinition[]) => {
      for (const d of items) this.register(d);
    });
    tx(defs);
  }

  getAll(): FeatureDefinition[] {
    const rows = this.db.prepare('SELECT * FROM feature_registry ORDER BY domain, name').all() as any[];
    return rows.map((r) => ({
      name: r.name,
      domain: r.domain as FeatureDomain,
      description: r.description,
      version: r.version,
      owner: r.owner,
    }));
  }

  getByDomain(domain: FeatureDomain): FeatureDefinition[] {
    const rows = this.db.prepare('SELECT * FROM feature_registry WHERE domain = ? ORDER BY name').all(domain) as any[];
    return rows.map((r) => ({
      name: r.name,
      domain: r.domain as FeatureDomain,
      description: r.description,
      version: r.version,
      owner: r.owner,
    }));
  }
}
