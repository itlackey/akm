/**
 * Helpers for persisting the `akm improve` result envelope to disk.
 *
 * v0.8.0 behavioural default change:
 *   - Default: full result JSON is written to
 *     `<stash>/.akm/runs/<run-id>/improve-result.json`; stdout is empty.
 *     The existing `[improve] ...` progress log lines on stderr remain the
 *     canonical console UX.
 *   - `--json-to-stdout` restores the prior behaviour: full JSON to stdout,
 *     no file written.
 *
 * Run-id format: ISO-8601 timestamp (colons/dots replaced by `-`) plus an
 * 8-char hex random suffix. There is no existing canonical run-id helper for
 * persistent per-command artefacts on disk — the `workflow_runs` table uses
 * `randomUUID()` but is database-scoped, and `consolidate-journal.json` is a
 * single-slot artefact. We mint a fresh timestamped id for each improve run.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../core/common";
import type { AkmImproveResult } from "./improve";

/**
 * Build a stable run-id for a single improve invocation.
 *
 * Shape: `<iso-8601-utc-with-dashes>-<8 hex chars>`, e.g.
 *   `2026-05-19T17-30-22-123Z-a1b2c3d4`.
 *
 * The hex suffix protects against same-millisecond collisions when multiple
 * runs happen back-to-back in tests or scripts.
 */
export function buildImproveRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${iso}-${rand}`;
}

/**
 * Return the on-disk path for a given improve run, stash-relative.
 * Caller is responsible for joining with the stash root.
 */
export function relativeImproveResultPath(runId: string): string {
  return path.join(".akm", "runs", runId, "improve-result.json");
}

/**
 * Persist the full improve result JSON under `<stashDir>/.akm/runs/<runId>/`.
 * Creates the run directory recursively. Uses {@link writeFileAtomic} to
 * avoid partial-write corruption on crash.
 */
export function writeImproveResultFile(stashDir: string, runId: string, result: AkmImproveResult): string {
  const relPath = relativeImproveResultPath(runId);
  const absPath = path.join(stashDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileAtomic(absPath, `${JSON.stringify(result, null, 2)}\n`, 0o644);
  return relPath;
}
