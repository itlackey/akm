// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proposal substrate (#225).
 *
 * One durable proposal store for every future reflection / generation flow
 * (`akm reflect`, `akm propose`, `akm distill`, lesson distillation, …).
 * Proposals are *queue state*, not source-of-truth assets — they sit on disk
 * waiting for human (or automated) review and only become assets after
 * `akm proposal accept` validates and promotes them via
 * {@link writeAssetToSource}.
 *
 * # Storage layout
 *
 *   <stashRoot>/.akm/proposals/<id>/proposal.json
 *   <stashRoot>/.akm/proposals/archive/<id>/proposal.json
 *
 * One directory per proposal id (a stable `crypto.randomUUID()`), so multiple
 * proposals can target the same `ref` without filesystem collisions.
 *
 * # Why direct fs (and not `writeAssetToSource`)
 *
 * The architectural rule "all writes go through `writeAssetToSource`" applies
 * to *assets*. Proposals are **not** assets — they live outside the asset tree
 * (under `.akm/proposals/`, parallel to how `events.jsonl` lives outside the
 * asset tree). Routing them through `writeAssetToSource` would force them into
 * a `TYPE_DIRS` slot, would commit them to git, and would leak unaccepted
 * drafts through the normal indexer. None of that is what we want for queue
 * state. The {@link promoteProposal} step is the bridge: it routes the
 * accepted payload through `writeAssetToSource` so the actual asset write
 * still funnels through the single dispatch point in
 * `src/core/write-source.ts`.
 *
 * Direct `fs` IO here is deliberate and the only place in the v1 codebase
 * that bypasses `writeAssetToSource` for "stash-adjacent" durable state. See
 * CLAUDE.md ("Writes" section) for the contract.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AssetRef } from "../../../core/asset/asset-ref";
import { makeAssetRef, parseAssetRef } from "../../../core/asset/asset-ref";
import { resolveAssetPathFromName, TYPE_DIRS } from "../../../core/asset/asset-spec";
import type { AkmConfig } from "../../../core/config/config";
import { NotFoundError, UsageError } from "../../../core/errors";
import { appendEvent } from "../../../core/events";
import { warn } from "../../../core/warn";
import {
  commitWriteTargetBoundary,
  formatRefForMessage,
  resolveWriteTarget,
  type WriteTargetSource,
  writeAssetToSource,
} from "../../../core/write-source";
import { runProposalValidators } from "./proposal-validators";

// ── Source allow-list (F-4 / #385) ──────────────────────────────────────────

/**
 * Curated allow-list of valid `source` values for proposals (F-4 / #385).
 *
 * Rationale (W3C PROV-DM 2013): Provenance records require typed, validated
 * sources for meaningful aggregation. Accept-rate-per-source is the core
 * self-measurement metric for recursive self-improvement: if reflect proposals
 * are accepted at 20% and distill proposals at 60%, that guides resource
 * allocation. Free-text typos (`"reflct"`) produce unaggregatable events.
 *
 * Automated sources (those in {@link AUTOMATED_PROPOSAL_SOURCES}) require a
 * `sourceRun` field for full PROV-DM traceability.
 */
export const PROPOSAL_SOURCES = [
  // Automated sources — require sourceRun for traceability.
  "reflect",
  "distill",
  "consolidate",
  "extract",
  "improve",
  // Semi-automated / tool-driven.
  "feedback",
  // Human-initiated / CLI-driven.
  "propose",
  "remember",
  "import",
  // Internal / system.
  "distill_quality_rejected",
  "schema-repair",
] as const;

/** Automated sources that SHOULD include a `sourceRun` for PROV-DM traceability. */
export const AUTOMATED_PROPOSAL_SOURCES = [
  "reflect",
  "distill",
  "consolidate",
  "extract",
  "improve",
  "schema-repair",
] as const satisfies ReadonlyArray<(typeof PROPOSAL_SOURCES)[number]>;

/** Union of all valid proposal source values. */
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

/**
 * Check whether a string is a valid {@link ProposalSource}.
 * Unknown source values are accepted with a runtime warning rather than a hard
 * error, to allow extensions without breaking existing callers.
 */
export function isValidProposalSource(source: string): source is ProposalSource {
  return (PROPOSAL_SOURCES as readonly string[]).includes(source);
}

/**
 * Check whether a source value is an automated source requiring `sourceRun`.
 */
export function isAutomatedProposalSource(source: string): source is (typeof AUTOMATED_PROPOSAL_SOURCES)[number] {
  return (AUTOMATED_PROPOSAL_SOURCES as readonly string[]).includes(source);
}

/**
 * Typed reasons {@link createProposal} can reject input. Emitted in the
 * `proposal_creation_rejected` event so we can quantify *which* check fires
 * most across runs and tune upstream pipelines.
 */
export type ProposalRejectionReason = "invalid_ref" | "unknown_type" | "empty_content" | "missing_description";

/** Result of {@link purgeOrphanProposals}. */
export interface OrphanPurgeResult {
  /** Total pending proposals scanned. */
  checked: number;
  /** Number of proposals rejected as orphans. */
  rejected: number;
  /** Wall-clock duration of the purge in ms. */
  durationMs: number;
  /** Count of rejections by asset type prefix. */
  byType: Record<string, number>;
  /** Per-orphan details for the event metadata. */
  orphans: Array<{ id: string; ref: string; reason: string }>;
}

