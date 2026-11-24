// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The stored state of the reference-compatibility corpus: the rows a 0.10 install wrote into `state.db` before the
 * adapter refactor, with every ref in the spelling that release stored.
 *
 * `seedState` runs ONLY inside `scripts/record-reference-compat.ts`, against a `state.db` the pre-refactor tree
 * created; it never runs against the tree under test. The result is frozen as `state.sql` (see `dumpState`), and the
 * test rebuilds `state.db` from that file, so every tree is handed the same rows in the same (old) schema and
 * migrates them itself.
 *
 * Absolute paths are written as the `@FIXTURE@` placeholder the harness replaces with the sandbox's fixture root.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const F = "@FIXTURE@";
const WHEN = "2026-01-30T10:00:00.000Z";

interface ProposalSeed {
  id: string;
  stashDir: string;
  ref: string;
  status: "pending" | "accepted" | "rejected" | "reverted";
  source: string;
  content: string;
  /** What `metadata_json` carries; an empty object is the pre-envelope shape. */
  meta: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
}

const hash = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
/** The raw content hash the proposal queue records: sha256 of the bytes, hex. */
const fileHash = (relative: string) =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(import.meta.dir, relative)))
    .digest("hex");

const NEW_NOTE = "---\ndescription: A new note\n---\n\nBrand new.\n";
const SHARED_UPDATE =
  "---\ndescription: Notes shared by the team bundle\ntags: [shared]\n---\n\n# Shared\n\nUpdated.\n";
const OLD_GUIDE_ACCEPTED = fs.readFileSync(path.join(import.meta.dir, "main/knowledge/old-guide.md"), "utf8");
const OLD_GUIDE_BACKUP =
  "---\ndescription: The previous guide\ntags: [guide]\n---\n\n# Old guide\n\nBefore the rewrite.\n";

const PROPOSALS: ProposalSeed[] = [
  {
    // Written before the envelope existed: `metadata_json` has none of changes, proposedTarget, beforeHash, ...
    id: "00000000-0000-4000-8000-000000000001",
    stashDir: `${F}/main`,
    ref: "main//knowledge/guide",
    status: "accepted",
    source: "reflect",
    content: "# Guide\n",
    meta: {},
  },
  {
    // A pending create: FileChange `path` and the bundle and root bound at mint.
    id: "00000000-0000-4000-8000-000000000002",
    stashDir: `${F}/main`,
    ref: "main//knowledge/new-note",
    status: "pending",
    source: "reflect",
    content: NEW_NOTE,
    meta: {
      changes: [{ path: "knowledge/new-note.md", op: "create" }],
      proposedTarget: { source: "main", root: `${F}/main` },
      confidence: 0.8,
    },
    frontmatter: { description: "A new note" },
  },
  {
    // A pending update of an asset in the second bundle.
    id: "00000000-0000-4000-8000-000000000003",
    stashDir: `${F}/team`,
    ref: "team//knowledge/shared",
    status: "pending",
    source: "feedback",
    content: SHARED_UPDATE,
    meta: {
      changes: [{ path: "knowledge/shared.md", op: "update" }],
      proposedTarget: { source: "team", root: `${F}/team` },
      beforeHash: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
    },
  },
  {
    // Accepted, with the bundle, root, file and hash the content went to, and the backup revert restores.
    id: "00000000-0000-4000-8000-000000000004",
    stashDir: `${F}/main`,
    ref: "main//knowledge/old-guide",
    status: "accepted",
    source: "reflect",
    content: OLD_GUIDE_ACCEPTED,
    meta: {
      changes: [{ path: "knowledge/old-guide.md", op: "update" }],
      proposedTarget: { source: "main", root: `${F}/main` },
      acceptedAt: "2026-01-28T09:00:00.000Z",
      review: { outcome: "accepted", decidedAt: "2026-01-28T09:00:00.000Z" },
      backupContent: OLD_GUIDE_BACKUP,
      acceptedTarget: {
        source: "main",
        root: `${F}/main`,
        path: `${F}/main/knowledge/old-guide.md`,
        contentHash: fileHash("main/knowledge/old-guide.md"),
      },
    },
  },
  {
    // An accepted retire: a delete change and the archive directory the retirement moved the memory into.
    id: "00000000-0000-4000-8000-000000000005",
    stashDir: `${F}/main`,
    ref: "main//memories/pruned-note",
    status: "accepted",
    source: "consolidate",
    content: "",
    meta: {
      changes: [{ path: "memories/pruned-note.md", op: "delete" }],
      proposedTarget: { source: "main", root: `${F}/main` },
      retirement: {
        retiredRef: "main//memories/pruned-note",
        successorRef: "main//memories/successor",
        cosine: 0.97,
        judgeLabel: "duplicate",
        judgeReason: "Same content.",
        retiredContentHash: hash(4),
        successorContentHash: hash(5),
        reason: "duplicate",
      },
      acceptedAt: "2026-01-29T09:00:00.000Z",
      review: { outcome: "accepted", decidedAt: "2026-01-29T09:00:00.000Z" },
      backupContent: "---\ndescription: A memory that was pruned\n---\n\nOld content.\n",
      acceptedTarget: {
        source: "main",
        root: `${F}/main`,
        path: `${F}/main/memories/pruned-note.md`,
        contentHash: hash(3),
      },
      retiredArchive: { dirs: [".akm/memory-cleanup/archive/2026-01-05T00-00-00-000Z-main-memories-pruned-note"] },
    },
  },
  {
    // Rejected, in the second bundle.
    id: "00000000-0000-4000-8000-000000000006",
    stashDir: `${F}/team`,
    ref: "team//knowledge/dup",
    status: "rejected",
    source: "reflect",
    content: "# Dup\n",
    meta: {
      changes: [{ path: "knowledge/dup.md", op: "update" }],
      proposedTarget: { source: "team", root: `${F}/team` },
      review: { outcome: "rejected", reason: "Not an improvement.", decidedAt: "2026-01-27T09:00:00.000Z" },
    },
  },
  {
    // A ref in the retired `<type>:<name>` spelling: read as written, never applied.
    id: "00000000-0000-4000-8000-000000000007",
    stashDir: `${F}/main`,
    ref: "main//knowledge:legacy-note",
    status: "rejected",
    source: "reflect",
    content: "# Legacy\n",
    meta: { review: { outcome: "rejected", decidedAt: "2026-01-26T09:00:00.000Z" } },
  },
];

