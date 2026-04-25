import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { getWorkflowDbPath } from "../core/paths";

export function openWorkflowDatabase(dbPath = getWorkflowDbPath()): Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureWorkflowSchema(db);
  return db;
}

export function closeWorkflowDatabase(db: Database): void {
  db.close();
}

function ensureWorkflowSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id                TEXT PRIMARY KEY,
      workflow_ref      TEXT NOT NULL,
      workflow_entry_id INTEGER,
      workflow_title    TEXT NOT NULL,
      status            TEXT NOT NULL CHECK (status IN ('active', 'completed', 'blocked', 'failed')),
      params_json       TEXT NOT NULL DEFAULT '{}',
      current_step_id   TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      completed_at      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_ref ON workflow_runs(workflow_ref);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

    CREATE TABLE IF NOT EXISTS workflow_run_steps (
      run_id          TEXT NOT NULL,
      step_id         TEXT NOT NULL,
      step_title      TEXT NOT NULL,
      instructions    TEXT NOT NULL,
      completion_json TEXT,
      sequence_index  INTEGER NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'blocked', 'failed', 'skipped')),
      notes           TEXT,
      evidence_json   TEXT,
      completed_at    TEXT,
      PRIMARY KEY (run_id, step_id),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run_sequence
      ON workflow_run_steps(run_id, sequence_index);
  `);
}
