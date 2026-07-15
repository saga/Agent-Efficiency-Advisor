// SQLite schema + migrations. One connection per process.

import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 3;

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  // Schema version tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version') as { value?: string } | undefined;
  const current = Number(row?.value ?? 0);
  if (current >= SCHEMA_VERSION) return;

  // --- Event Store ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   INTEGER NOT NULL,
      session_id  TEXT    NOT NULL,
      workspace_id TEXT   NOT NULL,
      event_type  TEXT    NOT NULL,
      metadata    TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_time ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_workspace ON events(workspace_id);
  `);

  // --- Feature Store: one table per domain ---
  // Each row: (entity_id, version, computed_at, features JSON)
  for (const domain of ['workspace', 'session', 'prompt', 'tool', 'behavior']) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feature_${domain} (
        entity_id    TEXT    NOT NULL,
        version      INTEGER NOT NULL,
        computed_at  INTEGER NOT NULL,
        features     TEXT    NOT NULL,
        PRIMARY KEY (entity_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_feature_${domain}_version ON feature_${domain}(version);
    `);
  }

  // --- Feature Registry ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_registry (
      name        TEXT PRIMARY KEY,
      domain      TEXT NOT NULL,
      description TEXT NOT NULL,
      version     INTEGER NOT NULL,
      owner       TEXT NOT NULL
    );
  `);

  // --- Labels (for ML training, joined with features) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS labels (
      entity_id   TEXT NOT NULL,
      domain      TEXT NOT NULL,
      label       TEXT NOT NULL,
      source      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (entity_id, domain, source)
    );
  `);

  // --- Embedding Store (v6.md Section 4) ---
  // Stores vector embeddings for sessions, prompts, workflows, errors.
  // Vector is a JSON array of floats. Cosine similarity computed in TS.
  if (current < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        entity_id   TEXT    NOT NULL,
        entity_type TEXT    NOT NULL,
        model       TEXT    NOT NULL,
        dim         INTEGER NOT NULL,
        vector      TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (entity_id, entity_type, model)
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(entity_type);
    `);
  }

  // --- Session Graph (v6.md Section 12: Temporal Property Graph) ---
  // Nodes: session / prompt / workspace / commit / completion / accept|reject|retry /
  //        file / language / dependency / tool
  // Edges: typed relationships with timestamp + properties JSON
  if (current < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id          TEXT    NOT NULL PRIMARY KEY,
        type        TEXT    NOT NULL,
        entity_id   TEXT    NOT NULL,
        properties  TEXT    NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_type   ON graph_nodes(type);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_entity ON graph_nodes(entity_id);

      CREATE TABLE IF NOT EXISTS graph_edges (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id   TEXT    NOT NULL,
        target_id   TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        properties  TEXT    NOT NULL DEFAULT '{}',
        timestamp   INTEGER NOT NULL,
        FOREIGN KEY (source_id) REFERENCES graph_nodes(id),
        FOREIGN KEY (target_id) REFERENCES graph_nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_type   ON graph_edges(type);
    `);
  }

  db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)').run('version', String(SCHEMA_VERSION));
}
