// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `proposals` table. Extracted verbatim from
 * core/state-db.ts — queries and row-mapping unchanged, only relocated behind
 * the repository boundary. Re-exported by core/state-db.ts so existing importers
 * resolve.
 *
 * @module proposals-repository
 */

import path from "node:path";
import type { Proposal, ProposalGateDecisionOutcome } from "../../commands/proposal/proposal-types";
import { stashDirFor } from "../../core/asset/asset-placement";
import { bundleRefToString, isBundleSlug, parseBundleRef } from "../../core/asset/asset-ref";
import type { FileChange } from "../../core/file-change";
import { warnOnce } from "../../core/warn";
import type { Database, SqlValue } from "../database";
import { escapeLikePattern } from "../like-pattern";

/**
 * Persisted shape of one `FileChange` inside `metadata_json.changes`.
 *
 * `before` is never persisted (transaction-time capture only), and the FIRST
 * entry's `after` is implied by the dedicated `content` column — storing it
 * again would double every row. Non-primary entries (multi-file proposals)
 * carry their own `after`.
 */
interface StoredFileChange {
  path: string;
  op: FileChange["op"];
  after?: string;
}

/** Serialize `Proposal.changes` for `metadata_json` (see {@link StoredFileChange}). */
function changesToStored(changes: FileChange[]): StoredFileChange[] {
  return changes.map((c, i) => ({
    path: c.path,
    op: c.op,
    ...(i > 0 && c.after !== undefined ? { after: c.after } : {}),
  }));
}

/**
 * Reconstruct `Proposal.changes` from `metadata_json.changes` + the `content`
 * column.
 *
 * Read-time compatibility shim (#858/#859): proposals created before this
 * field existed have no `changes` key in `metadata_json` at all (~89% of the
 * archived accepted/rejected rows on real installs) and that history cannot
 * be reconstructed from `content` alone. Treat a completely absent `changes`
 * key as a known legacy gap — return an empty change list rather than
 * throwing — so these rows still round-trip as real proposals (and count
 * toward accepted/rejected totals) instead of being dropped or crashing
 * every reader. A `changes` value that *is* present but malformed (wrong
 * type, invalid entries) is still corruption and throws, same as before; the
 * write path (`proposalToRowValues`) still refuses to persist an empty or
 * missing change list for new proposals, so this leniency only ever applies
 * to pre-existing rows.
 */
function storedToChanges(stored: unknown, content: string): FileChange[] {
  if (stored === undefined) {
    return [];
  }
  if (!Array.isArray(stored) || stored.length === 0) {
    throw new Error("Proposal metadata is missing changes.");
  }
  return stored.map((value, i) => {
    if (typeof value !== "object" || value === null) throw new Error("Proposal metadata has invalid changes.");
    const c = value as { path?: unknown; op?: unknown; after?: unknown };
    if (
      typeof c.path !== "string" ||
      (c.op !== "create" && c.op !== "update" && c.op !== "delete") ||
      (c.after !== undefined && typeof c.after !== "string") ||
      (c.op === "delete" && c.after !== undefined) ||
      (i > 0 && c.op !== "delete" && typeof c.after !== "string")
    ) {
      throw new Error("Proposal metadata has invalid changes.");
    }
    return {
      path: c.path,
      op: c.op,
      ...(i === 0 ? (c.op === "delete" ? {} : { after: content }) : c.after !== undefined ? { after: c.after } : {}),
    };
  });
}

function currentProposalRef(ref: string, requireQualified = false): string {
  let parsed: ReturnType<typeof parseBundleRef>;
  try {
    parsed = parseBundleRef(ref);
  } catch (error) {
    throw new Error(`Proposal row has an invalid current ref: ${ref}`, { cause: error });
  }
  const colon = parsed.conceptId.indexOf(":");
  if (colon > 0 && stashDirFor(parsed.conceptId.slice(0, colon)) !== undefined) {
    throw new Error(`Proposal row has an invalid current ref: ${ref}`);
  }
  if (parsed.fragment !== undefined) throw new Error(`Proposal row ref contains a fragment: ${ref}`);
  if (requireQualified && parsed.bundle === undefined) throw new Error(`Proposal ref is not bundle-qualified: ${ref}`);
  const canonical = bundleRefToString(parsed);
  if (canonical !== ref) throw new Error(`Proposal row ref is not canonical: ${ref}`);
  return canonical;
}

function currentProposalTarget(value: unknown): NonNullable<Proposal["proposedTarget"]> {
  if (typeof value !== "object" || value === null) throw new Error("Proposal metadata has an invalid proposedTarget.");
  const target = value as { source?: unknown; root?: unknown };
  if (
    typeof target.source !== "string" ||
    !isBundleSlug(target.source) ||
    typeof target.root !== "string" ||
    !path.isAbsolute(target.root)
  ) {
    throw new Error("Proposal metadata has an invalid proposedTarget.");
  }
  return { source: target.source, root: path.resolve(target.root) };
}

