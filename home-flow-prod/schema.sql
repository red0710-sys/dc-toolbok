PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS families (
  family_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  current_version TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  family_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  device_id TEXT,
  chunk_count INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  backup_day TEXT,
  PRIMARY KEY (family_id, version_id),
  FOREIGN KEY (family_id) REFERENCES families(family_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS snapshot_chunks (
  family_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (family_id, version_id, chunk_index),
  FOREIGN KEY (family_id, version_id) REFERENCES snapshots(family_id, version_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshots_backup
  ON snapshots(family_id, backup_day DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_created
  ON snapshots(family_id, created_at DESC);