/** Result of {@link expireStaleProposals} (Advantage D6b / Phase 6B). */
export interface ExpireStaleResult {
  /** Number of pending proposals scanned for expiry. */
  checked: number;
  /** Number of proposals archived because they aged past the retention window. */
  expired: number;
  /** Wall-clock duration of the expiration pass in ms. */
  durationMs: number;
  /** Retention threshold (days) applied during this pass. */
  retentionDays: number;
  /** Per-expired details for the event metadata. */
  expiredProposals: Array<{ id: string; ref: string; ageDays: number }>;
}

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a proposal.
 *
 *   - `pending`   — Live queue entry awaiting review.
 *   - `accepted`  — Promoted into the asset tree via {@link promoteProposal};
 *                   archived under `.akm/proposals/archive/<id>/`.
 *   - `rejected`  — Reviewer (or automated guard / orphan purge / expiration)
 *                   declined the proposal; archived.
 *   - `reverted`  — Previously `accepted` proposal that was rolled back via the
 *                   `akm proposal revert <id>` flow (D6c). The asset on disk is
 *                   restored from the backup captured at promotion time.
 */
export type ProposalStatus = "pending" | "accepted" | "rejected" | "reverted";

export interface ProposalPayload {
  /** Full file content the accepted proposal will write to disk. */
  content: string;
  /** Convenience parsed frontmatter, if the content is markdown-with-frontmatter. */
  frontmatter?: Record<string, unknown>;
}

export interface ProposalReview {
  outcome: "accepted" | "rejected";
  reason?: string;
  decidedAt: string;
}

export interface Proposal {
  /** Stable random id (crypto.randomUUID()). Directory name on disk. */
  id: string;
  /** Asset ref the proposal would create or update (`[origin//]type:name`). */
  ref: string;
  status: ProposalStatus;
  /**
   * Origin tag identifying the source subsystem (F-4 / #385).
   *
   * Should be one of {@link PROPOSAL_SOURCES}. Automated sources (reflect,
   * distill, consolidate, improve) additionally require `sourceRun` for
   * PROV-DM traceability and accept-rate-per-source aggregation.
   * Unknown values are accepted (warn at creation) to allow extensions.
   */
  source: ProposalSource | string;
  /**
   * Stable run identifier for the automated job that created this proposal.
   *
   * Required for automated sources ({@link AUTOMATED_PROPOSAL_SOURCES}) so
   * that accept-rate-per-source queries can be scoped to individual runs.
   * Optional for human-initiated sources (`propose`, `remember`, `import`).
   */
  sourceRun?: string;
  createdAt: string;
  updatedAt: string;
  payload: ProposalPayload;
  review?: ProposalReview;
  /**
   * Optional confidence score in `[0, 1]` (Advantage D6a / Phase 6A).
   *
   * When the proposal source can self-estimate quality (e.g. the reflect LLM
   * returning a calibrated score with its draft), this value drives the
   * auto-accept policy in `akm improve`. Proposals with `confidence` at or
   * above the active confidence threshold are accepted without reviewer
   * intervention; everything else waits in the pending queue.
   *
   * Out-of-range or non-finite values are stripped at {@link createProposal}
   * time so downstream code can rely on the invariant `0 <= confidence <= 1`.
   */
  confidence?: number;
  /**
   * Relative path (under the proposal directory) to the backup of the asset
   * content that existed at the target ref BEFORE promotion (Advantage D6c /
   * Phase 6C). Written exclusively by {@link promoteProposal} when the target
   * file existed; absent for genuinely-new assets. Consumed by the
   * `akm proposal revert <id>` flow to restore prior content.
   */
  backup?: string;
}

export interface ProposalsContext {
  /** Override the stash root used for proposal storage. */
  stashDir?: string;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /** Test seam — defaults to `crypto.randomUUID`. */
  randomUUID?: () => string;
}

export interface CreateProposalInput {
  ref: string;
  /**
   * Origin tag identifying the source subsystem (F-4 / #385).
   *
   * Should be one of {@link PROPOSAL_SOURCES}. Unknown values trigger a
   * runtime warning but are not rejected (backward compatibility).
   * Automated sources ({@link AUTOMATED_PROPOSAL_SOURCES}) should include
   * `sourceRun` for PROV-DM traceability.
   */
  source: ProposalSource | string;
  /**
   * Run identifier for the automated job creating this proposal.
   * Required (advisory) when `source` is an automated source. Logged as a
   * warning when omitted for automated sources so the gap is visible.
   */
  sourceRun?: string;
  payload: ProposalPayload;
  /**
   * When true, bypass dedup and cooldown guards. Use for human-initiated or
   * forced re-proposals that the operator has explicitly requested.
   */
  force?: boolean;
  /**
   * Optional confidence score in `[0, 1]` (Advantage D6a / Phase 6A).
   *
   * Values outside the closed interval `[0, 1]` and non-finite numbers
   * (NaN / ±Infinity) are silently dropped at create time so the persisted
   * proposal carries only well-formed scores. Callers that cannot estimate
   * confidence should omit the field.
   */
  confidence?: number;
}

/**
 * Reason a `createProposal` call was skipped by the dedup/cooldown guard.
 *
 *   - `duplicate_pending`  — A pending proposal already exists for this
 *                            `ref+source` combination. Pass `force: true` to
 *                            bypass.
 *   - `content_hash_match` — An identical payload (same content hash) is
 *                            already pending or was recently rejected. Bypass
 *                            with `force: true`.
 *   - `cooldown`           — A proposal for this `ref+source` was rejected
 *                            within the source-specific cooldown window
 *                            (reflect: 14 d, distill: 30 d, others: 7 d).
 */
export type ProposalSkipReason = "duplicate_pending" | "content_hash_match" | "cooldown";

export interface CreateProposalSkipped {
  skipped: true;
  reason: ProposalSkipReason;
  /** Human-readable explanation for logs / telemetry. */
  message: string;
  /** The existing proposal that triggered the guard (when applicable). */
  existingProposalId?: string;
}