export function seedState(db: Database): void {
  const insertProposal = db.prepare(
    `INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of PROPOSALS) {
    insertProposal.run(
      p.id,
      p.stashDir,
      p.ref,
      p.status,
      p.source,
      WHEN,
      WHEN,
      p.content,
      p.frontmatter ? JSON.stringify(p.frontmatter) : null,
      JSON.stringify(p.meta),
    );
  }

  // The improve ledger is keyed by (stash_dir, ref, source): one row per bundle root.
  const insertLedger = db.prepare(
    `INSERT INTO improve_ledger (stash_dir, ref, source, last_attempt_at, outcome, next_eligible_at, proposal_id, detail, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertLedger.run(
    `${F}/main`,
    "main//knowledge/guide",
    "reflect",
    WHEN,
    "rejected",
    "2099-01-01T00:00:00.000Z",
    "00000000-0000-4000-8000-000000000001",
    "rejected once",
    hash(10),
  );
  insertLedger.run(
    `${F}/main`,
    "main//knowledge/new-note",
    "reflect",
    WHEN,
    "pending",
    null,
    "00000000-0000-4000-8000-000000000002",
    null,
    null,
  );
  insertLedger.run(
    `${F}/team`,
    "team//knowledge/dup",
    "reflect",
    WHEN,
    "rejected",
    "2099-01-01T00:00:00.000Z",
    "00000000-0000-4000-8000-000000000006",
    "not an improvement",
    null,
  );

  const insertRun = db.prepare(
    `INSERT INTO improve_runs (id, started_at, completed_at, stash_dir, dry_run, profile, scope_mode, scope_value, guidance, ok, result_json, metrics_json, metadata_json, strategy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertRun.run(
    "run-0001",
    WHEN,
    WHEN,
    `${F}/main`,
    0,
    null,
    "all",
    null,
    null,
    1,
    JSON.stringify({ ok: true, proposals: 2 }),
    null,
    "{}",
    "default",
  );
  insertRun.run(
    "run-0002",
    WHEN,
    WHEN,
    `${F}/team`,
    1,
    null,
    "ref",
    "team//knowledge/shared",
    null,
    1,
    JSON.stringify({ ok: true, proposals: 0 }),
    null,
    "{}",
    "default",
  );

  // Learned state keyed by ref, including history stored under the outdated type-folder spelling.
  const insertSalience = db.prepare(
    "INSERT INTO asset_salience (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertOutcome = db.prepare(
    `INSERT INTO asset_outcome (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate, negative_feedback_count, accepted_change_count, outcome_score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const t = Date.parse(WHEN);
  for (const [ref, count] of [
    ["main//knowledge/guide", 7],
    ["team//knowledge/shared", 3],
    ["main//knowledge/reports/quarterly", 2],
  ] as const) {
    insertSalience.run(ref, 0.5, 0.25, 0.5, 0.5, 0, t);
    insertOutcome.run(ref, t, count, 0.1, 0, 1, 0.5, t);
  }

  // Usage and event history by ref.
  const insertUsage = db.prepare(
    "INSERT INTO usage_events (event_type, query, entry_id, entry_ref, signal, metadata, source, created_at) VALUES (?, ?, NULL, ?, ?, NULL, 'user', ?)",
  );
  insertUsage.run("show", null, "main//knowledge/guide", null, "2026-01-29 10:00:00");
  insertUsage.run("feedback", null, "main//knowledge/reports/quarterly", "negative", "2026-01-29 10:01:00");
  insertUsage.run("show", null, "team//knowledge/shared", null, "2026-01-29 10:02:00");

  // A task run recorded against the ref the task ran.
  db.prepare(
    `INSERT INTO task_history (task_id, status, started_at, completed_at, failed_at, log_path, target_kind, target_ref, metadata_json)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run("nightly", "completed", WHEN, WHEN, "workflow", "main//workflows/ship", JSON.stringify({ durationMs: 1200 }));
}

/** Every table and index of `db` as SQL text, in a fixed order, with the migration ledger's clock frozen. */
export function dumpState(db: Database): string {
  const lines: string[] = [];
  const schema = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const tables = schema.filter((s) => s.type === "table").sort((a, b) => a.name.localeCompare(b.name));
  for (const table of tables) lines.push(`${table.sql};`);
  for (const index of schema.filter((s) => s.type === "index").sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${index.sql};`);
  }
  for (const table of tables) {
    const columns = (db.prepare(`PRAGMA table_info("${table.name}")`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const quoted = columns.map((c) => `quote("${c}")`).join(" || ',' || ");
    const order = columns.includes("id") ? '"id"' : "rowid";
    const rows = db.prepare(`SELECT ${quoted} AS v FROM "${table.name}" ORDER BY ${order}`).all() as Array<{
      v: string;
    }>;
    for (const row of rows) {
      const values =
        table.name === "schema_migrations"
          ? row.v.replace(/'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d'/, "'2026-01-01 00:00:00'")
          : row.v;
      lines.push(`INSERT INTO "${table.name}" VALUES (${values});`);
    }
  }
  return `${lines.join("\n")}\n`;
}
