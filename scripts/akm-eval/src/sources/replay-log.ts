/**
 * Phase 6 replay-log support.
 *
 * Shared types + recorder/player classes used by the AkmCli, StateDbSources,
 * and improve-result loader to capture every external I/O so a future
 * `akm-eval-replay` invocation can re-run the same eval deterministically.
 *
 * Three independent logs land under `<run-dir>/artifacts/replay/`:
 *
 *   - `akm-invocations.jsonl`   — one record per AkmCli.run() call.
 *   - `state-db-queries.jsonl`  — one record per readEvents/readProposals call.
 *   - `improve-results.jsonl`   — one record per improve-result.json read.
 *
 * The recorder is a singleton-per-eval-run: the orchestrator constructs one,
 * stores it on `EvalContext.recorder`, hands it to every source factory it
 * touches, and flushes once at the end. The player is symmetric and is
 * constructed by `src/replay.ts` from the captured JSONL files.
 *
 * Determinism contract: the recorder writes records in invocation order
 * (monotonic `id` per kind, starting at 1). The player dequeues in the same
 * order. If the args don't match on replay, the player throws a divergence
 * error so the case fails loudly rather than silently mis-aligning.
 */

import fs from "node:fs";
import path from "node:path";

export interface AkmInvocationRecord {
  id: number;
  kind: "akm";
  args: string[];
  stdout: string;
  stderr: string;
  status: number | null;
  durationMs: number;
}

export interface StateDbEventsRecord {
  id: number;
  kind: "state-db-events";
  opts: Record<string, unknown>;
  result: unknown[];
}

export interface StateDbProposalsRecord {
  id: number;
  kind: "state-db-proposals";
  opts: Record<string, unknown>;
  result: unknown[];
}

/**
 * Captured `available()` answer. Recorded on first call per recorder so the
 * playback runner takes the same code branch (state-db vs stash-fs fallback)
 * as the original run. Without this the player would default to `true` and
 * the runner would then ask for a query that was never recorded.
 */
export interface StateDbAvailableRecord {
  id: number;
  kind: "state-db-available";
  result: boolean;
}

export type StateDbRecord = StateDbEventsRecord | StateDbProposalsRecord | StateDbAvailableRecord;

export interface ImproveResultRecord {
  id: number;
  kind: "improve-result";
  path: string;
  content: string;
}

export interface ReplayMatchOptions {
  /**
   * "exact"   — args must deep-equal.
   * "verb"    — only args[0] must match; the rest is ignored. Useful when a
   *             replay run re-derives transient flags (e.g. timestamps).
   */
  mode: "exact" | "verb";
}

const DEFAULT_MATCH: ReplayMatchOptions = { mode: "exact" };

/**
 * In-memory append-only recorder. Three logs are kept separate so the player
 * can advance each independently (the runners interleave AkmCli + StateDb
 * calls, but each log only needs FIFO ordering within its own kind).
 */
export class ReplayRecorder {
  private akm: AkmInvocationRecord[] = [];
  private stateDb: StateDbRecord[] = [];
  private improve: ImproveResultRecord[] = [];

  recordAkm(args: string[], stdout: string, stderr: string, status: number | null, durationMs: number): void {
    this.akm.push({
      id: this.akm.length + 1,
      kind: "akm",
      args: [...args],
      stdout,
      stderr,
      status,
      durationMs,
    });
  }

  recordStateDbEvents(opts: Record<string, unknown>, result: unknown[]): void {
    this.stateDb.push({
      id: this.stateDb.length + 1,
      kind: "state-db-events",
      opts: deepClone(opts),
      result: deepClone(result) as unknown[],
    });
  }

  recordStateDbProposals(opts: Record<string, unknown>, result: unknown[]): void {
    this.stateDb.push({
      id: this.stateDb.length + 1,
      kind: "state-db-proposals",
      opts: deepClone(opts),
      result: deepClone(result) as unknown[],
    });
  }

  recordStateDbAvailable(result: boolean): void {
    this.stateDb.push({
      id: this.stateDb.length + 1,
      kind: "state-db-available",
      result,
    });
  }

  recordImproveResult(filePath: string, content: string): void {
    this.improve.push({
      id: this.improve.length + 1,
      kind: "improve-result",
      path: filePath,
      content,
    });
  }