function invalidPresentField(name: string): never {
  throw new Error(`Proposal metadata has an invalid ${name}.`);
}

const GATE_OUTCOMES: Record<ProposalGateDecisionOutcome, true> = {
  "auto-accepted": true,
  deferred: true,
  staged: true,
  "auto-rejected": true,
};

function validatePresentMetadata(meta: Record<string, unknown>): void {
  const stringFields = ["sourceRun", "beforeHash", "beforeHashNormalized", "backupContent"] as const;
  for (const field of stringFields) {
    if (Object.hasOwn(meta, field) && typeof meta[field] !== "string") invalidPresentField(field);
  }
  if (
    Object.hasOwn(meta, "confidence") &&
    (typeof meta.confidence !== "number" ||
      !Number.isFinite(meta.confidence) ||
      meta.confidence < 0 ||
      meta.confidence > 1)
  ) {
    invalidPresentField("confidence");
  }
  if (Object.hasOwn(meta, "review")) {
    const review = meta.review as Record<string, unknown> | null;
    if (
      typeof review !== "object" ||
      review === null ||
      (review.outcome !== "accepted" && review.outcome !== "rejected") ||
      typeof review.decidedAt !== "string" ||
      (review.reason !== undefined && typeof review.reason !== "string")
    ) {
      invalidPresentField("review");
    }
  }
  if (Object.hasOwn(meta, "gateDecision")) {
    const gate = meta.gateDecision as Record<string, unknown> | null;
    if (
      typeof gate !== "object" ||
      gate === null ||
      typeof gate.outcome !== "string" ||
      !Object.hasOwn(GATE_OUTCOMES, gate.outcome) ||
      typeof gate.reason !== "string" ||
      typeof gate.decidedAt !== "string" ||
      (gate.measured !== undefined && (typeof gate.measured !== "number" || !Number.isFinite(gate.measured))) ||
      (gate.contentHash !== undefined && typeof gate.contentHash !== "string") ||
      (gate.gate !== undefined && typeof gate.gate !== "string")
    ) {
      invalidPresentField("gateDecision");
    }
    if (gate.thresholds !== undefined) {
      const thresholds = gate.thresholds as Record<string, unknown> | null;
      if (
        typeof thresholds !== "object" ||
        thresholds === null ||
        [thresholds.maxDiffLines, thresholds.minContentLines].some(
          (value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value)),
        )
      ) {
        invalidPresentField("gateDecision");
      }
    }
  }
  if (Object.hasOwn(meta, "acceptedTarget")) {
    const target = meta.acceptedTarget as Record<string, unknown> | null;
    if (
      typeof target !== "object" ||
      target === null ||
      typeof target.source !== "string" ||
      !isBundleSlug(target.source) ||
      typeof target.root !== "string" ||
      !path.isAbsolute(target.root) ||
      typeof target.path !== "string" ||
      !path.isAbsolute(target.path) ||
      typeof target.contentHash !== "string"
    ) {
      invalidPresentField("acceptedTarget");
    }
  }
  if (Object.hasOwn(meta, "eligibilitySource") && typeof meta.eligibilitySource !== "string") {
    invalidPresentField("eligibilitySource");
  }
}

/**
 * Raw SQLite row shape for the `proposals` table.
 *
 * Maps to the public {@link Proposal} interface from src/commands/proposal/repository.ts.
 * Fields without dedicated columns, including durable revert ownership state,
 * are stored in `metadata_json`; callers that need them should
 * `JSON.parse(row.metadata_json)` (or use {@link proposalRowToProposal}).
 */
export interface ProposalRow {
  id: string;
  stash_dir: string;
  ref: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
  content: string;
  frontmatter_json: string | null;
  metadata_json: string;
}

/**
 * Convert a raw `ProposalRow` to the public `Proposal` shape.
 */
