// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import { NotFoundError, TransientError, UsageError } from "../../core/errors";
import { isSqliteContentionError, openStateDatabase, withImmediateTransaction } from "../../core/state-db";
import { borrowScopedStateDb, withStateDbScope } from "../../core/state-db-scope";
import { sleepSync } from "../../runtime";
import type { WorkflowRunStatus, WorkflowRunStepStatus } from "../../sources/types";
import type { Database } from "../database";
import { escapeLikePattern } from "../like-pattern";
import { resolveStorageLocations } from "../locations";
import { insertEventOnce, insertEventStrict } from "./events-repository";

/**
 * Row shapes for the `workflow_runs` / `workflow_run_steps` tables.
 *
 * These mirror the on-disk columns exactly and were lifted verbatim from
 * {@link ../../workflows/runs} when the raw SQL was consolidated behind this
 * repository (WS5). The repository owns ALL SQL that touches these two tables.
 */
export type WorkflowRunRow = {
  id: string;
  workflow_ref: string;
  scope_key: string | null;
  workflow_entry_id: number | null;
  workflow_title: string;
  status: WorkflowRunStatus;
  params_json: string;
  current_step_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  agent_harness: string | null;
  agent_session_id: string | null;
  checkin_armed_at: string | null;
  /** Frozen compiled plan — canonical plan JSON. NULL only on rejected pre-v4 rows. */
  plan_json: string | null;
  /** sha256 (hex) of the canonical plan JSON; integrity-checked on every load. */
  plan_hash: string | null;
  /** Persisted IR version. NULL only on rejected pre-v4 rows. */
  plan_ir_version?: number | null;
  /** Run-lease expiry (ISO-8601 UTC; migration 006, enforced since R2). NULL when no engine holds the run. */
  engine_lease_until: string | null;
  /** Random holder id of the engine invocation driving the run. NULL when unleased. */
  engine_lease_holder: string | null;
  /** The parent run this run was spawned under (migration 023). NULL on a top-level run. */
  parent_run_id: string | null;
  /**
   * The PARENT RUN's unit that spawned this CHILD run (migration 023). NULL
   * on a top-level run. NOT the same concept as
   * `workflow_run_units.parent_unit_id` (map fan-out template parentage
   * within one run) — see migration 023's comment in
   * `src/core/state/migrations.ts`. The repository's own input/accessor API
   * spells this `spawnedByUnitId`, never `parentUnitId`.
   */
  parent_unit_id: string | null;
  /** This run's deterministic spawn identity (migration 023), unique per `parent_run_id`. NULL on a top-level run. */
  invocation_key: string | null;
  /**
   * Resolved declared `outputs:` (migration 024, P3b §4.3): the run plan's
   * canonical JSON export map, persisted once at run completion in the SAME
   * transaction as the final step's completion. NULL for every run whose
   * plan declares no `outputs:` and for every run that fails or blocks
   * before completing — never `{}`. `WorkflowRunsRepository.setRunOutputs`
   * is the only writer.
   *
   * Optional (rather than required, unlike `parent_run_id` et al.) so a
   * pre-existing hand-constructed `WorkflowRunRow` literal in a test this
   * phase does not own stays type-valid without adding a key it never
   * asserted on; every real row read via `SELECT *` still carries it
   * (`null` until a completion sets it).
   */
  outputs_json?: string | null;
};

export type WorkflowRunStepRow = {
  run_id: string;
  step_id: string;
  step_title: string;
  instructions: string;
  completion_json: string | null;
  sequence_index: number;
  status: WorkflowRunStepStatus;
  notes: string | null;
  evidence_json: string | null;
  completed_at: string | null;
  summary: string | null;
};

/** Lifecycle states for the current per-unit status projection. */
export type WorkflowRunUnitStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/** Row shape of `workflow_run_units` — per-unit state under the gated step spine. */
export type WorkflowRunUnitRow = {
  run_id: string;
  unit_id: string;
  step_id: string | null;
  node_id: string;
  parent_unit_id: string | null;
  phase: string | null;
  runner: string | null;
  /** Public frozen engine identity. */
  engine?: string | null;
  model: string | null;
  status: WorkflowRunUnitStatus;
  input_hash: string | null;
  result_json: string | null;
  tokens: number | null;
  failure_reason: string | null;
  /** Harness-native session id revealed by the unit's result extractor (migration 005, plan P2). */
  session_id: string | null;
  worktree_path: string | null;
  started_at: string | null;
  finished_at: string | null;
  /**
   * Most recent unit-level check-in heartbeat (migration 007): refreshed
   * whenever a `running` unit's claim is (re)stamped. Distinct from
   * `started_at` (the first claim); the stale-unit evaluator
   * (`runtime/unit-checkin.ts`) reads it. NULL on never-heartbeated units,
   * including plain engine-dispatched rows.
   */
  last_checkin_at: string | null;
  /**
   * Number of the latest append-only dispatch attempt projected for this unit.
   * Authoritative accounting reads `workflow_run_unit_attempts` directly.
   */
  attempts: number;
  /**
   * Claim owner of a `running` unit (migration 009, PR #714 review round 2): the
   * session/holder token that took the unit. Heartbeating or finishing a
   * live-claimed running row requires this holder; an expired claim
   * ({@link claim_expires_at} in the past) is reclaimable by a new holder. NULL
   * on plain engine-dispatched rows, which are never separately claimed.
   */
  claim_holder: string | null;
  /** Claim expiry (ISO-8601 UTC; migration 009). NULL when unclaimed. A claim is
   * LIVE only while this is set and `>= now`; past that it is reclaimable. */
  claim_expires_at: string | null;
};

export type WorkflowRunUnitAttemptPhaseV4 = "unit" | "gate";
export type WorkflowRunUnitAttemptStatusV4 = "running" | "completed" | "failed" | "skipped";

export interface WorkflowRunUnitAttemptRowV4 {
  run_id: string;
  unit_id: string;
  attempt: number;
  dispatch_id: string;
  step_id: string;
  node_id: string;
  phase: WorkflowRunUnitAttemptPhaseV4;
  runner: string | null;
  engine: string | null;
  model: string | null;
  input_hash: string;
  status: WorkflowRunUnitAttemptStatusV4;
  result_json: string | null;
  tokens: number | null;
  failure_reason: string | null;
  session_id: string | null;
  worktree_path: string | null;
  started_at: string;
  finished_at: string | null;
  claim_holder: string;
  claim_expires_at: string;
}

export interface ReserveUnitAttemptV4Input {
  runId: string;
  unitId: string;
  stepId: string;
  nodeId: string;
  parentUnitId?: string | null;
  phase: WorkflowRunUnitAttemptPhaseV4;
  runner: string | null;
  engine: string | null;
  model: string | null;
  inputHash: string;
  worktreePath?: string | null;
  claimHolder: string;
  claimExpiresAt: string;
  now: string;
  /** Engine-driven reservations are fenced by the run lease; direct calls are allowed only on an unleased run. */
  leaseMode: "engine" | "direct";
}