  /** Counts useful for diagnostics + tests. */
  counts(): { akm: number; stateDb: number; improve: number } {
    return { akm: this.akm.length, stateDb: this.stateDb.length, improve: this.improve.length };
  }

  /** Write all three logs as JSONL under `<dir>/`. Creates `dir` if needed. */
  flushTo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    writeJsonl(path.join(dir, "akm-invocations.jsonl"), this.akm);
    writeJsonl(path.join(dir, "state-db-queries.jsonl"), this.stateDb);
    writeJsonl(path.join(dir, "improve-results.jsonl"), this.improve);
  }
}

/**
 * Symmetric playback: dequeue-by-kind. The orchestrator constructs one from
 * disk and hands it to every source factory. Every captured I/O surface
 * (akm, state-db, improve-result) has its own queue advanced independently.
 *
 * On args-mismatch the player throws a `ReplayDivergenceError` with the
 * `caseId`-agnostic context (which kind, which index, what was expected,
 * what was actually requested). The orchestrator catches these into the
 * `replay-result.json` divergence list.
 */
export class ReplayPlayer {
  private akmIdx = 0;
  private stateDbIdx = 0;
  private improveIdx = 0;
  readonly match: ReplayMatchOptions;

  constructor(
    private readonly akm: AkmInvocationRecord[],
    private readonly stateDb: StateDbRecord[],
    private readonly improve: ImproveResultRecord[],
    match: ReplayMatchOptions = DEFAULT_MATCH,
  ) {
    this.match = match;
  }

  static fromDir(dir: string, match: ReplayMatchOptions = DEFAULT_MATCH): ReplayPlayer {
    const akm = readJsonl<AkmInvocationRecord>(path.join(dir, "akm-invocations.jsonl"));
    const stateDb = readJsonl<StateDbRecord>(path.join(dir, "state-db-queries.jsonl"));
    const improve = readJsonl<ImproveResultRecord>(path.join(dir, "improve-results.jsonl"));
    return new ReplayPlayer(akm, stateDb, improve, match);
  }

  nextAkm(args: string[]): AkmInvocationRecord {
    if (this.akmIdx >= this.akm.length) {
      throw new ReplayDivergenceError(
        `Replay divergence at akm-invocation #${this.akmIdx + 1}: queue exhausted (got ${JSON.stringify(args)})`,
      );
    }
    const rec = this.akm[this.akmIdx];
    if (!this.argsMatch(rec.args, args)) {
      throw new ReplayDivergenceError(
        `Replay divergence at akm-invocation #${rec.id}: expected ${JSON.stringify(rec.args)}, got ${JSON.stringify(args)}`,
      );
    }
    this.akmIdx += 1;
    return rec;
  }

  nextStateDbEvents(opts: Record<string, unknown>): unknown[] {
    return this.nextStateDb("state-db-events", opts) as unknown[];
  }

  nextStateDbProposals(opts: Record<string, unknown>): unknown[] {
    return this.nextStateDb("state-db-proposals", opts) as unknown[];
  }

  nextStateDbAvailable(): boolean {
    // Find the next available record (skipping any interleaved query records)
    // — `available()` is called once at the top of every state-db runner and
    // the recording captures it on first call, so it's normally the first
    // entry in the queue. Tolerate ordering by scanning forward.
    for (let i = this.stateDbIdx; i < this.stateDb.length; i++) {
      const rec = this.stateDb[i];
      if (rec.kind === "state-db-available") {
        // Advance past this record without disturbing the events/proposals
        // pointer — we splice it out so subsequent calls don't trip over it.
        const splicedOut = this.stateDb.splice(i, 1)[0] as StateDbAvailableRecord;
        return splicedOut.result;
      }
    }
    // No availability ever recorded → default to true so behaviour matches
    // pre-Phase-6 runs that never asked.
    return true;
  }