export function proposalRowToProposal(row: ProposalRow): Proposal {
  if (!["pending", "accepted", "rejected", "reverted"].includes(row.status)) {
    throw new Error(`Proposal row has invalid status: ${row.status}`);
  }
  let frontmatter: Record<string, unknown> | undefined;
  if (row.frontmatter_json !== null) {
    try {
      const parsed: unknown = JSON.parse(row.frontmatter_json);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Proposal frontmatter_json must contain an object.");
      }
      frontmatter = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error("Proposal row has invalid frontmatter_json.", { cause: error });
    }
  }

  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata_json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Proposal metadata_json must contain an object.");
    }
    meta = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error("Proposal row has invalid metadata_json.", { cause: error });
  }
  validatePresentMetadata(meta);

  const changes = storedToChanges(meta.changes, row.content);
  // #859: absent proposedTarget (~93% of the real archive's accepted/rejected
  // rows) is envelope metadata that predates this field, not corruption — an
  // already-decided proposal is counted/displayed, never re-applied, so
  // decode tolerates its absence the same way it already tolerates absent
  // `changes`. A *present but malformed* value is still corruption and
  // throws via currentProposalTarget, same as before.
  const proposedTarget = meta.proposedTarget !== undefined ? currentProposalTarget(meta.proposedTarget) : undefined;
  return {
    id: row.id,
    ref: currentProposalRef(row.ref),
    status: row.status as Proposal["status"],
    source: row.source,
    ...(typeof meta.sourceRun === "string" ? { sourceRun: meta.sourceRun } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payload: {
      content: row.content,
      ...(frontmatter !== undefined ? { frontmatter } : {}),
    },
    changes,
    ...(proposedTarget !== undefined ? { proposedTarget } : {}),
    ...(typeof meta.beforeHash === "string" ? { beforeHash: meta.beforeHash } : {}),
    ...(typeof meta.beforeHashNormalized === "string" ? { beforeHashNormalized: meta.beforeHashNormalized } : {}),
    ...(meta.review !== undefined ? { review: meta.review as Proposal["review"] } : {}),
    ...(typeof meta.confidence === "number" ? { confidence: meta.confidence } : {}),
    ...(meta.gateDecision !== undefined ? { gateDecision: meta.gateDecision as Proposal["gateDecision"] } : {}),
    ...(typeof meta.backupContent === "string" ? { backupContent: meta.backupContent } : {}),
    ...(meta.acceptedTarget !== undefined ? { acceptedTarget: meta.acceptedTarget as Proposal["acceptedTarget"] } : {}),
    ...(typeof meta.eligibilitySource === "string"
      ? { eligibilitySource: meta.eligibilitySource as Proposal["eligibilitySource"] }
      : {}),
  };
}

/**
 * Convert a public `Proposal` to column values ready for an INSERT/UPDATE.
 * The `stash_dir` comes from the call site (proposals.ts has it in scope).
 */
export function proposalToRowValues(proposal: Proposal, stashDir: string): Omit<ProposalRow, "id"> & { id: string } {
  // Fields that have no dedicated column live in metadata_json.
  const metaObj: Record<string, unknown> = {};
  // #859: `changes` and `proposedTarget` are only enforced as REQUIRED when
  // minting/updating a `pending` proposal — the one status createProposal
  // ever writes, and the one status every real accept/reject transition
  // writes FROM (a pending row always carries the full envelope; see
  // storedToChanges / currentProposalTarget doc comments). Writing a
  // non-pending status (accepted/rejected/reverted) is always a status
  // TRANSITION of an already-persisted proposal, spread-copied from the row
  // this same repository just decoded — for a legacy archived row that
  // never had `changes`/`proposedTarget` to begin with (the pre-envelope
  // shape), re-persisting it unchanged (e.g. `proposal revert` on an old
  // accepted row) must not be blocked by a requirement the row never met.
  // This does NOT weaken validation of a genuinely new proposal: every
  // pending-status write still requires the full envelope, exactly as
  // before.
  if (proposal.status === "pending") {
    if (!Array.isArray(proposal.changes) || proposal.changes.length === 0) {
      throw new Error(`Proposal ${proposal.id} has no file changes.`);
    }
    if (proposal.proposedTarget === undefined) {
      throw new Error(`Proposal ${proposal.id} is missing proposedTarget.`);
    }
  }
  if (
    proposal.changes.some(
      (change) =>
        typeof change.path !== "string" ||
        change.path.length === 0 ||
        !["create", "update", "delete"].includes(change.op) ||
        (change.op === "delete" ? change.after !== undefined : typeof change.after !== "string"),
    )
  ) {
    throw new Error(`Proposal ${proposal.id} has invalid file changes.`);
  }
  metaObj.changes = changesToStored(proposal.changes);
  if (proposal.proposedTarget !== undefined) metaObj.proposedTarget = currentProposalTarget(proposal.proposedTarget);
  if (proposal.beforeHash !== undefined) metaObj.beforeHash = proposal.beforeHash;
  if (proposal.beforeHashNormalized !== undefined) metaObj.beforeHashNormalized = proposal.beforeHashNormalized;
  if (proposal.sourceRun !== undefined) metaObj.sourceRun = proposal.sourceRun;
  if (proposal.review !== undefined) metaObj.review = proposal.review;
  if (proposal.confidence !== undefined) metaObj.confidence = proposal.confidence;
  if (proposal.gateDecision !== undefined) metaObj.gateDecision = proposal.gateDecision;
  if (proposal.backupContent !== undefined) metaObj.backupContent = proposal.backupContent;
  if (proposal.acceptedTarget !== undefined) metaObj.acceptedTarget = proposal.acceptedTarget;
  if (proposal.eligibilitySource !== undefined) metaObj.eligibilitySource = proposal.eligibilitySource;
  validatePresentMetadata(metaObj);

  return {
    id: proposal.id,
    stash_dir: stashDir,
    ref: currentProposalRef(proposal.ref, true),
    status: proposal.status,
    source: proposal.source,
    created_at: proposal.createdAt,
    updated_at: proposal.updatedAt,
    content: proposal.payload.content,
    frontmatter_json: proposal.payload.frontmatter ? JSON.stringify(proposal.payload.frontmatter) : null,
    metadata_json: JSON.stringify(metaObj),
  };
}

