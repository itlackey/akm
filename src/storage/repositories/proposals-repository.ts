// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `proposals` table (and its `proposal_fs_imports`
 * companion ledger). Extracted verbatim from core/state-db.ts — queries and
 * row-mapping unchanged, only relocated behind the repository boundary.
 * Re-exported by core/state-db.ts so existing importers resolve.
 *
 * @module proposals-repository
 */

import type { Proposal } from "../../commands/proposal/proposal-types";
import type { FileChange } from "../../core/file-change";
import type { Database, SqlValue } from "../database";

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
 * column. Legacy rows (persisted before the envelope existed) synthesize one
 * `update` entry with an empty `path` sentinel (resolve from the ref instead).
 */
function storedToChanges(stored: unknown, content: string): FileChange[] {
  if (!Array.isArray(stored) || stored.length === 0) {
    return [{ path: "", after: content, op: "update" }];
  }
  return (stored as StoredFileChange[]).map((c, i) => ({
    path: typeof c.path === "string" ? c.path : "",
    op: c.op === "create" || c.op === "delete" ? c.op : "update",
    ...(i === 0 ? (c.op === "delete" ? {} : { after: content }) : c.after !== undefined ? { after: c.after } : {}),
  }));
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
  let frontmatter: Record<string, unknown> | undefined;
  if (row.frontmatter_json) {
    try {
      frontmatter = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
    } catch {
      /* ignore corrupt frontmatter JSON */
    }
  }

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
  } catch {
    /* ignore */
  }

  return {
    id: row.id,
    ref: row.ref,
    status: row.status as Proposal["status"],
    source: row.source,
    ...(typeof meta.sourceRun === "string" ? { sourceRun: meta.sourceRun } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payload: {
      content: row.content,
      ...(frontmatter !== undefined ? { frontmatter } : {}),
    },
    changes: storedToChanges(meta.changes, row.content),
    ...(typeof meta.beforeHash === "string" ? { beforeHash: meta.beforeHash } : {}),
    ...(meta.review !== undefined ? { review: meta.review as Proposal["review"] } : {}),
    ...(typeof meta.confidence === "number" ? { confidence: meta.confidence } : {}),
    ...(meta.gateDecision !== undefined ? { gateDecision: meta.gateDecision as Proposal["gateDecision"] } : {}),
    ...(typeof meta.backupContent === "string" ? { backupContent: meta.backupContent } : {}),
    ...(typeof meta.acceptedContentHash === "string" ? { acceptedContentHash: meta.acceptedContentHash } : {}),
    ...(meta.acceptedTarget !== undefined ? { acceptedTarget: meta.acceptedTarget as Proposal["acceptedTarget"] } : {}),
    ...(meta.legacyAcceptedTargetDerived === true ? { legacyAcceptedTargetDerived: true } : {}),
    ...(meta.legacyAcceptedAssetWasAbsent === true ? { legacyAcceptedAssetWasAbsent: true } : {}),
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
  // Legacy filesystem proposal.json objects (pre-envelope, imported by
  // legacy-import.ts) reach this mapper without `changes` at runtime despite
  // the type — or, if hand-edited, with a malformed value. Synthesize the
  // same sentinel entry the read path uses rather than letting one corrupt
  // legacy file abort a whole import batch.
  const safeChanges = Array.isArray(proposal.changes)
    ? proposal.changes.filter((c): c is FileChange => typeof c === "object" && c !== null)
    : undefined;
  metaObj.changes = changesToStored(
    safeChanges && safeChanges.length > 0 ? safeChanges : [{ path: "", after: proposal.payload.content, op: "update" }],
  );
  if (proposal.beforeHash !== undefined) metaObj.beforeHash = proposal.beforeHash;
  if (proposal.sourceRun !== undefined) metaObj.sourceRun = proposal.sourceRun;
  if (proposal.review !== undefined) metaObj.review = proposal.review;
  if (proposal.confidence !== undefined) metaObj.confidence = proposal.confidence;
  if (proposal.gateDecision !== undefined) metaObj.gateDecision = proposal.gateDecision;
  if (proposal.backupContent !== undefined) metaObj.backupContent = proposal.backupContent;
  if (proposal.acceptedContentHash !== undefined) metaObj.acceptedContentHash = proposal.acceptedContentHash;
  if (proposal.acceptedTarget !== undefined) metaObj.acceptedTarget = proposal.acceptedTarget;
  if (proposal.legacyAcceptedTargetDerived !== undefined) {
    metaObj.legacyAcceptedTargetDerived = proposal.legacyAcceptedTargetDerived;
  }
  if (proposal.legacyAcceptedAssetWasAbsent !== undefined) {
    metaObj.legacyAcceptedAssetWasAbsent = proposal.legacyAcceptedAssetWasAbsent;
  }
  if (proposal.eligibilitySource !== undefined) metaObj.eligibilitySource = proposal.eligibilitySource;

  return {
    id: proposal.id,
    stash_dir: stashDir,
    ref: proposal.ref,
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
  return rows.map(proposalRowToProposal);
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
  const escaped = idPrefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const rows = db
    .prepare(
      `SELECT id FROM proposals
       WHERE stash_dir = ? AND status = 'pending' AND id LIKE ? ESCAPE '\\'
       ORDER BY id ASC`,
    )
    .all(stashDir, `${escaped}%`) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Whether the legacy filesystem proposal import has already run for `stashDir`.
 * See migration 005 (`proposal_fs_imports`).
 */
export function hasImportedFsProposals(db: Database, stashDir: string): boolean {
  // Drivers disagree on the no-row sentinel (bun:sqlite → null,
  // better-sqlite3 → undefined) — Boolean() covers both.
  return Boolean(db.prepare("SELECT 1 FROM proposal_fs_imports WHERE stash_dir = ?").get(stashDir));
}

/**
 * Record that the legacy filesystem proposal import completed for `stashDir`
 * so subsequent invocations skip the directory walk. INSERT OR REPLACE keeps
 * the call idempotent.
 */
export function recordFsProposalsImport(db: Database, stashDir: string, importedCount: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO proposal_fs_imports (stash_dir, imported_at, imported_count) VALUES (?, ?, ?)",
  ).run(stashDir, new Date().toISOString(), importedCount);
}

/**
 * Insert a proposal row ONLY when the id is not already present (used by the
 * legacy filesystem import so re-runs never clobber rows that have since been
 * mutated through the canonical store). Returns true when a row was inserted.
 */
export function insertProposalIfAbsent(db: Database, proposal: Proposal, stashDir: string): boolean {
  const v = proposalToRowValues(proposal, stashDir);
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO proposals
        (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
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
  const changes = (result as { changes?: number | bigint }).changes ?? 0;
  return Number(changes) > 0;
}
