/**
 * Loader for `<stash>/.akm/runs/<run-id>/improve-result.json` (the run
 * envelope written by `akm improve`).
 *
 * The toolkit treats `schemaVersion: 1` as the stable contract and
 * refuses to operate on unknown versions, matching the §1.3 grounding
 * note in the implementation plan.
 *
 * Phase 6: `loadImproveResult` accepts an optional `recorder` (captures the
 * raw file content for later replay) or `player` (returns previously-
 * captured content without touching disk). Callers that don't need replay
 * pass nothing and get the live filesystem behaviour.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveImproveRunsRoot } from "./paths";
import { type ReplayPlayer, type ReplayRecorder } from "./replay-log";

export interface ImproveResultEnvelope {
  schemaVersion: number;
  ok?: boolean;
  scope?: { mode: string; value?: string };
  dryRun?: boolean;
  memorySummary?: { eligible?: number; derived?: number };
  memoryCleanup?: {
    deletedDerived?: number;
    archivedSuperseded?: number;
    archivedStale?: number;
    beliefStateTransitions?: Array<{ ref: string; fromState: string; toState: string }>;
    warnings?: string[];
  };
  plannedRefs?: Array<{ ref: string; type?: string }>;
  actions?: Array<{ ref?: string; mode?: string; outcome?: string; proposalId?: string }>;
  validationFailures?: Array<{ ref: string; reason: string }>;
  schemaRepairs?: Array<{ ref: string; outcome: string }>;
  consolidation?: Record<string, unknown>;
  lintSummary?: { fixed?: number; flagged?: number };
  memoryIndexHealth?: { lineCount?: number; overBudget?: boolean };
  evalCasesWritten?: number;
  memoryInference?: Record<string, unknown>;
  graphExtraction?: Record<string, unknown>;
  stalenessDetection?: Record<string, unknown>;
  orphansPurged?: number;
  proposalsExpired?: number;
  reflectCooldownActions?: number;
  reflectsWithErrorContext?: number;
  // Allow extra unknown keys without losing them.
  [key: string]: unknown;
}

export function resolveImproveRunDir(stashRoot: string, ref: string): { runId: string; dir: string } {
  const runsRoot = resolveImproveRunsRoot(stashRoot);
  if (!fs.existsSync(runsRoot)) {
    throw new Error(`improve runs root not found: ${runsRoot}`);
  }
  if (ref === "latest" || ref === "last") {
    const entries = fs
      .readdirSync(runsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (entries.length === 0) throw new Error(`no improve runs under ${runsRoot}`);
    const id = entries[entries.length - 1];
    return { runId: id, dir: path.join(runsRoot, id) };
  }
  const dir = path.join(runsRoot, ref);
  if (!fs.existsSync(dir)) throw new Error(`improve run not found: ${dir}`);
  return { runId: ref, dir };
}

export interface LoadImproveResultOptions {
  /** When set, the file content is recorded for later replay. */
  recorder?: ReplayRecorder;
  /**
   * When set, the file content is dequeued from the player instead of read
   * from disk. The path is still resolved (so the resolver's "latest"
   * semantics match) but `fs.readFileSync` is skipped.
   */
  player?: ReplayPlayer;
}

export function loadImproveResult(
  stashRoot: string,
  ref: string,
  opts: LoadImproveResultOptions = {},
): {
  runId: string;
  dir: string;
  envelope: ImproveResultEnvelope;
} {
  if (opts.recorder && opts.player) {
    throw new Error("loadImproveResult: cannot record and play back simultaneously");
  }
  const loc = resolveImproveRunDir(stashRoot, ref);
  const file = path.join(loc.dir, "improve-result.json");
  let raw: string;
  if (opts.player) {
    raw = opts.player.nextImproveResult(file);
  } else {
    if (!fs.existsSync(file)) {
      throw new Error(`improve-result.json missing at ${file}`);
    }
    raw = fs.readFileSync(file, "utf8");
    opts.recorder?.recordImproveResult(file, raw);
  }
  const envelope = JSON.parse(raw) as ImproveResultEnvelope;
  if (envelope.schemaVersion !== 1) {
    throw new Error(`unsupported improve-result schemaVersion: ${envelope.schemaVersion}`);
  }
  return { runId: loc.runId, dir: loc.dir, envelope };
}