/**
 * Upsert a proposal row. Called by the proposal write path when state.db is
 * the active backend.
 */
export function upsertProposal(db: Database, proposal: Proposal, stashDir: string): void {
  const v = proposalToRowValues(proposal, stashDir);
  db.prepare(`
    INSERT INTO proposals
      (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      stash_dir        = excluded.stash_dir,
      ref              = excluded.ref,
      status           = excluded.status,
      source           = excluded.source,
      updated_at       = excluded.updated_at,
      content          = excluded.content,
      frontmatter_json = excluded.frontmatter_json,
      metadata_json    = excluded.metadata_json
  `).run(
    v.id,
    v.stash_dir,
    v.ref,
    v.status,
    v.source,
    v.created_at,
    v.updated_at,
    v.content,
    v.frontmatter_json,
    v.metadata_json,
  );
}

/**
 * List proposals, optionally filtered by stashDir, status, and/or ref.
 *
 * Results are ordered by `created_at ASC` (matching the historical
 * `listProposals()` sort), with `rowid` as a deterministic tiebreak so two
 * proposals created in the same millisecond list in insertion order.
 */
export function listStateProposals(
  db: Database,
  options: { stashDir?: string; status?: string; ref?: string } = {},
): Proposal[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.stashDir) {
    conditions.push("stash_dir = ?");
    params.push(options.stashDir);
  }
  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }
  if (options.ref) {
    conditions.push("ref = ?");
    params.push(options.ref);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT id, stash_dir, ref, status, source, created_at, updated_at,
              content, frontmatter_json, metadata_json
       FROM proposals ${where} ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...(params as SqlValue[])) as ProposalRow[];
  // Per-row skip-and-warn (#858/#859): a single row that fails to parse
  // (invalid ref/status/metadata shape — genuine corruption, distinct from
  // the tolerated legacy-missing-`changes` case in `storedToChanges` above)
  // must not abort the entire list. Every caller of this function reads a
  // multi-row archive; one bad row hiding the rest behind a thrown error is
  // strictly worse than surfacing the well-formed rows plus a warning.
  const proposals: Proposal[] = [];
  for (const row of rows) {
    try {
      proposals.push(proposalRowToProposal(row));
    } catch (error) {
      // Once per row per process (#898): health alone reads this table several
      // times per invocation.
      const message = error instanceof Error ? error.message : String(error);
      warnOnce(
        `unparseable-proposal-row:${row.id}`,
        `[akm] Skipping unparseable proposal row (id=${row.id}, ref=${row.ref}): ${message}`,
      );
    }
  }
  return proposals;
}

/**
 * Look up a single proposal by id, optionally scoped to one stash root.
 * Returns undefined when not found.
 */
export function getStateProposal(db: Database, id: string, stashDir?: string): Proposal | undefined {
  const sql = `SELECT id, stash_dir, ref, status, source, created_at, updated_at,
              content, frontmatter_json, metadata_json
       FROM proposals WHERE id = ?${stashDir ? " AND stash_dir = ?" : ""}`;
  const row = (stashDir ? db.prepare(sql).get(id, stashDir) : db.prepare(sql).get(id)) as ProposalRow | undefined;
  return row ? proposalRowToProposal(row) : undefined;
}

/**
 * Find PENDING proposal ids in one stash whose id starts with `idPrefix`.
 * Backs the UUID-prefix form of `akm proposal show/accept/... <prefix>` —
 * prefix resolution is deliberately scoped to the live (pending) queue,
 * mirroring the historical behaviour of scanning only the live directory.
 *
 * `%` / `_` / `\` in the prefix are escaped so the LIKE pattern is literal.
 */
export function listStateProposalIdsByPrefix(db: Database, stashDir: string, idPrefix: string): string[] {
  const escaped = escapeLikePattern(idPrefix);
  const rows = db
    .prepare(
      `SELECT id FROM proposals
       WHERE stash_dir = ? AND status = 'pending' AND id LIKE ? ESCAPE '\\'
       ORDER BY id ASC`,
    )
    .all(stashDir, `${escaped}%`) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