/** Result of {@link createProposal} — either a new `Proposal` or a skip record. */
export type CreateProposalResult = Proposal | CreateProposalSkipped;

/** Type guard: true when createProposal returned a skipped record. */
export function isProposalSkipped(result: CreateProposalResult): result is CreateProposalSkipped {
  return (result as CreateProposalSkipped).skipped === true;
}

// ── Dedup / cooldown constants ───────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * Post-rejection cooldown windows by source. After a proposal is rejected,
 * `createProposal` silently skips new proposals for the same `ref+source`
 * until the window expires (unless `force: true` is passed).
 *
 * Rationale (Settles 2009 active-learning survey; Argilla/Label Studio HITL):
 * Reviewer fatigue is a blocker for the human-in-the-loop guarantee. Cooldowns
 * prevent nightly improve runs from re-flooding the queue with near-identical
 * proposals the reviewer just declined.
 *
 *   - reflect: 14 days (agent-based; slower feedback loops)
 *   - distill: 30 days (LLM-based; even more prone to regeneration loops)
 *   - default: 7 days  (conservative fallback for other sources)
 */
const COOLDOWN_MS: Record<string, number> = {
  reflect: 14 * MS_PER_DAY,
  distill: 30 * MS_PER_DAY,
};
const DEFAULT_COOLDOWN_MS = 7 * MS_PER_DAY;

function cooldownMsForSource(source: string): number {
  return COOLDOWN_MS[source] ?? DEFAULT_COOLDOWN_MS;
}

/** Compute a stable SHA-256 hex digest of a proposal's content string. */
function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Path helpers ────────────────────────────────────────────────────────────

/**
 * Resolve `<stashRoot>/.akm/proposals` (or its archive subdirectory). Direct
 * fs paths because proposal storage is queue state, not asset state — see the
 * module docblock for the architectural carve-out.
 */
export function getProposalsRoot(stashDir: string, archive = false): string {
  return archive ? path.join(stashDir, ".akm", "proposals", "archive") : path.join(stashDir, ".akm", "proposals");
}

function proposalDir(stashDir: string, id: string, archive: boolean): string {
  return path.join(getProposalsRoot(stashDir, archive), id);
}

function proposalFile(stashDir: string, id: string, archive: boolean): string {
  return path.join(proposalDir(stashDir, id, archive), "proposal.json");
}

function nowIso(ctx?: ProposalsContext): string {
  const fn = ctx?.now ?? Date.now;
  return new Date(fn()).toISOString();
}

function newId(ctx?: ProposalsContext): string {
  const fn = ctx?.randomUUID ?? randomUUID;
  return fn();
}

// ── Read / write primitives ─────────────────────────────────────────────────