  private nextStateDb(
    kind: "state-db-events" | "state-db-proposals",
    opts: Record<string, unknown>,
  ): unknown[] {
    // Skip past any available records that haven't been consumed (the
    // splice in nextStateDbAvailable usually handles this, but defensive).
    while (this.stateDbIdx < this.stateDb.length && this.stateDb[this.stateDbIdx].kind === "state-db-available") {
      this.stateDbIdx += 1;
    }
    if (this.stateDbIdx >= this.stateDb.length) {
      throw new ReplayDivergenceError(
        `Replay divergence at state-db query #${this.stateDbIdx + 1}: queue exhausted (kind=${kind}, opts=${JSON.stringify(opts)})`,
      );
    }
    const rec = this.stateDb[this.stateDbIdx];
    if (rec.kind !== kind) {
      throw new ReplayDivergenceError(
        `Replay divergence at state-db query #${rec.id}: expected kind ${rec.kind}, got ${kind}`,
      );
    }
    if (!shallowOptsMatch((rec as StateDbEventsRecord | StateDbProposalsRecord).opts, opts)) {
      throw new ReplayDivergenceError(
        `Replay divergence at state-db query #${rec.id} (${kind}): expected opts ${JSON.stringify((rec as StateDbEventsRecord | StateDbProposalsRecord).opts)}, got ${JSON.stringify(opts)}`,
      );
    }
    this.stateDbIdx += 1;
    return (rec as StateDbEventsRecord | StateDbProposalsRecord).result;
  }

  nextImproveResult(filePath: string): string {
    if (this.improveIdx >= this.improve.length) {
      throw new ReplayDivergenceError(
        `Replay divergence at improve-result #${this.improveIdx + 1}: queue exhausted (path=${filePath})`,
      );
    }
    const rec = this.improve[this.improveIdx];
    if (rec.path !== filePath) {
      throw new ReplayDivergenceError(
        `Replay divergence at improve-result #${rec.id}: expected path ${rec.path}, got ${filePath}`,
      );
    }
    this.improveIdx += 1;
    return rec.content;
  }

  /** Diagnostics: how much of each queue remains unread after the replay run. */
  remaining(): { akm: number; stateDb: number; improve: number } {
    return {
      akm: this.akm.length - this.akmIdx,
      stateDb: this.stateDb.length - this.stateDbIdx,
      improve: this.improve.length - this.improveIdx,
    };
  }

  private argsMatch(expected: string[], actual: string[]): boolean {
    if (this.match.mode === "verb") {
      return expected[0] === actual[0];
    }
    if (expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== actual[i]) return false;
    }
    return true;
  }
}

export class ReplayDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayDivergenceError";
  }
}

/**
 * Process-level holders for the active recorder / player. The orchestrator
 * (src/run.ts in record mode, src/replay.ts in replay mode) installs one
 * before running cases and clears it afterwards. Runners read these via the
 * factory helpers in `akm-cli.ts` / `state-db.ts` rather than receiving the
 * recorder reference through `EvalContext` — that keeps the `EvalContext`
 * surface to a single `recording?: boolean` flag, which is friendlier to
 * the parallel Phase 4 / Phase 7 worktrees also editing `types.ts`.
 */
let currentRecorder: ReplayRecorder | undefined;
let currentPlayer: ReplayPlayer | undefined;

export function setCurrentRecorder(rec: ReplayRecorder | undefined): void {
  currentRecorder = rec;
}

export function getCurrentRecorder(): ReplayRecorder | undefined {
  return currentRecorder;
}

export function setCurrentPlayer(p: ReplayPlayer | undefined): void {
  currentPlayer = p;
}

export function getCurrentPlayer(): ReplayPlayer | undefined {
  return currentPlayer;
}

/**
 * Deep equality used by the replay comparison step. Tolerates ordering only
 * where the underlying records are sorted by `id` (which the recorder
 * guarantees).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keysA = Object.keys(ao).sort();
    const keysB = Object.keys(bo).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false;
      if (!deepEqual(ao[keysA[i]], bo[keysB[i]])) return false;
    }
    return true;
  }
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
  }
  return false;
}

/** Numeric score comparison used in replay-determinism check. */
export function scoresClose(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function shallowOptsMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  // We need stable key order independent of how the caller built the object,
  // so reuse deepEqual after normalising both sides via JSON round-trip.
  return deepEqual(
    JSON.parse(JSON.stringify(expected ?? {})),
    JSON.parse(JSON.stringify(actual ?? {})),
  );
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function writeJsonl(file: string, rows: unknown[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(file, rows.length > 0 ? `${body}\n` : "");
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) {
    throw new Error(`replay log missing: ${file} (re-run with --record)`);
  }
  const raw = fs.readFileSync(file, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as T);
  }
  return out;
}
