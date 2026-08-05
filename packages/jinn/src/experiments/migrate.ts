import type Database from "better-sqlite3";

const EXPERIMENTS_DDL = `
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'concluded')),
  started_at TEXT NOT NULL,
  horizon_days INTEGER NOT NULL CHECK (horizon_days > 0),
  baseline_json TEXT NOT NULL,
  verdict_outcome TEXT CHECK (verdict_outcome IN ('win', 'loss', 'inconclusive')),
  verdict_note TEXT,
  concluded_at TEXT,
  check_in_cron_job_id TEXT
);

CREATE TABLE IF NOT EXISTS experiment_metrics (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  unit TEXT,
  how_to_measure TEXT NOT NULL,
  PRIMARY KEY (experiment_id, name)
);

CREATE TABLE IF NOT EXISTS experiment_readings (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  at TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  note TEXT,
  FOREIGN KEY (experiment_id, metric)
    REFERENCES experiment_metrics(experiment_id, name)
);

CREATE INDEX IF NOT EXISTS idx_experiments_status_started
  ON experiments(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_metrics_order
  ON experiment_metrics(experiment_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_experiment_readings_order
  ON experiment_readings(experiment_id, at, id);
`;

export function migrateExperimentsSchema(db: Database.Database): void {
  db.exec(EXPERIMENTS_DDL);
}