function readProposalFile(filePath: string): Proposal {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new NotFoundError(
      `Proposal not found at ${filePath}.`,
      "FILE_NOT_FOUND",
      `The proposal file is missing or unreadable: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `Proposal file at ${filePath} is not valid JSON: ${(err as Error).message}`,
      "INVALID_JSON_ARGUMENT",
      "Re-create the proposal or remove the corrupt file under .akm/proposals/<id>/.",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new UsageError(`Proposal file at ${filePath} is not a JSON object.`, "INVALID_JSON_ARGUMENT");
  }
  return parsed as Proposal;
}

function writeProposalFile(filePath: string, proposal: Proposal): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new pending proposal. The id is a stable random UUID, so two
 * proposals with the same `ref` never collide on disk.
 *
 * **Dedup / cooldown guard** (F-2 / #363):
 *
 * Before writing, this function checks:
 *   1. `duplicate_pending` — a pending proposal already exists for the same
 *      `ref+source`. Pass `input.force = true` to bypass.
 *   2. `content_hash_match` — an identical content hash is already pending or
 *      was recently rejected for this `ref+source`. Bypass with `force: true`.
 *   3. `cooldown` — a proposal for this `ref+source` was rejected within the
 *      source-specific cooldown window (reflect: 14 d, distill: 30 d,
 *      others: 7 d). Bypass with `force: true`.
 *
 * When a guard fires the function returns a `CreateProposalSkipped` record
 * instead of writing to disk. Use {@link isProposalSkipped} to detect it.
 */
export function createProposal(
  stashDir: string,
  input: CreateProposalInput,
  ctx?: ProposalsContext,
): CreateProposalResult {
  // F-4 / #385: Validate source against the allow-list. Unknown values are
  // warned (not rejected) for backward compatibility — extension callers
  // that pass custom source strings must not break.
  if (!isValidProposalSource(input.source)) {
    warn(
      `[proposal] Unknown source "${input.source}". ` +
        `Expected one of: ${PROPOSAL_SOURCES.join(", ")}. ` +
        "Typos in source values produce unaggregatable accept-rate-per-source metrics.",
    );
  } else if (isAutomatedProposalSource(input.source) && !input.sourceRun) {
    // Advisory warning: automated sources should include sourceRun for PROV-DM
    // traceability. This is not a hard error to avoid breaking existing callers.
    warn(
      `[proposal] Automated source "${input.source}" created a proposal without sourceRun. ` +
        "Add sourceRun to enable accept-rate-per-run aggregation (W3C PROV-DM).",
    );
  }

  // Deterministic input validation. Reject obviously-invalid proposals at
  // the source rather than letting them enter the queue and waste reviewer
  // time. Each rejection emits `proposal_creation_rejected` with a typed
  // reason so we can see *which* check is firing in the event stream.
  const rejectProposal = (reason: ProposalRejectionReason, message: string): never => {
    appendEvent({
      eventType: "proposal_creation_rejected",
      ref: input.ref,
      metadata: { source: input.source, reason },
    });
    throw new UsageError(message, "INVALID_PROPOSAL");
  };

  let parsedRef: ReturnType<typeof parseAssetRef>;
  try {
    parsedRef = parseAssetRef(input.ref);
  } catch (err) {
    return rejectProposal(
      "invalid_ref",
      `Invalid proposal ref "${input.ref}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!TYPE_DIRS[parsedRef.type]) {
    return rejectProposal(
      "unknown_type",
      `Unknown asset type "${parsedRef.type}" in proposal ref "${input.ref}". Known types: ${Object.keys(TYPE_DIRS).sort().join(", ")}.`,
    );
  }
  if (!input.payload.content.trim()) {
    return rejectProposal("empty_content", `Proposal for "${input.ref}" has empty content.`);
  }
  // Description check is only enforced for `consolidate` source — that's the
  // automated pipeline that historically produced proposals with missing or
  // malformed frontmatter, polluting the queue with hundreds of unusable
  // entries. Reflect / distill / propose proposals have varied legitimate
  // shapes and should not be rejected here for missing description.
  if (input.source === "consolidate") {
    const desc = input.payload.frontmatter?.description;
    if (typeof desc !== "string" || desc.trim() === "") {
      return rejectProposal(
        "missing_description",
        `Proposal for "${input.ref}" (source=consolidate) has empty or missing frontmatter description.`,
      );
    }
  }

  const normalizedRef = makeAssetRef(parsedRef.type, parsedRef.name, parsedRef.origin);

  if (!input.force) {
    const newHash = contentHash(input.payload.content);
    const nowMs = (ctx?.now ?? Date.now)();
    const cooldownMs = cooldownMsForSource(input.source);

    // Scan pending proposals for ref+source matches.
    const pending = listProposals(stashDir, { ref: normalizedRef, status: "pending" }).filter(
      (p) => p.source === input.source,
    );

    if (pending.length > 0) {
      // Check for identical content hash first (silent skip).
      const hashMatch = pending.find((p) => contentHash(p.payload.content) === newHash);
      if (hashMatch) {
        return {
          skipped: true,
          reason: "content_hash_match",
          message: `Identical proposal for ${normalizedRef} already pending (id: ${hashMatch.id}).`,
          existingProposalId: hashMatch.id,
        };
      }
      // Duplicate pending for same ref+source (different content).
      const firstPending = pending[0];
      return {
        skipped: true,
        reason: "duplicate_pending",
        message: `A pending proposal for ${normalizedRef} from source "${input.source}" already exists (id: ${firstPending?.id ?? "unknown"}). Pass force:true to enqueue alongside it.`,
        existingProposalId: firstPending?.id,
      };
    }

    // Check cooldown against recently archived rejected proposals.
    const rejected = listProposals(stashDir, { ref: normalizedRef, status: "rejected", includeArchive: true })
      .filter((p) => p.source === input.source)
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());

    if (rejected.length > 0 && rejected[0] !== undefined) {
      const mostRecent = rejected[0];
      // Check content hash against recently rejected.
      if (contentHash(mostRecent.payload.content) === newHash) {
        return {
          skipped: true,
          reason: "content_hash_match",
          message: `Identical proposal for ${normalizedRef} was already rejected (id: ${mostRecent.id}).`,
          existingProposalId: mostRecent.id,
        };
      }
      // Check cooldown window.
      const rejectedAt = new Date(mostRecent.updatedAt ?? 0).getTime();
      if (nowMs - rejectedAt < cooldownMs) {
        const cooldownDays = cooldownMs / MS_PER_DAY;
        const remainingDays = Math.ceil((cooldownMs - (nowMs - rejectedAt)) / MS_PER_DAY);
        return {
          skipped: true,
          reason: "cooldown",
          message:
            `Proposal for ${normalizedRef} from source "${input.source}" is in cooldown ` +
            `(${cooldownDays}d window, ~${remainingDays}d remaining). Pass force:true to bypass.`,
          existingProposalId: mostRecent.id,
        };
      }
    }
  }

  const id = newId(ctx);
  const created = nowIso(ctx);

  // Phase 6A: validate confidence is a finite number in [0, 1]. Anything else
  // is dropped silently — we never store NaN, Infinity, or out-of-range values.
  // Callers that mis-report confidence should not poison the auto-accept gate.
  const sanitizedConfidence =
    typeof input.confidence === "number" &&
    Number.isFinite(input.confidence) &&
    input.confidence >= 0 &&
    input.confidence <= 1
      ? input.confidence
      : undefined;

  const proposal: Proposal = {
    id,
    ref: normalizedRef,
    status: "pending",
    source: input.source,
    ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
    createdAt: created,
    updatedAt: created,
    payload: {
      content: input.payload.content,
      ...(input.payload.frontmatter !== undefined ? { frontmatter: input.payload.frontmatter } : {}),
    },
    ...(sanitizedConfidence !== undefined ? { confidence: sanitizedConfidence } : {}),
  };

  writeProposalFile(proposalFile(stashDir, id, false), proposal);
  return proposal;
}

/**
 * List every proposal under the stash. By default returns pending proposals
 * from the live queue; pass `{ includeArchive: true }` to include rejected /
 * accepted entries that have been moved aside.
 */
