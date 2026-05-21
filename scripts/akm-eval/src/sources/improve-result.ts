/**
 * Loader for `<stash>/.akm/runs/<run-id>/improve-result.json` (the run
 * envelope written by `akm improve`).
 *
 * The toolkit treats `schemaVersion: 1` as the stable contract and
 * refuses to operate on unknown versions, matching the §1.3 grounding
 * note in the implementation plan.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveImproveRunsRoot } from "./paths";

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

export function loadImproveResult(stashRoot: string, ref: string): {
  runId: string;
  dir: string;
  envelope: ImproveResultEnvelope;
} {
  const loc = resolveImproveRunDir(stashRoot, ref);
  const file = path.join(loc.dir, "improve-result.json");
  if (!fs.existsSync(file)) {
    throw new Error(`improve-result.json missing at ${file}`);
  }
  const raw = fs.readFileSync(file, "utf8");
  const envelope = JSON.parse(raw) as ImproveResultEnvelope;
  if (envelope.schemaVersion !== 1) {
    throw new Error(`unsupported improve-result schemaVersion: ${envelope.schemaVersion}`);
  }
  return { runId: loc.runId, dir: loc.dir, envelope };
}