export interface FinishUnitAttemptV4Input {
  runId: string;
  unitId: string;
  attempt: number;
  dispatchId: string;
  claimHolder: string;
  status: Exclude<WorkflowRunUnitAttemptStatusV4, "running">;
  resultJson: string | null;
  tokens: number | null;
  failureReason: string | null;
  sessionId?: string | null;
  finishedAt: string;
}

export interface WorkflowAttemptAccountingV4 {
  totalAttempts: number;
  totalTokens: number;
  dispatchAttempts: number;
  dispatchTokens: number;
  gateAttempts: number;
  gateTokens: number;
}

export interface ReserveUnitAttemptV4Result {
  kind: "reserved" | "existing" | "reclaimed" | "busy";
  attempt: WorkflowRunUnitAttemptRowV4;
}

function assertAttemptReservationLease(
  input: ReserveUnitAttemptV4Input,
  run: { engine_lease_holder: string | null; engine_lease_until: string | null },
): void {
  if (input.leaseMode === "direct") {
    if (run.engine_lease_holder === null) return;
    throw new UsageError(
      `Workflow run ${input.runId} is leased by another engine; direct durable dispatch reservation is forbidden.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  if (run.engine_lease_holder !== input.claimHolder) {
    throw new UsageError(
      `Workflow run ${input.runId} lease holder changed; refusing a stale durable dispatch reservation.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  if (run.engine_lease_until === null || run.engine_lease_until < input.now) {
    throw new UsageError(
      `Workflow run ${input.runId} engine lease expired before durable dispatch reservation.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
}

/** Input row for {@link WorkflowRunsRepository.insertRun}. */
export interface InsertRunInput {
  id: string;
  workflowRef: string;
  scopeKey: string | null;
  workflowEntryId: number | null;
  workflowTitle: string;
  paramsJson: string;
  currentStepId: string | null;
  createdAt: string;
  updatedAt: string;
  agentHarness: string | null;
  agentSessionId: string | null;
  checkinArmedAt: string | null;
}

/** Input row for {@link WorkflowRunsRepository.insertStep}. */
export interface InsertStepInput {
  runId: string;
  stepId: string;
  stepTitle: string;
  instructions: string;
  completionJson: string | null;
  sequenceIndex: number;
}

/** Complete, source-CAS-guarded publication envelope for a fresh v4 run. */
export interface PublishWorkflowRunV4Input {
  readonly workflowRefs: readonly string[];
  readonly force?: boolean;
  readonly run: InsertRunInput;
  readonly steps: InsertStepInput[];
  readonly planJson: string;
  readonly planHash: string;
  /** Final source/read-set CAS. Runs once under IMMEDIATE before the first write. */
  readonly revalidateSources: () => void;
}

/**
 * Publication envelope for a child workflow run (migration 023, P3a §5.2).
 *
 * Unlike {@link PublishWorkflowRunV4Input}, this carries no `revalidateSources`
 * and no `workflowRefs`/`force` scope-conflict inputs: the child plan was
 * already compiled, validated, frozen, and CAS'd into the PARENT's read set
 * at parent freeze time (docs/plans/specs/p3a-plan-v5-child-freeze.md §4.4),
 * so {@link WorkflowRunsRepository.publishChildWorkflowRun} performs no
 * source access and applies no top-level scope-conflict rule of its own.
 */
export interface PublishChildWorkflowRunInput {
  readonly parentRunId: string;
  /** The parent run's unit that spawned this child — stored in workflow_runs.parent_unit_id (A-N12). */
  readonly spawnedByUnitId: string;
  /** This spawn's deterministic identity — {@link WorkflowRunsRepository.publishChildWorkflowRun} is idempotent on (parentRunId, invocationKey). */
  readonly invocationKey: string;
  readonly run: InsertRunInput;
  readonly steps: InsertStepInput[];
  /** Canonical JSON of the EMBEDDED frozen child plan. Never re-derived from source. */
  readonly planJson: string;
  readonly planHash: string;
}

/** Filter object for {@link WorkflowRunsRepository.listRuns}. */
export interface ListRunsFilter {
  /** `null` (#942, `akm workflow list --all-scopes`) omits the scope predicate — every scope. */
  scopeKey: string | null;
  workflowRef?: string;
  workflowRefs?: readonly string[];
  /**
   * Restrict to runs that are EXACTLY `status = 'active'` (currently
   * executable). `blocked`/`failed`/`completed` runs are excluded — a `blocked`
   * run is parked awaiting a human `resume`, not executable, so it must not
   * surface under `--active`. It stays visible in an unfiltered `listRuns` with
   * its own status. For the active-OR-blocked "who occupies this scope" query
   * (the `akm show` guard) use {@link WorkflowRunsRepository.findActiveOrBlockedRunForScope}.
   */
  activeOnly?: boolean;
  /**
   * Include child workflow runs (P3b, B-N10). Default `false`: a child run
   * is invisible to this query unless explicitly opted in — surfaced as
   * `akm workflow list --children`. For any database with no child rows —
   * every pre-P3b database and every non-composing workflow — the result set
   * is byte-identical regardless of this flag.
   */
  includeChildren?: boolean;
}

/**
 * Whether `error` is one of the specific SQLite conditions a run-lease
 * statement can throw under real cross-process contention on the same row:
 * the shared {@link isSqliteContentionError} classifier (SQLITE_BUSY/LOCKED,
 * "database is locked", "database table is locked", the phantom-BEGIN
 * marker) plus two corruption-shaped message texts a transient contention
 * blip has been observed producing on this specific race, "disk I/O error"
 * and "database disk image is malformed". Matching on this set alone is
 * never sufficient to call something lease contention — see
 * {@link WorkflowRunsRepository.acquireEngineLease}, which additionally
 * requires a fresh read confirming a live lease before substituting the
 * lease-held message for the original error.
 */
function isLeaseContentionSqliteError(error: unknown): boolean {
  if (isSqliteContentionError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("disk I/O error") || message.includes("database disk image is malformed");
}

const LEASE_RETRY_ATTEMPTS = 4;
const LEASE_RETRY_BASE_DELAY_MS = 15;

/**
 * Retry a single lease statement across a short, bounded set of attempts when
 * it throws one of {@link isLeaseContentionSqliteError}'s conditions —
 * absorbing a blip that a fresh attempt on the same connection clears on its
 * own. Any other error, or the same error surviving every attempt, propagates
 * unchanged; this never converts a persistent failure into a false success.
 */
function runLeaseStatementWithRetry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < LEASE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isLeaseContentionSqliteError(error)) throw error;
      lastError = error;
      if (attempt < LEASE_RETRY_ATTEMPTS - 1) sleepSync(LEASE_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * Repository owning every raw SQL statement against `workflow_runs` and
 * `workflow_run_steps`. It is DB-location-agnostic: the lifecycle helper
 * {@link withWorkflowRunsRepo} binds it to {@link StorageLocations.stateDb}, so
 * a future storage move changes only `locations.ts`.
 *
 * ## Connection-lifetime contract (WS5)
 *
 * Every read method fully materialises its result set (`.all()` / `.get()` into
 * plain values/arrays) before returning. The repository NEVER hands a live
 * statement iterator or cursor back across the {@link withWorkflowRunsRepo}
 * scope boundary, so the connection can be closed immediately after `fn`
 * resolves without truncating lazy iteration.
 */
export class WorkflowRunsRepository {
  constructor(private readonly db: Database) {}

  /** Escape hatch for the transaction-bounded write paths still orchestrated
   * in runs.ts. The repository owns the SQL; the caller owns the transaction
   * boundary (unchanged from the pre-extraction `db.transaction(() => …)`). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  immediateTransaction<T>(fn: (db: Database) => T): T {
    return withImmediateTransaction(this.db, () => fn(this.db));
  }

  // ── reads (fully materialised) ─────────────────────────────────────────────

  /**
   * The top-level start guard `publishWorkflowRunV4` uses to refuse starting
   * a SECOND active run of the same ref in the same scope. `AND
   * parent_run_id IS NULL` (B-N10's FOURTH site, code-review round 4 finding
   * 2 / Review log R2): a child run carries the PARENT's `scope_key` (P3a
   * §5.2), so once a parent publishes a child of some ref, starting a
   * TOP-LEVEL run of that same ref in that scope must never resolve to the
   * child — the child is not "already an active run in this scope" from a
   * fresh top-level invocation's point of view; the PARENT, if anything, is.
   * Before this filter, `publishWorkflowRunV4` refused with
   * `RESOURCE_ALREADY_EXISTS` naming the CHILD's own run id, instructing the
   * operator to `akm workflow abandon` a child a parent is actively driving.
   * For any database with no child rows the result is byte-identical, same
   * as the other three B-N10 sites below.
   *
   * Always scope-local: `scopeKey` is a real scope, never "every scope" — see
   * {@link findActiveRunOutsideScope} for the cross-scope warning's query.
   */
  findActiveRunForScope(
    workflowRefs: string | readonly string[],
    scopeKey: string,
  ): { id: string; current_step_id: string | null } | undefined {
    const refs = typeof workflowRefs === "string" ? [workflowRefs] : [...workflowRefs];
    if (refs.length === 0) return undefined;
    return this.db
      .prepare(
        `SELECT id, current_step_id FROM workflow_runs WHERE workflow_ref IN (${refs.map(() => "?").join(", ")}) AND scope_key = ? AND status = 'active' AND parent_run_id IS NULL ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      )
      .get(...refs, scopeKey) as { id: string; current_step_id: string | null } | undefined;
  }

  /**
   * The cross-scope start warning's query (#942): the most recently active
   * run of these refs OUTSIDE `scopeKey` — i.e. `scope_key IS NULL OR
   * scope_key != scopeKey`, not merely "the most recent active run of these
   * refs anywhere". A same-scope active row must never win the `LIMIT 1` and
   * mask a DIFFERENT scope's run: with `--new`/`--force`, the caller's own
   * active run could otherwise sort first (most recently updated) and hide a
   * third scope's run entirely, so `startWorkflowRun` silently warned about
   * nothing while a genuinely stale run in another scope went unreported.
   * `findActiveRunForScope` deliberately stays scope-local and is never used
   * for this purpose.
   */
  findActiveRunOutsideScope(workflowRefs: string | readonly string[], scopeKey: string): WorkflowRunRow | undefined {
    const refs = typeof workflowRefs === "string" ? [workflowRefs] : [...workflowRefs];
    if (refs.length === 0) return undefined;
    return (
      (this.db
        .prepare(
          `SELECT * FROM workflow_runs WHERE workflow_ref IN (${refs.map(() => "?").join(", ")}) AND (scope_key IS NULL OR scope_key != ?) AND status = 'active' AND parent_run_id IS NULL ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
        )
        .get(...refs, scopeKey) as WorkflowRunRow | undefined) ?? undefined
    );
  }

  getRunById(runId: string): WorkflowRunRow | undefined {
    return (
      (this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as WorkflowRunRow | undefined) ??
      undefined
    );
  }

  /**
   * The scope-attach lookup `akm workflow run <ref>` uses to find an
   * in-progress top-level run to resume instead of starting a new one.
   * `AND parent_run_id IS NULL` (B-N10): a child run must never be attached
   * to directly through this path — a parent-driven child would then have
   * TWO drivers. For any database with no child rows the result is
   * byte-identical.
   *
   * Always scope-local: `scopeKey` is a real scope, never "every scope" — see
   * {@link findActiveRunOutsideScope} for the cross-scope warning's query.
   */
  getActiveRunRowForScope(workflowRefs: string | readonly string[], scopeKey: string): WorkflowRunRow | undefined {
    const refs = typeof workflowRefs === "string" ? [workflowRefs] : [...workflowRefs];
    if (refs.length === 0) return undefined;
    return (
      (this.db
        .prepare(
          `SELECT * FROM workflow_runs WHERE workflow_ref IN (${refs.map(() => "?").join(", ")}) AND scope_key = ? AND status = 'active' AND parent_run_id IS NULL ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
        )
        .get(...refs, scopeKey) as WorkflowRunRow | undefined) ?? undefined
    );
  }

  hasRun(runId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM workflow_runs WHERE id = ? LIMIT 1").get(runId) as
      | { 1: number }
      | undefined;
    return !!row;
  }

  /** The one run id starting with `prefix` (#919); `UsageError` on several, `NotFoundError` on none. */
  resolveRunIdPrefix(prefix: string): string {
    const escaped = escapeLikePattern(prefix);
    const rows = this.db
      .prepare("SELECT id FROM workflow_runs WHERE id LIKE ? ESCAPE '\\' ORDER BY id ASC")
      .all(`${escaped}%`) as Array<{ id: string }>;
    if (rows.length === 1) return rows[0]!.id;
    if (rows.length > 1) {
      throw new UsageError(
        `Ambiguous workflow run id prefix "${prefix}" — matches: ${rows.map((r) => r.id).join(", ")}`,
        "INVALID_FLAG_VALUE",
      );
    }
    throw new NotFoundError(`Workflow run "${prefix}" not found.`, "WORKFLOW_NOT_FOUND");
  }

  listRuns(filter: ListRunsFilter): WorkflowRunRow[] {
    const filters: string[] = [];
    const params: string[] = [];
    // `scopeKey: null` (#942) is "every scope" — the predicate is omitted
    // rather than bound as SQL NULL (which would match nothing, since a real
    // `scope_key` column value is never NULL for a fresh run).
    if (filter.scopeKey !== null) {
      filters.push("scope_key = ?");
      params.push(filter.scopeKey);
    }
    if (filter.workflowRef) {
      filters.push("workflow_ref = ?");
      params.push(filter.workflowRef);
    } else if (filter.workflowRefs && filter.workflowRefs.length > 0) {
      filters.push(`workflow_ref IN (${filter.workflowRefs.map(() => "?").join(", ")})`);
      params.push(...filter.workflowRefs);
    }
    if (filter.activeOnly) {
      // `activeOnly` means EXACTLY status='active' — a run currently
      // executable. A `blocked` run is NOT active (it is parked awaiting a
      // human `resume`), so it must never appear under `--active`, or a script
      // treating `--active` output as executable work would pick up a blocked
      // run (owner manual-validation finding 1). Blocked runs stay visible in
      // plain `list` (all statuses) with their `blocked` status. The
      // active-OR-blocked scope semantics some call sites want (the `akm show`
      // scope guard, which surfaces a blocked run as the scope's occupant) live
      // in the SEPARATE {@link findActiveOrBlockedRunForScope} — never folded
      // into this shared list filter.
      filters.push("status = 'active'");
    }
    // B-N10: a child run is invisible to this scope query unless the caller
    // explicitly opts in (`akm workflow list --children`). For any database
    // with no child rows the result set is byte-identical either way.
    if (!filter.includeChildren) {
      filters.push("parent_run_id IS NULL");
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM workflow_runs ${where} ORDER BY updated_at DESC, created_at DESC`)
      .all(...params) as WorkflowRunRow[];
  }

  getStepsForRun(runId: string): WorkflowRunStepRow[] {
    return this.db
      .prepare("SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY sequence_index ASC")
      .all(runId) as WorkflowRunStepRow[];
  }

  getStep(runId: string, stepId: string): WorkflowRunStepRow | undefined {
    return this.db.prepare("SELECT * FROM workflow_run_steps WHERE run_id = ? AND step_id = ?").get(runId, stepId) as
      | WorkflowRunStepRow
      | undefined;
  }

  /**
   * The `akm show` active-run guard: which run (if any) currently occupies
   * this scope. `AND parent_run_id IS NULL` (B-N10) — a child a parent is
   * driving must never be reported as "the" active run; the PARENT is. For
   * any database with no child rows the result is byte-identical.
   */
  findActiveOrBlockedRunForScope(
    scopeKey: string,
  ): { id: string; current_step_id: string | null; workflow_ref: string } | null {
    return (
      this.db
        .prepare<{ id: string; current_step_id: string | null; workflow_ref: string }>(
          "SELECT id, current_step_id, workflow_ref FROM workflow_runs WHERE scope_key = ? AND status IN ('active', 'blocked') AND parent_run_id IS NULL ORDER BY updated_at DESC LIMIT 1",
        )
        .get(scopeKey) ?? null
    );
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  insertRun(input: InsertRunInput): void {
    // R-R3 (P3a Review log; docs/plans/specs/p4-deletions-closeout.md §8):
    // this 13-column list is hand-duplicated by publishChildWorkflowRun's own
    // INSERT below, which extends it with parent_run_id/parent_unit_id/
    // invocation_key. A signature refactor to share one INSERT builder was
    // considered and deliberately deferred — see
    // docs/architecture/decisions/0009-child-run-publication-column-parity.md.
    // Keep both column lists in sync by hand.
    this.db
      .prepare(
        `INSERT INTO workflow_runs (
          id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status, params_json, current_step_id, created_at, updated_at,
          agent_harness, agent_session_id, checkin_armed_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workflowRef,
        input.scopeKey,
        input.workflowEntryId,
        input.workflowTitle,
        input.paramsJson,
        input.currentStepId,
        input.createdAt,
        input.updatedAt,
        input.agentHarness,
        input.agentSessionId,
        input.checkinArmedAt,
      );
  }

  insertSteps(steps: InsertStepInput[]): void {
    const insertStep = this.db.prepare(
      `INSERT INTO workflow_run_steps (
          run_id, step_id, step_title, instructions, completion_json, sequence_index, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    );
    for (const step of steps) {
      insertStep.run(
        step.runId,
        step.stepId,
        step.stepTitle,
        step.instructions,
        step.completionJson,
        step.sequenceIndex,
      );
    }
  }

  reopenStepsForResume(runId: string, currentStepId: string): void {
    this.db
      .prepare(
        `UPDATE workflow_run_steps
             SET status = 'pending', notes = NULL, evidence_json = NULL, completed_at = NULL
             WHERE run_id = ? AND step_id = ? AND status IN ('blocked', 'failed')`,
      )
      .run(runId, currentStepId);
  }

  markRunActive(runId: string, updatedAt: string): void {
    this.db
      .prepare(
        "UPDATE workflow_runs SET status = 'active', updated_at = ?, engine_lease_holder = NULL, engine_lease_until = NULL WHERE id = ?",
      )
      .run(updatedAt, runId);
  }

  updateStepCompletion(input: {
    status: WorkflowRunStepStatus;
    notes: string | null;
    evidenceJson: string | null;
    summary: string | null;
    completedAt: string;
    runId: string;
    stepId: string;
  }): void {
    this.db
      .prepare(
        `UPDATE workflow_run_steps
           SET status = ?, notes = ?, evidence_json = ?, summary = ?, completed_at = ?
           WHERE run_id = ? AND step_id = ?`,
      )
      .run(input.status, input.notes, input.evidenceJson, input.summary, input.completedAt, input.runId, input.stepId);
  }

  updateRunState(input: {
    status: WorkflowRunStatus;
    currentStepId: string | null;
    updatedAt: string;
    completedAt: string | null;
    checkinArmedAt: string;
    runId: string;
  }): void {
    this.db
      .prepare(
        `UPDATE workflow_runs
           SET status = ?, current_step_id = ?, updated_at = ?, completed_at = ?, checkin_armed_at = ?
           WHERE id = ?`,
      )
      .run(input.status, input.currentStepId, input.updatedAt, input.completedAt, input.checkinArmedAt, input.runId);
  }

  markRunAbandoned(runId: string, updatedAt: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE workflow_runs
           SET status = 'failed', updated_at = ?, completed_at = ?, checkin_armed_at = ?
           WHERE id = ? AND status IN ('active', 'blocked')`,
      )
      .run(updatedAt, updatedAt, updatedAt, runId);
    return Number(result.changes) === 1;
  }

  rearmCheckin(runId: string, checkinArmedAt: string): void {
    this.db.prepare("UPDATE workflow_runs SET checkin_armed_at = ? WHERE id = ?").run(checkinArmedAt, runId);
  }

  /**
   * Atomically publish the entire durable-v4 run spine after the final source
   * CAS. No run row, partial spine, plan attachment, or started event can
   * escape independently across a crash or statement failure.
   */
  publishWorkflowRunV4(input: PublishWorkflowRunV4Input): void {
    this.immediateTransaction((db) => {
      input.revalidateSources();
      if (!input.force) {
        // The uniqueness guard must never silently skip its scope predicate
        // (#942) — every real caller (`startWorkflowRun`) stamps a concrete
        // scope key, so a null one here means the caller is misusing this
        // top-level guard, not that scoping should be waived.
        if (input.run.scopeKey === null) {
          throw new Error("publishWorkflowRunV4: run.scopeKey must not be null for the scope uniqueness guard.");
        }
        const existing = this.findActiveRunForScope(input.workflowRefs, input.run.scopeKey);
        if (existing) {
          throw new UsageError(
            `Workflow ${input.run.workflowRef} already has an active run in this scope ` +
              `(id=${existing.id}, scope=${input.run.scopeKey}, step=${existing.current_step_id ?? "—"}). ` +
              `Use 'akm workflow run ${input.run.workflowRef}' to resume it or ` +
              `'akm workflow abandon ${existing.id}' to give up on it.`,
            "RESOURCE_ALREADY_EXISTS",
          );
        }
      }
      this.insertRun(input.run);
      this.insertSteps(input.steps);
      db.prepare("UPDATE workflow_runs SET plan_json = ?, plan_hash = ?, plan_ir_version = 5 WHERE id = ?").run(
        input.planJson,
        input.planHash,
        input.run.id,
      );
      insertEventOnce(db, {
        eventType: "workflow_started",
        ts: input.run.createdAt,
        ref: input.run.workflowRef,
        metadata: { runId: input.run.id, status: "active" },
        idempotencyKey: input.run.id,
        idempotencyMetadataKey: "runId",
      });
    });
  }

  // ── child workflow run publication (migration 023, P3a §5.2-§5.3) ─────────
  //
  // No production caller exists in P3a (§5.5) — dispatch is P3b's. These
  // three methods are reachable only from tests until then.

  /**
   * Idempotently publish a child workflow run underneath the parent unit
   * that spawned it. ONE `immediateTransaction`: SELECT by
   * `(parent_run_id, invocation_key)` and return the existing child if
   * present; otherwise INSERT the child run row (parentage columns +
   * `invocation_key`), its step rows, attach the embedded frozen child plan
   * (`plan_ir_version = 5`), and append its `workflow_started` event — then
   * return the freshly-inserted row.
   *
   * Deliberately does NOT: call {@link findActiveRunForScope} or raise
   * `RESOURCE_ALREADY_EXISTS` (top-level scope-conflict rules do not apply to
   * a child, C-10); call `revalidateSources` or read the filesystem in any
   * way (the child plan was frozen and CAS'd into the PARENT's read set at
   * parent freeze, C-11); or touch {@link publishWorkflowRunV4} /
   * `startWorkflowRun` (untouched, C-12).
   *
   * This method's serialization guarantee holds only when it is the
   * OUTERMOST transaction on the connection (spec Review log R10,
   * docs/plans/specs/p3a-plan-v5-child-freeze.md). `withImmediateTransaction`
   * (src/core/state-db.ts) has a re-entrancy guard: if a transaction is
   * already open on the connection, it SILENTLY JOINS that transaction
   * instead of issuing its own `BEGIN IMMEDIATE`.
   * `WorkflowRunsRepository.transaction()` is DEFERRED (`db.transaction(fn)()`)
   * and is already used in production at `resumeWorkflowRun`
   * (src/workflows/runtime/runs.ts:506) and `completeWorkflowStep` (:782) —
   * a caller that wires this call inside one of those outer transactions
   * loses the guarantee below: the SELECT can read a stale snapshot, both
   * publishers can miss the existing row, and the loser's INSERT hits
   * `idx_workflow_runs_invocation_key` with a raw `SQLiteError` instead of
   * returning the winner's row.
   *
   * As the outermost transaction, the whole SELECT-else-INSERT sequence runs
   * inside one `BEGIN IMMEDIATE`, so two concurrent callers racing on the
   * same `(parentRunId, invocationKey)` serialize on SQLite's write lock: the
   * first to acquire it inserts and commits, and the second's own SELECT —
   * which can only run once it has acquired the lock in turn — finds and
   * returns the first's row rather than inserting a duplicate or throwing
   * (C-09). Calling this twice with the same key, including across a crash
   * between publish and parent-side recording, is therefore safe and returns
   * the same child both times, with exactly one event and one step set
   * (C-08).
   */
  publishChildWorkflowRun(input: PublishChildWorkflowRunInput): WorkflowRunRow {
    return this.immediateTransaction((db) => {
      const existing = db
        .prepare("SELECT * FROM workflow_runs WHERE parent_run_id = ? AND invocation_key = ?")
        .get(input.parentRunId, input.invocationKey) as WorkflowRunRow | undefined;
      if (existing) return existing;

      // R-R3 (P3a Review log; docs/plans/specs/p4-deletions-closeout.md §8):
      // the first 13 columns here must stay byte-identical to insertRun's own
      // column list above (hand-duplicated, not shared, by deliberate choice
      // — see docs/architecture/decisions/0009-child-run-publication-column-parity.md).
      // Keep both column lists in sync by hand.
      db.prepare(
        `INSERT INTO workflow_runs (
          id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status, params_json, current_step_id, created_at, updated_at,
          agent_harness, agent_session_id, checkin_armed_at, parent_run_id, parent_unit_id, invocation_key
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.run.id,
        input.run.workflowRef,
        input.run.scopeKey,
        input.run.workflowEntryId,
        input.run.workflowTitle,
        input.run.paramsJson,
        input.run.currentStepId,
        input.run.createdAt,
        input.run.updatedAt,
        input.run.agentHarness,
        input.run.agentSessionId,
        input.run.checkinArmedAt,
        input.parentRunId,
        input.spawnedByUnitId,
        input.invocationKey,
      );
      this.insertSteps(input.steps);
      db.prepare("UPDATE workflow_runs SET plan_json = ?, plan_hash = ?, plan_ir_version = 5 WHERE id = ?").run(
        input.planJson,
        input.planHash,
        input.run.id,
      );
      insertEventOnce(db, {
        eventType: "workflow_started",
        ts: input.run.createdAt,
        ref: input.run.workflowRef,
        metadata: { runId: input.run.id, status: "active" },
        idempotencyKey: input.run.id,
        idempotencyMetadataKey: "runId",
      });

      return db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(input.run.id) as WorkflowRunRow;
    });
  }

  /**
   * Persist a run's resolved declared `outputs:` (migration 024, P3b §4.3).
   * Called from INSIDE `completeWorkflowStep`'s own write transaction — this
   * method opens none of its own, matching `updateStepCompletion` /
   * `updateRunState` immediately above.
   */
  setRunOutputs(runId: string, outputsJson: string): void {
    this.db.prepare("UPDATE workflow_runs SET outputs_json = ? WHERE id = ?").run(outputsJson, runId);
  }

  /** Every child run published under `parentRunId`, oldest first. `[]` when none. */
  childRunsOf(parentRunId: string): WorkflowRunRow[] {
    return this.db
      .prepare("SELECT * FROM workflow_runs WHERE parent_run_id = ? ORDER BY created_at ASC, id ASC")
      .all(parentRunId) as WorkflowRunRow[];
  }

  /** The child run published under `(parentRunId, key)`, or undefined if none has been published yet. */
  getRunByInvocationKey(parentRunId: string, key: string): WorkflowRunRow | undefined {
    return (
      (this.db
        .prepare("SELECT * FROM workflow_runs WHERE parent_run_id = ? AND invocation_key = ?")
        .get(parentRunId, key) as WorkflowRunRow | undefined) ?? undefined
    );
  }

  // ── engine run lease (migration 006 columns, R2 enforcement) ──────────────
  //
  // Single-driver invariant: at most one `akm workflow run` invocation drives
  // a run at a time. The lease is (holder id, expiry); all timestamps are
  // ISO-8601 UTC strings, which compare correctly with SQL `<` (lexicographic
  // order matches chronological order for a fixed-format UTC ISO string).

  /**
   * Atomically claim the run lease: succeeds when the run is unleased OR the
   * existing lease has expired (`engine_lease_until < now` — crash recovery).
   * A live lease held by anyone (including a stale copy of the same holder)
   * is NOT reclaimable through this method; the single UPDATE is the whole
   * claim, so two racing invocations cannot both win.
   *
   * The UPDATE can throw instead of cleanly returning `changes: 0` under real
   * cross-process contention on this row: a `SQLITE_BUSY`/`SQLITE_LOCKED`
   * from two engines racing the same statement, occasionally surfacing as
   * "database is locked" or even "database disk image is malformed" text that
   * reads as corruption but is not. `runLeaseStatementWithRetry` absorbs a
   * blip that a fresh attempt clears on its own. If it is still failing after
   * every retry, the row is read fresh (a plain SELECT, far less likely to
   * trip whatever the write hit) to get independent evidence of what is
   * actually going on: a live lease there means this really was contention,
   * so the caller gets the same lease-held message `akm workflow run` already
   * shows for the clean (non-throwing) case, now with `RUN_LEASE_HELD`. No
   * live lease — or the verifying read itself fails — means the error was
   * never actually about the lease, so it is rethrown exactly as raised.
   * Nothing here invents a diagnosis from error text alone or suppresses a
   * genuine SQLite failure.
   */
  acquireEngineLease(runId: string, holder: string, until: string, now: string): boolean {
    try {
      const result = runLeaseStatementWithRetry(() =>
        this.db
          .prepare(
            `UPDATE workflow_runs
               SET engine_lease_holder = ?, engine_lease_until = ?
               WHERE id = ? AND status = 'active'
                 AND (engine_lease_holder IS NULL OR engine_lease_until IS NULL OR engine_lease_until < ?)`,
          )
          .run(holder, until, runId, now),
      );
      return Number(result.changes) > 0;
    } catch (error) {
      if (!isLeaseContentionSqliteError(error)) throw error;
      const row = this.tryReadLeaseColumns(runId);
      if (row?.engine_lease_holder && row.engine_lease_until && row.engine_lease_until >= now) {
        throw new TransientError(
          `Workflow run ${runId} is already being driven by engine ${row.engine_lease_holder} ` +
            `(run lease expires ${row.engine_lease_until}). A second \`akm workflow run\` would race it — ` +
            `wait for that invocation to finish or for the lease to expire.`,
          "RUN_LEASE_HELD",
        );
      }
      throw error;
    }
  }

  /**
   * Extend the lease expiry — only while `holder` still owns it. Returns
   * false when the lease was lost (expired and claimed by another engine),
   * so the caller can stop driving instead of racing the new owner. Wrapped
   * in the same transient-error retry as {@link acquireEngineLease}; a
   * renewal that still fails after retries is rethrown as-is (no confirmed
   * "lost lease" diagnosis to substitute, unlike the acquire case above).
   */
  renewEngineLease(runId: string, holder: string, until: string): boolean {
    const result = runLeaseStatementWithRetry(() =>
      this.db
        .prepare(
          "UPDATE workflow_runs SET engine_lease_until = ? WHERE id = ? AND engine_lease_holder = ? AND status = 'active'",
        )
        .run(until, runId, holder),
    );
    return Number(result.changes) > 0;
  }

  /**
   * Clear the lease only while `holder` still owns a non-failed run. Failed
   * runs retain the final holder/expiry for forensics until explicit resume.
   * Releasing an already-lost lease is a harmless no-op.
   */
  releaseEngineLease(runId: string, holder: string): void {
    this.db
      .prepare(
        "UPDATE workflow_runs SET engine_lease_holder = NULL, engine_lease_until = NULL WHERE id = ? AND engine_lease_holder = ? AND status <> 'failed'",
      )
      .run(runId, holder);
  }

  /**
   * Self-heal an engine lease its holder crashed without releasing: once
   * `engine_lease_until` has passed, clear it so a read (`workflow status`,
   * `workflow list`) stops reporting a run as engine-driven when the engine is
   * long gone — mirroring the maintenance barrier's self-reclaim of a wedged
   * sentinel (`tryAcquireMaintenanceBarrier`) rather than a bespoke mechanism.
   * The WHERE clause repeats the exact (holder, until) snapshot the caller
   * read, so a lease renewed or re-acquired in between never gets clobbered —
   * same compare-and-swap shape as the claim above. Never touches a lease
   * that is still live.
   */
  reclaimExpiredEngineLease(runId: string, holder: string, until: string, now: string): boolean {
    if (until >= now) return false;
    const result = this.db
      .prepare(
        `UPDATE workflow_runs
           SET engine_lease_holder = NULL, engine_lease_until = NULL
           WHERE id = ? AND engine_lease_holder = ? AND engine_lease_until = ? AND engine_lease_until < ?`,
      )
      .run(runId, holder, until, now);
    return Number(result.changes) > 0;
  }

  /** Best-effort lease-column read used only to confirm genuine contention after {@link acquireEngineLease} exhausts its retries. `undefined` on any failure — never a diagnosis, just "couldn't confirm". */
  private tryReadLeaseColumns(
    runId: string,
  ): Pick<WorkflowRunRow, "engine_lease_holder" | "engine_lease_until"> | undefined {
    try {
      return (
        (this.db.prepare("SELECT engine_lease_holder, engine_lease_until FROM workflow_runs WHERE id = ?").get(runId) as
          | Pick<WorkflowRunRow, "engine_lease_holder" | "engine_lease_until">
          | undefined) ?? undefined
      );
    } catch {
      return undefined;
    }
  }

  // ── durable v4 append-only dispatch attempts (migration 022) ─────────────

  getUnitAttempts(runId: string, unitId: string): WorkflowRunUnitAttemptRowV4[] {
    return this.db
      .prepare(
        `SELECT * FROM workflow_run_unit_attempts
          WHERE run_id = ? AND unit_id = ?
          ORDER BY attempt`,
      )
      .all(runId, unitId) as WorkflowRunUnitAttemptRowV4[];
  }

  getAttemptAccounting(runId: string): WorkflowAttemptAccountingV4 {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_attempts,
           COALESCE(SUM(tokens), 0) AS total_tokens,
           COALESCE(SUM(CASE WHEN phase = 'unit' THEN 1 ELSE 0 END), 0) AS dispatch_attempts,
           COALESCE(SUM(CASE WHEN phase = 'unit' THEN COALESCE(tokens, 0) ELSE 0 END), 0) AS dispatch_tokens,
           COALESCE(SUM(CASE WHEN phase = 'gate' THEN 1 ELSE 0 END), 0) AS gate_attempts,
           COALESCE(SUM(CASE WHEN phase = 'gate' THEN COALESCE(tokens, 0) ELSE 0 END), 0) AS gate_tokens
         FROM workflow_run_unit_attempts
        WHERE run_id = ?`,
      )
      .get(runId) as {
      total_attempts: number;
      total_tokens: number;
      dispatch_attempts: number;
      dispatch_tokens: number;
      gate_attempts: number;
      gate_tokens: number;
    };
    return {
      totalAttempts: Number(row.total_attempts),
      totalTokens: Number(row.total_tokens),
      dispatchAttempts: Number(row.dispatch_attempts),
      dispatchTokens: Number(row.dispatch_tokens),
      gateAttempts: Number(row.gate_attempts),
      gateTokens: Number(row.gate_tokens),
    };
  }

  /**
   * Reserve or reclaim one v4 external dispatch. The attempt row, legacy
   * projection, and directly-paired started event share one IMMEDIATE
   * transaction. Reclaim keeps the stable dispatch id and emits no duplicate
   * start event: the external effect remains explicitly at-least-once.
   */
  reserveUnitAttempt(input: ReserveUnitAttemptV4Input): ReserveUnitAttemptV4Result {
    return this.immediateTransaction((db) => {
      const run = db
        .prepare("SELECT workflow_ref, status, engine_lease_holder, engine_lease_until FROM workflow_runs WHERE id = ?")
        .get(input.runId) as
        | {
            workflow_ref: string;
            status: string;
            engine_lease_holder: string | null;
            engine_lease_until: string | null;
          }
        | undefined;
      if (!run || run.status !== "active") {
        throw new UsageError(
          `Workflow run ${input.runId} is not active; refusing to reserve a durable dispatch attempt.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
      assertAttemptReservationLease(input, run);

      const latest = db
        .prepare(
          `SELECT * FROM workflow_run_unit_attempts
            WHERE run_id = ? AND unit_id = ?
            ORDER BY attempt DESC
            LIMIT 1`,
        )
        .get(input.runId, input.unitId) as WorkflowRunUnitAttemptRowV4 | undefined;
      if (latest?.status === "running") {
        if (latest.claim_holder === input.claimHolder) {
          return { kind: "existing", attempt: latest };
        }
        const currentRunLeaseDisplacedClaim = run.engine_lease_holder === input.claimHolder;
        const expired = latest.claim_expires_at < input.now;
        if (!expired && !currentRunLeaseDisplacedClaim) {
          return { kind: "busy", attempt: latest };
        }
        const reclaimed = db
          .prepare(
            `UPDATE workflow_run_unit_attempts
                SET claim_holder = ?, claim_expires_at = ?
              WHERE run_id = ? AND unit_id = ? AND attempt = ?
                AND status = 'running' AND dispatch_id = ? AND claim_holder = ?
                AND claim_expires_at = ?`,
          )
          .run(
            input.claimHolder,
            input.claimExpiresAt,
            input.runId,
            input.unitId,
            latest.attempt,
            latest.dispatch_id,
            latest.claim_holder,
            latest.claim_expires_at,
          );
        if (Number(reclaimed.changes) !== 1) {
          throw new Error(`Durable attempt ${input.unitId} changed while its displaced claim was reclaimed.`);
        }
        db.prepare(
          `UPDATE workflow_run_units
              SET claim_holder = ?, claim_expires_at = ?, last_checkin_at = ?
            WHERE run_id = ? AND unit_id = ? AND status = 'running'`,
        ).run(input.claimHolder, input.claimExpiresAt, input.now, input.runId, input.unitId);
        const attempt = db
          .prepare(
            `SELECT * FROM workflow_run_unit_attempts
              WHERE run_id = ? AND unit_id = ? AND attempt = ?`,
          )
          .get(input.runId, input.unitId, latest.attempt) as WorkflowRunUnitAttemptRowV4;
        return { kind: "reclaimed", attempt };
      }

      const attemptNumber = (latest?.attempt ?? 0) + 1;
      const dispatchId = randomUUID();
      db.prepare(
        `INSERT INTO workflow_run_unit_attempts (
           run_id, unit_id, attempt, dispatch_id, step_id, node_id, phase,
           runner, engine, model, input_hash, status, worktree_path, started_at,
           claim_holder, claim_expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      ).run(
        input.runId,
        input.unitId,
        attemptNumber,
        dispatchId,
        input.stepId,
        input.nodeId,
        input.phase,
        input.runner,
        input.engine,
        input.model,
        input.inputHash,
        input.worktreePath ?? null,
        input.now,
        input.claimHolder,
        input.claimExpiresAt,
      );
      db.prepare(
        `INSERT INTO workflow_run_units (
           run_id, unit_id, step_id, node_id, parent_unit_id, phase, runner, engine, model,
           status, input_hash, worktree_path, started_at, claim_holder, claim_expires_at, attempts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, unit_id) DO UPDATE SET
           step_id = excluded.step_id,
           node_id = excluded.node_id,
           parent_unit_id = excluded.parent_unit_id,
           phase = excluded.phase,
           runner = excluded.runner,
           engine = excluded.engine,
           model = excluded.model,
           status = 'running',
           input_hash = excluded.input_hash,
           worktree_path = excluded.worktree_path,
           started_at = excluded.started_at,
           claim_holder = excluded.claim_holder,
           claim_expires_at = excluded.claim_expires_at,
           result_json = NULL,
           tokens = NULL,
           failure_reason = NULL,
           session_id = NULL,
           finished_at = NULL,
           last_checkin_at = NULL,
           attempts = excluded.attempts`,
      ).run(
        input.runId,
        input.unitId,
        input.stepId,
        input.nodeId,
        input.parentUnitId ?? null,
        input.phase,
        input.runner,
        input.engine,
        input.model,
        input.inputHash,
        input.worktreePath ?? null,
        input.now,
        input.claimHolder,
        input.claimExpiresAt,
        attemptNumber,
      );
      insertEventStrict(db, {
        eventType: "workflow_unit_started",
        ts: input.now,
        ref: run.workflow_ref,
        metadata: {
          runId: input.runId,
          stepId: input.stepId,
          unitId: input.unitId,
          attempt: attemptNumber,
          dispatchId,
          phase: input.phase,
          status: "running",
        },
      });
      const attempt = db
        .prepare(
          `SELECT * FROM workflow_run_unit_attempts
            WHERE run_id = ? AND unit_id = ? AND attempt = ?`,
        )
        .get(input.runId, input.unitId, attemptNumber) as WorkflowRunUnitAttemptRowV4;
      return { kind: "reserved", attempt };
    });
  }

  /** Commit one CAS-valid v4 terminal result, known usage, and finish event. */
  finishUnitAttempt(input: FinishUnitAttemptV4Input): boolean {
    return this.immediateTransaction((db) => {
      const changed = db
        .prepare(
          `UPDATE workflow_run_unit_attempts
              SET status = ?, result_json = ?, tokens = ?, failure_reason = ?,
                  session_id = ?, finished_at = ?
            WHERE run_id = ? AND unit_id = ? AND attempt = ? AND dispatch_id = ?
              AND claim_holder = ? AND status = 'running'`,
        )
        .run(
          input.status,
          input.resultJson,
          input.tokens,
          input.failureReason,
          input.sessionId ?? null,
          input.finishedAt,
          input.runId,
          input.unitId,
          input.attempt,
          input.dispatchId,
          input.claimHolder,
        );
      if (Number(changed.changes) !== 1) return false;

      const attempt = db
        .prepare(
          `SELECT * FROM workflow_run_unit_attempts
            WHERE run_id = ? AND unit_id = ? AND attempt = ?`,
        )
        .get(input.runId, input.unitId, input.attempt) as WorkflowRunUnitAttemptRowV4;
      const projection = db
        .prepare(
          `UPDATE workflow_run_units
              SET status = ?, result_json = ?, tokens = ?, failure_reason = ?,
                  session_id = ?, finished_at = ?
            WHERE run_id = ? AND unit_id = ? AND status = 'running'
              AND attempts = ? AND claim_holder = ?`,
        )
        .run(
          input.status,
          input.resultJson,
          input.tokens,
          input.failureReason,
          input.sessionId ?? null,
          input.finishedAt,
          input.runId,
          input.unitId,
          input.attempt,
          input.claimHolder,
        );
      if (Number(projection.changes) !== 1) {
        throw new Error(`Durable attempt ${input.unitId} has no matching live workflow_run_units projection.`);
      }
      const run = db.prepare("SELECT workflow_ref FROM workflow_runs WHERE id = ?").get(input.runId) as
        | { workflow_ref: string }
        | undefined;
      if (!run) throw new Error(`Durable attempt ${input.unitId} has no owning workflow run.`);
      insertEventStrict(db, {
        eventType: "workflow_unit_finished",
        ts: input.finishedAt,
        ref: run.workflow_ref,
        metadata: {
          runId: input.runId,
          stepId: attempt.step_id,
          unitId: input.unitId,
          attempt: input.attempt,
          dispatchId: input.dispatchId,
          phase: attempt.phase,
          status: input.status,
          ...(input.failureReason ? { failureReason: input.failureReason } : {}),
          ...(input.tokens !== null ? { tokens: input.tokens } : {}),
        },
      });
      return true;
    });
  }

  // ── current unit status projection ─────────────────────────────────────────
  //
  // Writes to `workflow_run_units` should go through the serialized writer
  // queue (`src/workflows/exec/unit-writer.ts`) when N units may complete
  // concurrently — SQLite has a single writer per database FILE, and outside a
  // {@link withWorkflowRunsConnection} scope `withWorkflowRunsRepo` opens a
  // fresh connection per call (so N concurrent writers would contend against
  // each other for the write lock).

  getUnitsForRun(runId: string): WorkflowRunUnitRow[] {
    return this.db
      .prepare("SELECT * FROM workflow_run_units WHERE run_id = ? ORDER BY started_at ASC, unit_id ASC")
      .all(runId) as WorkflowRunUnitRow[];
  }

  getUnitsForStep(runId: string, stepId: string): WorkflowRunUnitRow[] {
    return this.db
      .prepare("SELECT * FROM workflow_run_units WHERE run_id = ? AND step_id = ? ORDER BY started_at ASC, unit_id ASC")
      .all(runId, stepId) as WorkflowRunUnitRow[];
  }

  /** One unit row by primary key, or undefined. */
  getUnit(runId: string, unitId: string): WorkflowRunUnitRow | undefined {
    return this.db.prepare("SELECT * FROM workflow_run_units WHERE run_id = ? AND unit_id = ?").get(runId, unitId) as
      | WorkflowRunUnitRow
      | undefined;
  }
}

/**
 * Run `fn` against a {@link WorkflowRunsRepository} bound to state.db
 * ({@link StorageLocations.stateDb}, the post-cutover home of the
 * `workflow_runs` / `workflow_run_steps` / `workflow_run_units` tables).
 *
 * Connection lifetime — BORROW-OR-OWN (mirrors `withStateDb`'s `borrowed`
 * option and `appendEvent`'s `ctx.db` seam):
 *
 *   - Inside a {@link withWorkflowRunsConnection} scope, the ambient handle is
 *     BORROWED and left open for the rest of the scope. A wide `map` fan-out
 *     therefore opens ONE connection for the whole step instead of two per unit
 *     (insert + finish) — `openStateDatabase` registers a maintenance activity
 *     lockfile and opens a read-only ledger-preflight handle on every call, so
 *     the per-call cost is milliseconds, not microseconds.
 *   - Outside a scope the behaviour is unchanged: open a fresh connection, run
 *     `fn`, close it in a `finally`.
 *
 * Repository read methods fully materialise their results, so closing an owned
 * handle here never truncates lazy iteration (WS5 connection-lifetime rule).
 * The signature and semantics are identical in both modes — reuse is purely an
 * internal optimisation and no caller needs to know which mode it is in.
 */
export async function withWorkflowRunsRepo<T>(fn: (repo: WorkflowRunsRepository) => T | Promise<T>): Promise<T> {
  const stateDb = resolveStorageLocations().stateDb;
  const borrowed = borrowScopedStateDb(stateDb);
  if (borrowed) return await Promise.resolve(fn(new WorkflowRunsRepository(borrowed)));
  const db = openStateDatabase(stateDb);
  try {
    return await Promise.resolve(fn(new WorkflowRunsRepository(db)));
  } finally {
    db.close();
  }
}

/**
 * Run `fn` with ONE state.db connection shared by every `withWorkflowRunsRepo`
 * call (and every {@link import("../../core/events").appendEvent}) inside its
 * async extent. The handle opens on first use and closes when `fn` settles;
 * nesting joins the outer scope.
 *
 * Correctness under concurrency: `bun:sqlite` statements and
 * `withImmediateTransaction` bodies run synchronously to completion, so
 * logically concurrent units cannot interleave statements on the shared handle
 * in a single-threaded event loop — sharing REMOVES in-process writer
 * contention instead of creating it. Cross-process arbitration (WAL,
 * `busy_timeout`, the run lease) is untouched. See `core/state-db-scope.ts` for
 * the escaped-async-work guard.
 */
export function withWorkflowRunsConnection<T>(fn: () => Promise<T>): Promise<T> {
  return withStateDbScope(fn, { path: resolveStorageLocations().stateDb });
}