export function listProposals(
  stashDir: string,
  options: { includeArchive?: boolean; status?: ProposalStatus; ref?: string; type?: string } = {},
): Proposal[] {
  const out: Proposal[] = [];
  const roots: { dir: string; archive: boolean }[] = [{ dir: getProposalsRoot(stashDir, false), archive: false }];
  if (options.includeArchive) {
    roots.push({ dir: getProposalsRoot(stashDir, true), archive: true });
  }
  for (const { dir } of roots) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Skip the archive subdirectory when iterating the live queue.
      if (!entry.isDirectory()) continue;
      if (entry.name === "archive") continue;
      const filePath = path.join(dir, entry.name, "proposal.json");
      if (!fs.existsSync(filePath)) continue;
      try {
        out.push(readProposalFile(filePath));
      } catch {
        // Surface invalid proposal files via a synthetic stub so callers can
        // see something in `akm proposal list` rather than the file
        // disappearing silently.
        out.push({
          id: entry.name,
          ref: "unknown:unknown",
          status: "rejected",
          source: "invalid",
          createdAt: "",
          updatedAt: "",
          payload: { content: "" },
          review: {
            outcome: "rejected",
            reason: "Invalid proposal file (could not be parsed).",
            decidedAt: "",
          },
        });
      }
    }
  }
  return out
    .filter((p) => (options.status ? p.status === options.status : true))
    .filter((p) => (options.ref ? p.ref === options.ref : true))
    .filter((p) => {
      if (!options.type) return true;
      try {
        return parseAssetRef(p.ref).type === options.type;
      } catch {
        // Unparseable ref (e.g. the synthetic "unknown:unknown" stub for an
        // invalid proposal file) never matches a concrete type filter.
        return false;
      }
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Look up a proposal by id. Searches the live queue first, then the archive.
 * Throws `NotFoundError` when no match exists.
 */
export function getProposal(stashDir: string, id: string): Proposal {
  const livePath = proposalFile(stashDir, id, false);
  if (fs.existsSync(livePath)) return readProposalFile(livePath);
  const archivedPath = proposalFile(stashDir, id, true);
  if (fs.existsSync(archivedPath)) return readProposalFile(archivedPath);
  throw new NotFoundError(`Proposal "${id}" not found.`, "FILE_NOT_FOUND");
}

/**
 * Resolve a proposal by full UUID, UUID prefix, or asset ref.
 *
 * Resolution order:
 *   1. Exact UUID match (existing behaviour).
 *   2. Asset ref (contains `:`) — finds the most-recent pending proposal for
 *      that ref; falls back to archived if nothing is pending.
 *   3. UUID prefix — matches any live proposal directory whose name starts
 *      with the given string; throws if ambiguous.
 */
export function resolveProposalId(stashDir: string, idOrRef: string): Proposal {
  // 1. Exact UUID.
  try {
    return getProposal(stashDir, idOrRef);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }

  // 2. Asset ref (e.g. "skill:akm-dream").
  if (idOrRef.includes(":")) {
    const pending = listProposals(stashDir, { ref: idOrRef });
    if (pending.length > 0) {
      return pending.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
    }
    const archived = listProposals(stashDir, { ref: idOrRef, includeArchive: true });
    if (archived.length > 0) {
      return archived.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
    }
    throw new NotFoundError(`No proposal found for ref "${idOrRef}".`, "FILE_NOT_FOUND");
  }

  // 3. UUID prefix.
  const liveDir = getProposalsRoot(stashDir, false);
  let prefixMatches: string[] = [];
  try {
    prefixMatches = fs.readdirSync(liveDir).filter((name) => name.startsWith(idOrRef));
  } catch {
    /* live dir may not exist yet */
  }
  if (prefixMatches.length === 1) return getProposal(stashDir, prefixMatches[0]);
  if (prefixMatches.length > 1) {
    throw new UsageError(`Ambiguous prefix "${idOrRef}" — matches: ${prefixMatches.join(", ")}`, "INVALID_FLAG_VALUE");
  }

  throw new NotFoundError(`Proposal "${idOrRef}" not found.`, "FILE_NOT_FOUND");
}

/**
 * Whether a proposal currently lives in the archive (used by callers that
 * need to know whether to look in the archive root for files / paths).
 */
export function isProposalArchived(stashDir: string, id: string): boolean {
  return !fs.existsSync(proposalFile(stashDir, id, false)) && fs.existsSync(proposalFile(stashDir, id, true));
}

/**
 * Move a proposal directory into the archive subtree and update its status.
 * Used by both accept (status `accepted`) and reject (status `rejected`)
 * paths so the live queue only contains pending entries.
 */
export function archiveProposal(
  stashDir: string,
  id: string,
  status: "accepted" | "rejected",
  reason: string | undefined,
  ctx?: ProposalsContext,
): Proposal {
  const sourceDir = proposalDir(stashDir, id, false);
  if (!fs.existsSync(sourceDir)) {
    // If it's already archived, just update the metadata in place.
    const archived = proposalFile(stashDir, id, true);
    if (fs.existsSync(archived)) {
      const existing = readProposalFile(archived);
      const updated: Proposal = {
        ...existing,
        status,
        updatedAt: nowIso(ctx),
        review: {
          outcome: status,
          ...(reason !== undefined ? { reason } : {}),
          decidedAt: nowIso(ctx),
        },
      };
      writeProposalFile(archived, updated);
      return updated;
    }
    throw new NotFoundError(`Proposal "${id}" not found.`, "FILE_NOT_FOUND");
  }

  const targetDir = proposalDir(stashDir, id, true);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.renameSync(sourceDir, targetDir);

  const updated: Proposal = {
    ...readProposalFile(proposalFile(stashDir, id, true)),
    status,
    updatedAt: nowIso(ctx),
    review: {
      outcome: status,
      ...(reason !== undefined ? { reason } : {}),
      decidedAt: nowIso(ctx),
    },
  };
  writeProposalFile(proposalFile(stashDir, id, true), updated);
  return updated;
}

/**
 * Scan all pending proposals and reject those whose target asset no longer
 * exists on disk across any of `sourceDirs`. Intended to run as a periodic
 * maintenance pass (see `runImproveMaintenancePasses`) — it keeps the queue
 * from accumulating stale reviewer work after large refactors or deletes.
 *
 * Scope rule: only `source=reflect` proposals are subject to orphan rejection.
 * Lessons, propose, distill, and consolidate proposals legitimately target
 * assets that don't exist yet and must never be purged.
 */
export function purgeOrphanProposals(
  stashDir: string,
  sourceDirs: string[],
  ctx?: ProposalsContext,
): OrphanPurgeResult {
  const t0 = Date.now();
  const orphans: Array<{ id: string; ref: string; reason: string }> = [];
  const byType: Record<string, number> = {};
  const pending = listProposals(stashDir, { status: "pending" });
  const reflectPending = pending.filter((p) => p.source === "reflect");

  for (const p of reflectPending) {
    let parsed: ReturnType<typeof parseAssetRef>;
    try {
      parsed = parseAssetRef(p.ref);
    } catch {
      continue;
    }
    // Lessons are new-asset proposals by definition — they cannot be orphaned.
    if (parsed.type === "lesson") continue;
    const spec = TYPE_DIRS[parsed.type];
    if (!spec) continue;

    const exists = sourceDirs.some((root) => {
      const typeRoot = path.join(root, spec);
      const candidate = resolveAssetPathFromName(parsed.type, typeRoot, parsed.name);
      return fs.existsSync(candidate);
    });

    if (!exists) {
      try {
        archiveProposal(stashDir, p.id, "rejected", "Asset no longer exists on disk", ctx);
        orphans.push({ id: p.id, ref: p.ref, reason: "asset_missing" });
        byType[parsed.type] = (byType[parsed.type] ?? 0) + 1;
      } catch (err) {
        // Best-effort — the purge is non-fatal. Log and continue.
        warn(
          `[proposals] purgeOrphanProposals: failed to reject ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    checked: reflectPending.length,
    rejected: orphans.length,
    durationMs: Date.now() - t0,
    byType,
    orphans,
  };
}

/**
 * Archive pending proposals older than `config.archiveRetentionDays` (Advantage
 * D6b / Phase 6B).
 *
 * Reviewer fatigue and queue rot are the dominant failure modes of any
 * human-in-the-loop pipeline (Settles 2009 active-learning survey). Pending
 * proposals that have aged past the retention window are very rarely accepted
 * — the reviewer either intentionally declined to act on them, or the asset
 * they target has drifted enough that the proposal is no longer relevant.
 * Auto-expiring them keeps the live queue focused on actionable work; the
 * archive preserves the full audit trail.
 *
 * Each expired proposal is archived with status `rejected` and reason
 * `"expired: no action within retention window"`. A `proposal_expired` event
 * is appended for each expired proposal so downstream observability (events
 * dashboards, source-acceptance-rate aggregations) can see expiry separately
 * from explicit rejections.
 *
 * Idempotent: a second call within the same retention window finds nothing
 * to expire (the archived entries are no longer in the pending queue).
 */
export function expireStaleProposals(stashDir: string, config: AkmConfig, ctx?: ProposalsContext): ExpireStaleResult {
  const t0 = Date.now();
  const retentionDays = config.archiveRetentionDays ?? 90;
  const expiredProposals: Array<{ id: string; ref: string; ageDays: number }> = [];

  // retentionDays === 0 disables TTL cleanup globally (mirrors how
  // consolidate.ts interprets the same config value).
  if (retentionDays <= 0) {
    return {
      checked: 0,
      expired: 0,
      durationMs: Date.now() - t0,
      retentionDays,
      expiredProposals,
    };
  }

  const retentionMs = retentionDays * MS_PER_DAY;
  const nowMs = (ctx?.now ?? Date.now)();
  const pending = listProposals(stashDir, { status: "pending" });

  for (const p of pending) {
    const createdMs = new Date(p.createdAt).getTime();
    if (!Number.isFinite(createdMs)) continue;
    const ageMs = nowMs - createdMs;
    if (ageMs < retentionMs) continue;

    try {
      archiveProposal(stashDir, p.id, "rejected", "expired: no action within retention window", ctx);
      const ageDays = Math.floor(ageMs / MS_PER_DAY);
      expiredProposals.push({ id: p.id, ref: p.ref, ageDays });
      appendEvent({
        eventType: "proposal_expired",
        ref: p.ref,
        metadata: {
          proposalId: p.id,
          source: p.source,
          ...(p.sourceRun !== undefined ? { sourceRun: p.sourceRun } : {}),
          ageDays,
          retentionDays,
        },
      });
    } catch (err) {
      // Best-effort — a single failure must not block the pass.
      warn(
        `[proposals] expireStaleProposals: failed to expire ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    checked: pending.length,
    expired: expiredProposals.length,
    durationMs: Date.now() - t0,
    retentionDays,
    expiredProposals,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface ProposalValidationFinding {
  kind: string;
  message: string;
  /** "warn" findings are surfaced but do not block proposal acceptance. Defaults to error-level when absent. */
  severity?: "warn";
}

export interface ProposalValidationReport {
  ok: boolean;
  findings: ProposalValidationFinding[];
}

/**
 * Validate a proposal payload before promotion. Generic by default — any
 * proposal must parse cleanly and carry a non-empty body. Lessons get the
 * extra per-type lint from {@link lintLessonContent} so the contract documented
 * in v1 spec §13 is enforced at promotion time. Other asset types can hook
 * here in the future without changing call sites.
 */
export function validateProposal(proposal: Proposal): ProposalValidationReport {
  return runProposalValidators(proposal);
}

// ── Promotion ──────────────────────────────────────────────────────────────

export interface PromoteResult {
  proposal: Proposal;
  /** Where the asset was written. */
  assetPath: string;
  /** Normalised asset ref. */
  ref: string;
}

/**
 * Validate a proposal, then promote it through the canonical
 * {@link writeAssetToSource} dispatch (the single place that branches on
 * `source.kind`). On success the proposal directory is moved to the archive
 * with status `accepted`. Validation failures throw a `UsageError` carrying
 * every finding so the CLI can render a single clear error envelope.
 *
 * Phase 6C: when the target asset already exists at the resolved write path,
 * a snapshot of the prior content is captured under
 * `<proposalsRoot>/<id>/backup.<ext>` BEFORE the write. The relative path is
 * recorded on the proposal record (`backup` field) so `akm proposal revert`
 * can restore the prior content. Genuinely-new assets carry no backup.
 */
export async function promoteProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string } = {},
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  const proposal = getProposal(stashDir, id);
  if (proposal.status !== "pending") {
    throw new UsageError(
      `Proposal ${id} is not pending (current status: ${proposal.status}). Only pending proposals can be accepted.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const report = validateProposal(proposal);
  if (!report.ok) {
    const message = report.findings.map((f) => `[${f.kind}] ${f.message}`).join("\n");
    throw new UsageError(
      `Proposal ${id} failed validation:\n${message}`,
      "MISSING_REQUIRED_ARGUMENT",
      "Fix the proposal payload (frontmatter / content) and try again, or reject the proposal with a reason.",
    );
  }

  const ref = parseAssetRef(proposal.ref);
  if (!TYPE_DIRS[ref.type]) {
    throw new UsageError(`Proposal ${id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }

  const target = resolveWriteTarget(config, options.target);

  // Phase 6C: capture a backup of the prior content (if any) BEFORE writing the
  // new asset. We use the resolved write target to compute the exact path the
  // asset would land at — same resolver `writeAssetToSource` uses — so the
  // backup always mirrors what would be overwritten.
  let backupRelPath: string | undefined;
  try {
    const targetFilePath = resolveAssetFilePathSafe(target.source, ref);
    if (targetFilePath && fs.existsSync(targetFilePath)) {
      const ext = path.extname(targetFilePath) || ".md";
      const proposalRoot = proposalDir(stashDir, id, false);
      // Store relative path on the proposal record so the directory remains
      // portable if the stash is moved.
      const backupFilename = `backup${ext}`;
      const backupAbsPath = path.join(proposalRoot, backupFilename);
      fs.mkdirSync(proposalRoot, { recursive: true });
      // Use copyFileSync — file-system atomicity is sufficient here because the
      // backup is single-file and never read concurrently with this write.
      fs.copyFileSync(targetFilePath, backupAbsPath);
      backupRelPath = backupFilename;
    }
  } catch (err) {
    // Backup capture is best-effort. A failure here must not block promotion
    // (the user explicitly asked to accept); we surface a warning so the
    // missing-revert path is visible.
    warn(
      `[proposals] promoteProposal: failed to capture backup for ${id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const written = await writeAssetToSource(target.source, target.config, ref, proposal.payload.content);
  // 0.9.0 (issue #507): single batch commit at the write boundary for git
  // targets. No-op for filesystem/primary-stash targets.
  commitWriteTargetBoundary(target, `Update ${formatRefForMessage(ref)}`);

  const archived = archiveProposal(stashDir, id, "accepted", undefined, ctx);

  // Persist the backup path on the archived proposal record. archiveProposal
  // moves the proposal dir into the archive subtree, so the backup file moves
  // with it (the relative path stays valid).
  if (backupRelPath) {
    const archivedFile = proposalFile(stashDir, id, true);
    const withBackup: Proposal = { ...archived, backup: backupRelPath };
    writeProposalFile(archivedFile, withBackup);
    return { proposal: withBackup, assetPath: written.path, ref: written.ref };
  }

  return { proposal: archived, assetPath: written.path, ref: written.ref };
}

// ── Reversion (Phase 6C) ────────────────────────────────────────────────────

/** Result of {@link revertProposal} (Advantage D6c / Phase 6C). */
export interface RevertResult {
  /** Updated proposal record with status === `"reverted"`. */
  proposal: Proposal;
  /** Path on disk that was restored from backup. */
  assetPath: string;
  /** Asset ref the revert acted on (re-serialized for the CLI envelope). */
  ref: string;
}

/**
 * Restore the prior content of an accepted proposal from its captured backup
 * (Advantage D6c / Phase 6C).
 *
 * Pre-conditions:
 *   - `id` resolves to a proposal with `status === "accepted"`.
 *   - The proposal carries a `backup` field pointing to a readable file under
 *     the proposal directory.
 *
 * On success:
 *   - The backup content is written back through {@link writeAssetToSource},
 *     so the canonical write-dispatch invariant is preserved.
 *   - The archived proposal record is updated to `status: "reverted"`.
 *   - Caller emits a `proposal_reverted` event in the CLI layer (mirrors how
 *     `promoted` / `rejected` are emitted by the CLI command, not the core).
 *
 * Errors are thrown as `UsageError` / `NotFoundError` so the CLI can map them
 * cleanly to exit codes — see `src/commands/proposal.ts` for the wrapper.
 */
export async function revertProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string } = {},
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  const proposal = getProposal(stashDir, id);
  if (proposal.status !== "accepted") {
    throw new UsageError(
      `only accepted proposals can be reverted (proposal ${id} status: ${proposal.status})`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (!proposal.backup) {
    throw new UsageError(
      `no backup available for this proposal (id: ${id})`,
      "MISSING_REQUIRED_ARGUMENT",
      "Backups are only captured when a proposal overwrites an existing asset — new-asset proposals cannot be reverted via this path; delete the asset directly instead.",
    );
  }

  // The proposal directory has been moved to the archive subtree (archiveProposal
  // runs at the end of promoteProposal). Reads must resolve against that path.
  const proposalRoot = proposalDir(stashDir, id, true);
  const backupAbsPath = path.join(proposalRoot, proposal.backup);
  if (!fs.existsSync(backupAbsPath)) {
    throw new NotFoundError(
      `no backup available for this proposal (id: ${id})`,
      "FILE_NOT_FOUND",
      `Expected backup file at ${backupAbsPath}; it may have been removed manually.`,
    );
  }

  const backupContent = fs.readFileSync(backupAbsPath, "utf8");
  const ref = parseAssetRef(proposal.ref);
  if (!TYPE_DIRS[ref.type]) {
    throw new UsageError(`Proposal ${id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }

  const target = resolveWriteTarget(config, options.target);
  const written = await writeAssetToSource(target.source, target.config, ref, backupContent);
  // 0.9.0 (issue #507): single batch commit at the write boundary for git
  // targets. No-op for filesystem/primary-stash targets.
  commitWriteTargetBoundary(target, `Revert ${formatRefForMessage(ref)}`);

  // Update the archived proposal record to status: "reverted" and bump
  // updatedAt + review so the audit trail reflects the second decision.
  const archivedFile = proposalFile(stashDir, id, true);
  const now = nowIso(ctx);
  const reverted: Proposal = {
    ...proposal,
    status: "reverted",
    updatedAt: now,
    review: {
      outcome: "rejected",
      reason: "reverted: prior content restored from backup",
      decidedAt: now,
    },
  };
  writeProposalFile(archivedFile, reverted);

  return { proposal: reverted, assetPath: written.path, ref: written.ref };
}

// ── Diff helpers ────────────────────────────────────────────────────────────

export interface ProposalDiff {
  /** Existing asset content if one is currently materialised. */
  existing: string | null;
  /** Proposed content (always present). */
  proposed: string;
  /** Unified diff text — empty when `existing === proposed`. */
  unified: string;
  /** When true, no asset exists yet at the target ref. */
  isNew: boolean;
  /** Path the diff would write to (if accepted). */
  targetPath?: string;
}

/**
 * Compute a diff between a proposal payload and the existing on-disk asset.
 * Uses {@link resolveWriteTarget} to find where the asset would land — so the
 * diff matches exactly what `accept` will write. Falls back to "new asset"
 * when no asset is currently materialised at the target ref.
 */
export function diffProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string } = {},
): ProposalDiff {
  const proposal = getProposal(stashDir, id);
  const ref = parseAssetRef(proposal.ref);

  let targetPath: string | undefined;
  let existing: string | null = null;
  try {
    const target = resolveWriteTarget(config, options.target);
    targetPath = resolveAssetFilePathSafe(target.source, ref);
    if (targetPath && fs.existsSync(targetPath)) {
      existing = fs.readFileSync(targetPath, "utf8");
    }
  } catch {
    // No writable target configured — still return a "new asset" diff so
    // callers can see the proposed payload without erroring out.
  }

  const proposed = proposal.payload.content;
  if (existing === null) {
    return {
      existing: null,
      proposed,
      unified: formatNewAssetDiff(proposal.ref, proposed),
      isNew: true,
      ...(targetPath ? { targetPath } : {}),
    };
  }

  return {
    existing,
    proposed,
    unified: formatUnifiedDiff(existing, proposed, proposal.ref),
    isNew: false,
    ...(targetPath ? { targetPath } : {}),
  };
}

function resolveAssetFilePathSafe(source: WriteTargetSource, ref: AssetRef): string | undefined {
  const typeDir = TYPE_DIRS[ref.type];
  if (!typeDir) return undefined;
  const typeRoot = path.join(source.path, typeDir);
  try {
    return resolveAssetPathFromName(ref.type, typeRoot, ref.name);
  } catch {
    return undefined;
  }
}

/**
 * Minimal unified-diff renderer. We deliberately avoid pulling a runtime
 * dependency just for this — proposals diffs are usually small (a single
 * lesson / skill file), so the LCS-free greedy renderer below is plenty for
 * humans to review. The output mirrors `git diff --no-index` for the first
 * `@@ … @@` hunk: enough to be familiar, not so detailed that we re-implement
 * a full LCS table.
 */
export function formatUnifiedDiff(left: string, right: string, label: string): string {
  if (left === right) return "";
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const lines: string[] = [`--- ${label} (existing)`, `+++ ${label} (proposed)`];

  // Pad to the longer side so alignment is one-to-one. Real diff tools use
  // LCS to align matching runs; we don't need that fidelity for a review
  // surface — both halves are visible regardless.
  const max = Math.max(leftLines.length, rightLines.length);
  lines.push(`@@ 1,${leftLines.length} 1,${rightLines.length} @@`);
  for (let i = 0; i < max; i += 1) {
    const l = leftLines[i];
    const r = rightLines[i];
    if (l === r && l !== undefined) {
      lines.push(` ${l}`);
      continue;
    }
    if (l !== undefined) lines.push(`-${l}`);
    if (r !== undefined) lines.push(`+${r}`);
  }
  return lines.join("\n");
}

function formatNewAssetDiff(ref: string, content: string): string {
  const lines = [`--- /dev/null`, `+++ ${ref} (proposed, new asset)`];
  lines.push(`@@ 0,0 1,${content.split("\n").length} @@`);
  for (const line of content.split("\n")) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}
