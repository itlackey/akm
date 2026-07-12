// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm mv <ref> <new-name>` — rename an asset within its type directory
 * (SPEC-7, stash-conventions-code-spec.md).
 *
 * The stash organization conventions' forced-rename procedure ("grep and fix
 * inbound xrefs in the same pass") is agent-executable EXCEPT for the part
 * only the CLI can do: a rename mints a new `entries` row (entry_key is
 * UNIQUE), which orphans the utility_scores / utility_scores_scoped /
 * embeddings rows keyed by entry_id, detaches usage_events keyed by the old
 * entry_ref, and strands the state.db asset_salience / asset_outcome rows
 * keyed by `asset_ref` TEXT — the "rename resets learned ranking" cost the
 * conventions warn about. This verb does the whole pass: move the file,
 * rewrite inbound refs, re-key the index row IN PLACE (including the
 * usage_events entry_ref history), and re-key the state.db salience/outcome
 * rows so the accumulated history survives.
 *
 * Scope (v1, Experimental — see STABILITY.md):
 *   - flat-markdown asset types only ({@link MV_SUPPORTED_TYPES});
 *   - the primary writable stash only (no `--target`);
 *   - the source ref may be the canonical spelling or its deterministic
 *     `.md`-suffixed / `local//`-prefixed alias (both are canonicalized
 *     before anything is keyed off them) — lint-resolver FALLBACK spellings
 *     are rejected with the canonical ref named (see
 *     {@link resolveMoveSourcePath});
 *   - wiki refs are rejected (wikis have their own xref + lint system);
 *   - a memory's `.derived.md` twin moves together and keeps its
 *     `entry_key === <base entry_key> + ".derived"` coupling; a twin ref
 *     cannot be moved alone, and target names ending `.derived` are rejected
 *     (reserved suffix).
 *
 * Ordering: the complete mutation holds the index-writer lease. After validation,
 * citer replacements are staged beside durable byte-for-byte backups and a small
 * phase journal under `.akm/mv-transactions/`. Publication uses same-filesystem
 * renames; any synchronous failure restores every citer and asset rename. A later
 * invocation rolls back an interrupted prepared/applying journal before planning
 * another move. Derived index state remains fail-open and heals on a full index.
 * Graph tables (graph_files) key extractions by file path and stay stale
 * until the next graph pass — acceptable, the graph is a derived cache.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defineJsonCommand, output } from "../cli/shared";
import { parseAssetRef, refToString } from "../core/asset/asset-ref";
import { deriveCanonicalAssetNameFromStashRoot, TYPE_DIRS } from "../core/asset/asset-spec";
import { type AkmAssetType, isWithin, resolveStashDir, toPosix } from "../core/common";
import { loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { getDbPath } from "../core/paths";
import { getStateDbPath, openStateDatabase } from "../core/state-db";
import { warnVerbose } from "../core/warn";
import { closeDatabase, openExistingDatabase, rebuildFts, rekeyEntryInPlace } from "../indexer/db/db";
import { withAssetMutationLease } from "../indexer/index-writer-lock";
import { indexWrittenAssets, WRITE_PATH_INDEX_BUSY_TIMEOUT_MS } from "../indexer/index-written-assets";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { insertEventOnce } from "../storage/repositories/events-repository";
import { shouldReadLegacyBareImproveState } from "./improve/source-identity";
import {
  REF_BOUNDARY_PREFIX_CLASS_SRC,
  REF_SLUG_CHAR_CLASS_SRC,
  refToRelPath,
  resolveRefPathInStash,
} from "./lint/base-linter";

// ── Scope ─────────────────────────────────────────────────────────────────────

/**
 * Asset types `akm mv` can rename in v1: exactly the types whose canonical
 * layout is one flat `.md` file per name (the `markdownSpec` family), so a
 * rename is a single-file move and inbound refs are rewritable by complete-ref
 * matching. Deliberately excluded:
 *   - `wiki` — wikis carry their own xref + lint system (`akm wiki lint`);
 *   - `skill` — the canonical layout is a multi-file `skills/<name>/SKILL.md`
 *     directory (a directory rename, out of v1 scope);
 *   - `script` — unresolvable by the slug resolver (contract-pinned);
 *   - `workflow` — workflows may live as `.yaml`/`.yml` programs
 *     (`WORKFLOW_EXTENSIONS`), and `workflowSpec.toAssetPath` resolves them
 *     by a cwd-relative existence probe with a `<name>.md` fallback — a mv
 *     would either rename a YAML program to `.md` (misclassifying it) or
 *     fail to resolve it from any cwd but the stash root. Out of v1 scope;
 *     rejected with a dedicated error naming the manual procedure;
 *   - `task` / `env` / `secret` — not markdown assets.
 */
const MV_SUPPORTED_TYPES: readonly string[] = ["memory", "knowledge", "command", "agent", "lesson", "session", "fact"];

// ── Ref rewriting ─────────────────────────────────────────────────────────────

/**
 * Boundary grammar IMPORTED from lint's `REF_RE` fragments (base-linter.ts
 * `REF_BOUNDARY_PREFIX_CLASS_SRC` / `REF_SLUG_CHAR_CLASS_SRC`) so the two
 * grammars cannot drift: a ref starts at line start or after whitespace /
 * backtick / quote / `(` / `[` / `,` (the `[` admits flow-style YAML lists
 * like `xrefs: [memory:foo]` and bracketed body refs; the `,` admits the
 * refs after the first in a NO-SPACE flow list `[memory:a,memory:b]`), and
 * its slug runs until
 * the first non-slug character. Complete-ref matching is what keeps a longer
 * ref sharing the old ref as a prefix (e.g. `memory:a/base-note-extra` when
 * moving `memory:a/base-note`) untouched.
 */
const REF_PREFIX_SRC = `(^|${REF_BOUNDARY_PREFIX_CLASS_SRC})`;
const REF_SUFFIX_SRC = `(?!${REF_SLUG_CHAR_CLASS_SRC})`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the rewrite patterns for one old ref: the canonical spelling plus
 * the DETERMINISTIC alias spellings the resolver stack accepts for the same
 * asset — the `.md`-suffixed form (`markdownSpec.toAssetPath` accepts both)
 * and the `local//`-prefixed form (`makeAssetRef`/`parseAssetRef` round-trip
 * it). All alias spellings rewrite to the NEW CANONICAL ref. When the source
 * is a base memory, the optional `.derived` tail also rewrites explicit twin
 * refs (`memory:a/note.derived` → `memory:a/new.derived`) — the twin file
 * moves together, so its ref must too. The tail group is empty-capturing
 * otherwise so the replacer's group indices stay stable.
 */
function buildRewritePatterns(fromRef: string, includeDerivedTail: boolean): RegExp[] {
  const tail = includeDerivedTail ? "(\\.derived)?" : "()";
  const core = escapeRegExp(fromRef);
  return [
    new RegExp(`${REF_PREFIX_SRC}${core}${tail}${REF_SUFFIX_SRC}`, "gm"),
    new RegExp(`${REF_PREFIX_SRC}${core}${tail}\\.md${REF_SUFFIX_SRC}`, "gm"),
    new RegExp(`${REF_PREFIX_SRC}local//${core}${tail}(?:\\.md)?${REF_SUFFIX_SRC}`, "gm"),
  ];
}

/**
 * Everything {@link rewriteRefs} needs to rewrite one file's content:
 * the deterministic patterns (pass 1) and the resolver-backed alias scan
 * (pass 2) that catches remaining spellings — e.g. the knowledge-subdir
 * basename alias (`knowledge:guide` for `knowledge/guides/guide.md`) — by
 * resolving every ref-shaped token of the moved type through lint's shared
 * resolver and rewriting the ones that point at the moved file's old path.
 */
interface RewriteContext {
  patterns: RegExp[];
  /** Matches `<type>:<slug>` tokens, optionally `local//`-prefixed. */
  aliasScan: RegExp;
  type: AkmAssetType;
  toRef: string;
  /** Root the moved file lives in (alias tokens are resolved against it). */
  scanRoot: string;
  oldPathResolved: string;
  twinOldPathResolved: string | null;
}

function buildRewriteContext(opts: {
  type: AkmAssetType;
  fromRef: string;
  toRef: string;
  isBaseMemory: boolean;
  stashDir: string;
  oldPath: string;
  twinOldPath: string | null;
}): RewriteContext {
  return {
    patterns: buildRewritePatterns(opts.fromRef, opts.isBaseMemory),
    aliasScan: new RegExp(
      `(^|${REF_BOUNDARY_PREFIX_CLASS_SRC})((?:local//)?${escapeRegExp(opts.type)}:${REF_SLUG_CHAR_CLASS_SRC}+)`,
      "gm",
    ),
    type: opts.type,
    toRef: opts.toRef,
    scanRoot: opts.stashDir,
    oldPathResolved: path.resolve(opts.oldPath),
    twinOldPathResolved: opts.twinOldPath ? path.resolve(opts.twinOldPath) : null,
  };
}

/**
 * Replace every occurrence of the moved ref, returning the count replaced.
 *
 * Two passes:
 *   1. the deterministic patterns (canonical / `.md`-suffixed / `local//`);
 *   2. the resolver scan — any remaining ref-shaped token of the moved type
 *      that resolves (via `resolveRefPathInStash`, lint's shared resolver)
 *      to the moved file's old path is an alias spelling of the same asset
 *      and is rewritten to the new canonical ref too. Because this pass
 *      rewrites EVERY token that resolves to the old path, nothing
 *      ref-shaped can still point at the moved file afterwards.
 *
 * Runs at PLANNING time, before the rename — the old file must still be on
 * disk for the resolver probes.
 */
function rewriteRefs(content: string, ctx: RewriteContext): { content: string; count: number } {
  let count = 0;
  let next = content;
  for (const pattern of ctx.patterns) {
    next = next.replace(pattern, (_match, prefix: string, derivedTail: string | undefined) => {
      count += 1;
      return `${prefix}${ctx.toRef}${derivedTail ?? ""}`;
    });
  }
  /**
   * Probe one ref-shaped token through lint's shared resolver:
   *   - `{ rewriteTo }` — it resolves to the moved file (or its twin) and
   *     must be rewritten to the new canonical ref;
   *   - `"other"` — it names a different asset (or IS the new canonical ref,
   *     just written by pass 1, which may itself resolve to the old path
   *     through a fallback — e.g. moving knowledge:guides/x to the knowledge
   *     root while guides/x.md still exists at planning time; never rewrite
   *     it to itself) and must be left alone;
   *   - `"unresolved"` — it resolves to nothing (the punctuation-retry case).
   */
  const probe = (token: string): { rewriteTo: string } | "other" | "unresolved" => {
    const bare = token.startsWith("local//") ? token.slice("local//".length) : token;
    if (bare === ctx.toRef || bare === `${ctx.toRef}.derived`) return "other";
    const name = bare.slice(ctx.type.length + 1);
    if (!name) return "unresolved";
    const relPath = refToRelPath(ctx.type, name);
    if (!relPath) return "unresolved";
    const resolved = resolveRefPathInStash(relPath, ctx.type, name, ctx.scanRoot);
    if (!resolved) return "unresolved";
    const resolvedAbs = path.resolve(resolved);
    if (resolvedAbs === ctx.oldPathResolved) return { rewriteTo: ctx.toRef };
    if (ctx.twinOldPathResolved && resolvedAbs === ctx.twinOldPathResolved) {
      return { rewriteTo: `${ctx.toRef}.derived` };
    }
    return "other";
  };
  next = next.replace(ctx.aliasScan, (match, prefix: string, token: string) => {
    const full = probe(token);
    if (full !== "other" && full !== "unresolved") {
      count += 1;
      return `${prefix}${full.rewriteTo}`;
    }
    if (full === "other") return match;
    // The slug charset admits sentence punctuation ('.', ';', ':', '!', '?'),
    // so a prose citation like "See memory:old." parses as the token "old." —
    // which resolves to nothing. Retry with the trailing punctuation run
    // stripped, but ONLY after the full token failed to resolve: a genuinely
    // dotted name (memory:v1.2-notes) or a `.md`-suffixed alias that resolves
    // won the probe above and is never mangled. The punctuation is preserved
    // outside the rewritten ref.
    const punctuation = /[.,;:!?)]+$/.exec(token)?.[0] ?? "";
    if (!punctuation || punctuation.length === token.length) return match;
    const trimmed = probe(token.slice(0, token.length - punctuation.length));
    if (trimmed !== "other" && trimmed !== "unresolved") {
      count += 1;
      return `${prefix}${trimmed.rewriteTo}${punctuation}`;
    }
    return match;
  });
  return { content: next, count };
}

// ── File walking ──────────────────────────────────────────────────────────────

/**
 * Every ref-carrying file under `root`, recursively: all `.md` files, plus
 * `.yml`/`.yaml` files under the `tasks/` and `workflows/` type dirs — task
 * YAML legitimately carries refs (`workflow: workflow:…`, `prompt:
 * agent:/memory:…`, see src/tasks/parser.ts) and workflow YAML *programs*
 * carry refs in their step/instructions text, and lint's missing-ref body
 * scan covers both, so a rename must rewrite them like any other citer or
 * the scheduled task / workflow step dangles. (Workflows are CITERS only:
 * `workflow:` refs still cannot be MOVED — see {@link MV_SUPPORTED_TYPES}.)
 * Skips dot-directories (index state, `.cache/` mirrors) and `registry/`
 * caches — the same read-only carve-outs `akm lint --fix` honours
 * (lint/index.ts).
 */
function collectCiterFiles(root: string): string[] {
  const tasksRoot = path.join(root, TYPE_DIRS.task ?? "tasks");
  const workflowsRoot = path.join(root, TYPE_DIRS.workflow ?? "workflows");
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "registry") continue;
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".md")) {
          results.push(full);
        } else if (
          (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) &&
          (isWithin(full, tasksRoot) || isWithin(full, workflowsRoot))
        ) {
          results.push(full);
        }
      }
    }
  };
  walk(root);
  return results;
}

interface CiterRewritePlan {
  absPath: string;
  relPath: string;
  count: number;
  content: string;
  originalHash: string;
}

interface MoveJournal {
  version: 1;
  phase:
    | "prepared"
    | "applying"
    | "filesystem-committed"
    | "index-finalized"
    | "state-finalized"
    | "event-finalized"
    | "committed";
  transactionId: string;
  sourceName: string;
  sourceRoot: string;
  includeLegacyBare: boolean;
  eventTs: string;
  eventMetadata: Record<string, unknown>;
  oldPath: string;
  newPath: string;
  twinOldPath: string | null;
  twinNewPath: string | null;
  sourceOriginalHash: string;
  expectedNewHash: string;
  twinOriginalHash: string | null;
  expectedTwinNewHash: string | null;
  type: string;
  oldName: string;
  newName: string;
  fromRef: string;
  toRef: string;
  citers: Array<{
    absPath: string;
    backupPath: string;
    stagedPath: string;
    ownedPath: string;
    mode: number;
    originalHash: string;
    replacementHash: string;
  }>;
}

interface MoveTransaction {
  journal: MoveJournal;
  journalPath: string;
  transactionDir: string;
}

let mvMutationHookForTests: ((point: string) => void) | undefined;

/** TEST-ONLY crash-window hook used by subprocess recovery tests. */
export function _setMvMutationHookForTests(hook?: (point: string) => void): void {
  mvMutationHookForTests = hook;
}

function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashFile(filePath: string): string {
  return hashContent(fs.readFileSync(filePath));
}

function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(dirPath: string): void {
  try {
    fsyncFile(dirPath);
  } catch {
    // Some platforms do not permit opening directories; file fsync still applies.
  }
}

function writeMoveJournal(journalPath: string, journal: MoveJournal): void {
  const tempPath = `${journalPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fsyncFile(tempPath);
  fs.renameSync(tempPath, journalPath);
  fsyncDirectory(path.dirname(journalPath));
}

function setMoveJournalPhase(transaction: MoveTransaction, phase: MoveJournal["phase"]): void {
  const next = { ...transaction.journal, phase };
  writeMoveJournal(transaction.journalPath, next);
  transaction.journal.phase = phase;
}

function rollbackMoveJournal(journal: MoveJournal): void {
  const restoreRename = (
    oldPath: string | null,
    newPath: string | null,
    originalHash: string | null,
    publishedHash: string | null,
  ): void => {
    if (!oldPath || !newPath || !fs.existsSync(newPath)) return;
    if (!publishedHash || hashFile(newPath) !== publishedHash) {
      throw new Error(`cannot roll back ${newPath}: published file diverged after the move`);
    }
    if (fs.existsSync(oldPath)) {
      if (hashFile(oldPath) !== publishedHash) {
        throw new Error(`cannot roll back ${newPath}: source path ${oldPath} is occupied by divergent content`);
      }
      fs.unlinkSync(newPath);
      return;
    }
    fs.linkSync(newPath, oldPath);
    fs.unlinkSync(newPath);
    if (originalHash && hashFile(oldPath) !== publishedHash) {
      throw new Error(`cannot verify rolled-back source ${oldPath}`);
    }
  };

  // Undo asset publication before restoring self-citing files at their old paths.
  restoreRename(journal.oldPath, journal.newPath, journal.sourceOriginalHash, journal.expectedNewHash);
  restoreRename(journal.twinOldPath, journal.twinNewPath, journal.twinOriginalHash, journal.expectedTwinNewHash);
  for (const [index, citer] of journal.citers.entries()) {
    if (!fs.existsSync(citer.backupPath)) {
      throw new Error(`cannot restore ${citer.absPath}: backup is missing`);
    }
    const currentHash = fs.existsSync(citer.absPath) ? hashFile(citer.absPath) : null;
    if (fs.existsSync(citer.ownedPath)) {
      if (currentHash !== null && currentHash !== citer.replacementHash && currentHash !== citer.originalHash) {
        throw new Error(`cannot restore ${citer.absPath}: file diverged after exclusive ownership`);
      }
      if (currentHash === citer.replacementHash) fs.unlinkSync(citer.absPath);
      if (!fs.existsSync(citer.absPath)) fs.linkSync(citer.ownedPath, citer.absPath);
      continue;
    }
    if (currentHash === citer.originalHash) continue;
    if (currentHash !== citer.replacementHash) {
      throw new Error(`cannot restore ${citer.absPath}: file diverged after move planning`);
    }
    const restorePath = path.join(path.dirname(citer.backupPath), `restore-${index}`);
    fs.copyFileSync(citer.backupPath, restorePath);
    fs.chmodSync(restorePath, citer.mode);
    fs.renameSync(restorePath, citer.absPath);
  }
}

function validateCommittedMove(journal: MoveJournal): void {
  if (fs.existsSync(journal.oldPath) || !fs.existsSync(journal.newPath)) {
    throw new Error(`Cannot finalize move: expected only committed target ${journal.newPath}.`);
  }
  if (hashFile(journal.newPath) !== journal.expectedNewHash) {
    throw new Error(`Cannot finalize move: committed target ${journal.newPath} diverged.`);
  }
  if (journal.twinNewPath) {
    if (journal.twinOldPath && fs.existsSync(journal.twinOldPath)) {
      throw new Error(`Cannot finalize move: old twin ${journal.twinOldPath} still exists.`);
    }
    if (!fs.existsSync(journal.twinNewPath) || hashFile(journal.twinNewPath) !== journal.expectedTwinNewHash) {
      throw new Error(`Cannot finalize move: committed twin ${journal.twinNewPath} diverged.`);
    }
  }
  for (const citer of journal.citers) {
    if (citer.absPath === journal.oldPath || citer.absPath === journal.twinOldPath) continue;
    if (!fs.existsSync(citer.absPath) || hashFile(citer.absPath) !== citer.replacementHash) {
      throw new Error(`Cannot finalize move: citer ${citer.absPath} diverged.`);
    }
  }
}

function cleanupMoveTransaction(transactionDir: string): string | null {
  try {
    fs.rmSync(transactionDir, { recursive: true, force: true });
    const root = path.dirname(transactionDir);
    try {
      fs.rmdirSync(root);
    } catch {
      // Other transactions may still exist.
    }
    return null;
  } catch (error) {
    const warning = `move committed but journal cleanup failed at ${transactionDir}: ${error instanceof Error ? error.message : String(error)}`;
    warnVerbose(`akm mv: ${warning}`);
    return warning;
  }
}

export async function recoverInterruptedMoveTransactions(stashDir: string): Promise<void> {
  const root = path.join(stashDir, ".akm", "mv-transactions");
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transactionDir = path.join(root, entry.name);
    const journalPath = path.join(transactionDir, "journal.json");
    if (!fs.existsSync(journalPath)) {
      cleanupMoveTransaction(transactionDir);
      continue;
    }
    let journal: MoveJournal;
    try {
      journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as MoveJournal;
    } catch (error) {
      throw new Error(
        `Cannot recover interrupted move journal at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (journal.version !== 1) throw new Error(`Unsupported move journal version at ${journalPath}.`);
    const stashPaths = [journal.oldPath, journal.newPath, journal.twinOldPath, journal.twinNewPath]
      .concat(journal.citers.map((citer) => citer.absPath))
      .filter((candidate): candidate is string => candidate !== null);
    const transactionPaths = journal.citers.flatMap((citer) => [citer.backupPath, citer.stagedPath, citer.ownedPath]);
    if (
      ![
        "prepared",
        "applying",
        "filesystem-committed",
        "index-finalized",
        "state-finalized",
        "event-finalized",
        "committed",
      ].includes(journal.phase) ||
      stashPaths.some((candidate) => !isWithin(candidate, stashDir)) ||
      transactionPaths.some((candidate) => !isWithin(candidate, transactionDir))
    ) {
      throw new Error(`Refusing unsafe move recovery journal at ${journalPath}.`);
    }
    const transaction = { journal, journalPath, transactionDir };
    if (journal.phase === "prepared" || journal.phase === "applying") {
      rollbackMoveJournal(journal);
    } else if (journal.phase !== "committed") {
      validateCommittedMove(journal);
      await finalizeMoveTransaction(transaction);
    }
    cleanupMoveTransaction(transactionDir);
  }
}

function applyMoveFilesystem(opts: {
  stashDir: string;
  oldPath: string;
  newPath: string;
  twinOldPath: string | null;
  twinNewPath: string | null;
  sourceOriginalHash: string;
  twinOriginalHash: string | null;
  type: string;
  oldName: string;
  newName: string;
  fromRef: string;
  toRef: string;
  sourceName: string;
  sourceRoot: string;
  includeLegacyBare: boolean;
  eventMetadata: Record<string, unknown>;
  plans: CiterRewritePlan[];
}): MoveTransaction {
  const transactionRoot = path.join(opts.stashDir, ".akm", "mv-transactions");
  fs.mkdirSync(transactionRoot, { recursive: true, mode: 0o700 });
  const transactionId = randomUUID();
  const transactionDir = path.join(transactionRoot, transactionId);
  fs.mkdirSync(transactionDir, { mode: 0o700 });
  const journalPath = path.join(transactionDir, "journal.json");
  let journal: MoveJournal | undefined;

  try {
    const citers = opts.plans.map((plan, index) => {
      const mode = fs.statSync(plan.absPath).mode;
      const backupPath = path.join(transactionDir, `backup-${index}`);
      const stagedPath = path.join(transactionDir, `staged-${index}`);
      const ownedPath = path.join(transactionDir, `owned-${index}`);
      if (hashFile(plan.absPath) !== plan.originalHash) {
        throw new Error(`refusing to stage divergent citer ${plan.absPath}`);
      }
      fs.copyFileSync(plan.absPath, backupPath);
      fs.chmodSync(backupPath, mode);
      fs.writeFileSync(stagedPath, plan.content, { encoding: "utf8", mode });
      fsyncFile(backupPath);
      fsyncFile(stagedPath);
      return {
        absPath: plan.absPath,
        backupPath,
        stagedPath,
        ownedPath,
        mode,
        originalHash: plan.originalHash,
        replacementHash: hashContent(plan.content),
      };
    });

    if (hashFile(opts.oldPath) !== opts.sourceOriginalHash) throw new Error(`source ${opts.oldPath} diverged`);
    if (opts.twinOldPath && opts.twinOriginalHash && hashFile(opts.twinOldPath) !== opts.twinOriginalHash) {
      throw new Error(`twin ${opts.twinOldPath} diverged`);
    }
    const sourceCiter = citers.find((citer) => citer.absPath === opts.oldPath);
    const twinCiter = citers.find((citer) => citer.absPath === opts.twinOldPath);

    journal = {
      version: 1,
      phase: "prepared",
      transactionId,
      sourceName: opts.sourceName,
      sourceRoot: opts.sourceRoot,
      includeLegacyBare: opts.includeLegacyBare,
      eventTs: new Date().toISOString(),
      eventMetadata: opts.eventMetadata,
      oldPath: opts.oldPath,
      newPath: opts.newPath,
      twinOldPath: opts.twinOldPath,
      twinNewPath: opts.twinNewPath,
      sourceOriginalHash: opts.sourceOriginalHash,
      expectedNewHash: sourceCiter?.replacementHash ?? opts.sourceOriginalHash,
      twinOriginalHash: opts.twinOriginalHash,
      expectedTwinNewHash: twinCiter?.replacementHash ?? opts.twinOriginalHash,
      type: opts.type,
      oldName: opts.oldName,
      newName: opts.newName,
      fromRef: opts.fromRef,
      toRef: opts.toRef,
      citers,
    };
    writeMoveJournal(journalPath, journal);
    const transaction = { journal, journalPath, transactionDir };
    setMoveJournalPhase(transaction, "applying");

    for (const citer of citers) {
      fs.renameSync(citer.absPath, citer.ownedPath);
      if (hashFile(citer.ownedPath) !== citer.originalHash) {
        if (!fs.existsSync(citer.absPath)) fs.linkSync(citer.ownedPath, citer.absPath);
        throw new Error(`refusing to replace divergent citer ${citer.absPath}`);
      }
      try {
        fs.linkSync(citer.stagedPath, citer.absPath);
        fs.unlinkSync(citer.stagedPath);
      } catch (error) {
        if (!fs.existsSync(citer.absPath)) fs.linkSync(citer.ownedPath, citer.absPath);
        throw error;
      }
    }
    if (hashFile(opts.oldPath) !== journal.expectedNewHash) throw new Error(`source ${opts.oldPath} diverged`);
    fs.linkSync(opts.oldPath, opts.newPath);
    fs.unlinkSync(opts.oldPath);
    if (opts.twinOldPath && opts.twinNewPath) {
      if (hashFile(opts.twinOldPath) !== journal.expectedTwinNewHash)
        throw new Error(`twin ${opts.twinOldPath} diverged`);
      fs.linkSync(opts.twinOldPath, opts.twinNewPath);
      fs.unlinkSync(opts.twinOldPath);
    }

    setMoveJournalPhase(transaction, "filesystem-committed");
    return transaction;
  } catch (error) {
    if (journal) {
      try {
        rollbackMoveJournal(journal);
        cleanupMoveTransaction(transactionDir);
      } catch (rollbackError) {
        throw new Error(
          `Move failed (${error instanceof Error ? error.message : String(error)}) and rollback failed ` +
            `(${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}). ` +
            `Recovery journal retained at ${journalPath}.`,
        );
      }
    } else {
      cleanupMoveTransaction(transactionDir);
    }
    throw error;
  }
}

// ── Source resolution ─────────────────────────────────────────────────────────

/**
 * Return the ON-DISK casing of `relPath` under `root` as a posix-separated
 * relative path, or `null` when a segment cannot be found (file deleted
 * mid-flight, unreadable directory — callers treat null as "unverifiable"
 * and keep the `existsSync` verdict).
 *
 * The casing guard for {@link resolveMoveSourcePath}: on a case-INSENSITIVE
 * filesystem (macOS/Windows defaults) `existsSync` matches a wrong-case
 * spelling and `resolveRefPathInStash` returns the user-cased join verbatim,
 * so a byte-comparison of the resolved path against the ref-derived path
 * compares the string against itself. This helper reads each path segment's
 * true name from its parent's directory listing instead — deliberately NOT
 * `fs.realpathSync.native`, which also resolves symlinks and would
 * false-mismatch a stash root reached through one (e.g. /tmp on macOS).
 * Matching is byte-first, then Unicode-lowercase — an approximation of the
 * filesystem's own case folding that can only miss toward `null`
 * (unverifiable), never toward a wrong entry.
 */
export function deriveOnDiskCasedRelPath(root: string, relPath: string): string | null {
  const segments = toPosix(relPath).split("/").filter(Boolean);
  const cased: string[] = [];
  let dir = root;
  for (const segment of segments) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const onDisk = entries.includes(segment)
      ? segment
      : entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
    if (onDisk === undefined) return null;
    cased.push(onDisk);
    dir = path.join(dir, onDisk);
  }
  return cased.join("/");
}

/**
 * Resolve the on-disk file for the ref being moved, within the primary
 * writable stash ONLY. Reuses lint's shared resolver (`resolveRefPathInStash`,
 * base-linter.ts — do not fork a second resolver), then requires the hit to
 * be CANONICAL: the resolved file must be exactly `<stashDir>/<relPath>`, the
 * path the ref's spelling maps to.
 *
 * Lint's resolver accepts fallback spellings on purpose (a knowledge-subdir
 * alias like `knowledge:g` for `knowledge/guides/g.md`, a refName encoding a
 * full stash-relative path, a base memory ref satisfied by its `.derived.md`
 * twin, a `SKILL.md` directory primary) — fine for existence checks, fatal
 * for a move: the citer rewrite targets the typed spelling (canonical citers
 * would dangle), the index re-key derives its old entry_key from the typed
 * spelling (the real row would be stranded as a ghost and a duplicate row
 * minted — the exact utility-history reset `mv` exists to prevent), and the
 * direct-path fallback would even RELOCATE the file out of its real home into
 * the type root. So:
 *   - `null` — the ref does not resolve at all (also for a base memory ref
 *     whose only on-disk presence is the `.derived.md` twin: the base file is
 *     what `mv` renames — the twin is carried along, never moved alone —
 *     and for a `SKILL.md` directory primary, out of v1 scope);
 *   - throws `UsageError` (exit 2) — the ref resolves ONLY via a fallback
 *     spelling; the message names the canonical ref when one is derivable.
 */
function resolveMoveSourcePath(
  stashDir: string,
  relPath: string,
  refType: AkmAssetType,
  refName: string,
): string | null {
  const resolved = resolveRefPathInStash(relPath, refType, refName, stashDir);
  if (!resolved) return null;
  if (resolved.endsWith(".derived.md") && !refName.endsWith(".derived")) return null;
  if (path.basename(resolved) === "SKILL.md" && !relPath.endsWith(`${path.sep}SKILL.md`)) return null;
  // The byte-equal comparison below cannot catch a CASE alias: on a
  // case-insensitive filesystem the resolver's `existsSync` matches
  // `memory:Foo` against memories/foo.md and returns the USER-cased join, so
  // the comparison checks the string against itself. Every downstream key is
  // case-sensitive regardless of the filesystem (the citer rewrite matches
  // bytes, the index entry_key is BINARY-collated, state.db asset_ref
  // likewise), so a wrong-case source must be rejected like any other
  // fallback spelling: verify the ON-DISK casing and, on mismatch, fall
  // through to the rejection below with the true-cased path so the error
  // names the canonical ref.
  let onDiskResolved = resolved;
  if (path.resolve(resolved) === path.resolve(stashDir, relPath)) {
    const onDiskRelPath = deriveOnDiskCasedRelPath(stashDir, relPath);
    if (onDiskRelPath === null || onDiskRelPath === toPosix(relPath)) return resolved;
    onDiskResolved = path.join(stashDir, onDiskRelPath);
  }

  // Fallback hit — reject, steering to the canonical spelling when it exists.
  const typedRef = refToString({ type: refType, name: refName });
  const canonicalName = deriveCanonicalAssetNameFromStashRoot(refType, stashDir, onDiskResolved);
  const canonicalRelPath = canonicalName ? refToRelPath(refType, canonicalName) : null;
  if (
    canonicalName &&
    canonicalName !== refName &&
    canonicalRelPath &&
    path.resolve(stashDir, canonicalRelPath) === path.resolve(onDiskResolved)
  ) {
    const canonicalRef = refToString({ type: refType, name: canonicalName });
    throw new UsageError(
      `"${typedRef}" resolves only through a fallback spelling — the asset's canonical ref is ${canonicalRef}. ` +
        "akm mv needs the canonical spelling so the citer rewrite and the index re-key target the same ref — nothing moved.",
      "INVALID_FLAG_VALUE",
      `Re-run with the canonical ref: akm mv ${canonicalRef} <new-name>.`,
    );
  }
  throw new UsageError(
    `"${typedRef}" resolves to ${toPosix(path.relative(stashDir, onDiskResolved))}, outside the ${TYPE_DIRS[refType]}/ ` +
      "type root — akm mv renames within a type directory only; nothing moved.",
    "INVALID_FLAG_VALUE",
  );
}

// ── Index re-key ──────────────────────────────────────────────────────────────

/**
 * Re-key the moved row(s) in the local index, preserving row ids (and with
 * them the utility/embedding/salience history). FAIL-OPEN like every
 * write-path index touch: an absent index.db is skipped silently (the next
 * full `akm index` picks the renamed file up fresh), and any error reduces
 * to a verbose warning — the rename itself has already succeeded.
 *
 * The returned flag is the `utilityPreserved` claim in the command's output,
 * so it must be honest:
 *   - true — no index exists, the file was never indexed (nothing to
 *     preserve; the next `akm index` picks it up fresh), or the row(s) were
 *     re-keyed in place;
 *   - false — an existing index could not be re-keyed (open/SQL error), or a
 *     row for the moved file exists under some OTHER entry_key than the one
 *     the canonical spelling derives (e.g. a differently-normalized stash
 *     path at index time): that history is now stranded on a ghost row and
 *     will NOT survive the next index run.
 *
 * When `preserved` is false, `warning` carries the reason for the command's
 * JSON report — a re-key failure must be user-visible, not verbose-only.
 */
function rekeyIndexForMove(opts: {
  stashDir: string;
  type: string;
  oldName: string;
  newName: string;
  oldPath: string;
  newPath: string;
  fromRef: string;
  toRef: string;
  twinOldPath: string | null;
  twinNewPath: string | null;
  sourceName: string;
  sourceRoot: string;
  includeLegacyBare: boolean;
}): { complete: boolean; preserved: boolean; warning: string | null } {
  const dbPath = getDbPath();
  try {
    if (!fs.existsSync(dbPath)) return { complete: true, preserved: true, warning: null };
    let preserved = true;
    const db = openExistingDatabase(dbPath);
    try {
      db.exec(`PRAGMA busy_timeout = ${WRITE_PATH_INDEX_BUSY_TIMEOUT_MS}`);
      // A null re-key means "no row under the expected old key". That is fine
      // when the file was simply never indexed, but a lie if a row for the
      // file DOES exist under another key — then history is stranded.
      const strandedRow = (movedFrom: string): boolean =>
        db.prepare("SELECT id FROM entries WHERE file_path = ? LIMIT 1").get(movedFrom) != null;
      const oldKey = `${opts.stashDir}:${opts.type}:${opts.oldName}`;
      const newKey = `${opts.stashDir}:${opts.type}:${opts.newName}`;
      const alreadyRekeyed =
        db.prepare("SELECT id FROM entries WHERE entry_key = ? AND file_path = ? LIMIT 1").get(newKey, opts.newPath) !=
        null;
      const rekeyed = rekeyEntryInPlace(db, {
        oldEntryKey: oldKey,
        newEntryKey: newKey,
        newName: opts.newName,
        newFilePath: opts.newPath,
        oldRef: opts.fromRef,
        newRef: opts.toRef,
        sourceName: opts.sourceName,
        sourceRoot: opts.sourceRoot,
        includeLegacyBare: opts.includeLegacyBare,
      });
      if (rekeyed === null && !alreadyRekeyed && strandedRow(opts.oldPath)) preserved = false;
      let twinRekeyed: number | null = null;
      if (opts.twinNewPath) {
        // The twin coupling (db.ts getBaseBeliefStatesForDerivedTwins) is
        // `twin entry_key === base entry_key + ".derived"` — preserved here.
        const twinAlreadyRekeyed =
          db
            .prepare("SELECT id FROM entries WHERE entry_key = ? AND file_path = ? LIMIT 1")
            .get(`${newKey}.derived`, opts.twinNewPath) != null;
        twinRekeyed = rekeyEntryInPlace(db, {
          oldEntryKey: `${oldKey}.derived`,
          newEntryKey: `${newKey}.derived`,
          newName: `${opts.newName}.derived`,
          newFilePath: opts.twinNewPath,
          oldRef: `${opts.fromRef}.derived`,
          newRef: `${opts.toRef}.derived`,
          newDerivedFrom: opts.toRef,
          sourceName: opts.sourceName,
          sourceRoot: opts.sourceRoot,
          includeLegacyBare: opts.includeLegacyBare,
        });
        if (twinRekeyed === null && !twinAlreadyRekeyed && opts.twinOldPath && strandedRow(opts.twinOldPath)) {
          preserved = false;
        }
      }
      if (rekeyed !== null || twinRekeyed !== null) {
        rebuildFts(db, { incremental: true });
      }
      mvMutationHookForTests?.("index-rekeyed");
    } finally {
      closeDatabase(db);
    }
    if (!preserved) {
      const warning =
        "index re-key skipped: the index holds a row for the moved file under an unexpected key — its utility " +
        "history was not re-keyed and resets on the next `akm index`.";
      warnVerbose(`akm mv: ${warning}`);
      return { complete: false, preserved: false, warning };
    }
    return { complete: true, preserved: true, warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning =
      `index re-key failed (${message}) — the rename itself succeeded and the index heals on the next ` +
      "`akm index`, but the asset's utility history was NOT re-keyed and resets on that run.";
    warnVerbose(`akm mv: ${warning}`);
    return { complete: false, preserved: false, warning };
  }
}

/**
 * Re-key the state.db `asset_salience` / `asset_outcome` rows after a rename.
 *
 * Both tables are keyed by `asset_ref` TEXT (the bare `makeAssetRef`
 * `type:name` form — NOT entry_id; see core/state/migrations.ts 009/010), so
 * the salience boost `loadSalienceRankScores` applies at search time and the
 * outcome-loop history would otherwise strand on the old ref until the next
 * improve run re-mints a type-weight stub row — losing a distill-written
 * content-derived `encoding_salience` for good.
 *
 * Collision policy (conservative): a row already sitting at the NEW ref can
 * only be an orphan of a previously deleted asset — the caller has verified
 * no file exists at the target — so the LIVE asset's history wins: the
 * orphan row is deleted and the moved asset's row re-keyed onto the ref.
 *
 * No state.db means the improve loop never ran and is complete as a no-op. A
 * legacy missing table is likewise complete. Other failures retain the
 * committed move journal and block completion so a later mutation retries the
 * non-regenerable state update rather than silently stranding it.
 */
function rekeyStateDbForMove(
  fromRef: string,
  toRef: string,
  includeTwin: boolean,
  sourceName: string,
  sourceRoot: string,
  includeLegacyBare: boolean,
): { complete: boolean; warning: string | null } {
  const statePath = getStateDbPath();
  try {
    if (!fs.existsSync(statePath)) return { complete: true, warning: null };
    if (!sourceName || !sourceRoot) return { complete: false, warning: "move source identity is unavailable" };
    const origins = new Set([sourceName]);
    if (sourceName === "stash" && includeLegacyBare) origins.add("local");
    const pairs: Array<[string, string]> = [...origins].map((origin) => [
      `${origin}//${fromRef}`,
      `${origin}//${toRef}`,
    ]);
    if (includeLegacyBare) pairs.push([fromRef, toRef]);
    if (includeTwin) {
      for (const origin of origins) {
        pairs.push([`${origin}//${fromRef}.derived`, `${origin}//${toRef}.derived`]);
      }
      if (includeLegacyBare) pairs.push([`${fromRef}.derived`, `${toRef}.derived`]);
    }
    const db = openStateDatabase();
    const tableFailures: string[] = [];
    try {
      db.exec(`PRAGMA busy_timeout = ${WRITE_PATH_INDEX_BUSY_TIMEOUT_MS}`);
      for (const table of ["asset_salience", "asset_outcome"] as const) {
        try {
          db.transaction(() => {
            for (const [oldRef, newRef] of pairs) {
              const moved = db.prepare(`SELECT asset_ref FROM ${table} WHERE asset_ref = ?`).get(oldRef);
              if (!moved) continue;
              db.prepare(`DELETE FROM ${table} WHERE asset_ref = ?`).run(newRef);
              db.prepare(`UPDATE ${table} SET asset_ref = ? WHERE asset_ref = ?`).run(newRef, oldRef);
            }
          })();
          mvMutationHookForTests?.(`state-${table}-rekeyed`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // The ONLY swallowable failure: the table is missing on an older
          // state.db (migrations run in the improve loop, never here) —
          // nothing of this kind to re-key. Anything else (lock timeout,
          // incompatible schema) strands history and must reach the report.
          if (/no such table/i.test(message)) continue;
          tableFailures.push(`${table}: ${message}`);
        }
      }
    } finally {
      db.close();
    }
    if (tableFailures.length > 0) {
      const warning =
        `state.db salience re-key failed (${tableFailures.join("; ")}) — the rename itself succeeded, but the ` +
        "asset's salience/outcome history stays keyed to the old ref until the next improve run re-mints it.";
      warnVerbose(`akm mv: ${warning}`);
      return { complete: false, warning };
    }
    return { complete: true, warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning =
      `state.db salience re-key failed (${message}) — the rename itself succeeded, but the asset's salience/` +
      "outcome history stays keyed to the old ref until the next improve run re-mints it.";
    warnVerbose(`akm mv: ${warning}`);
    return { complete: false, warning };
  }
}

function persistMoveEvent(journal: MoveJournal): void {
  const db = openStateDatabase();
  try {
    db.transaction(() => {
      insertEventOnce(db, {
        eventType: "mv",
        ts: journal.eventTs,
        ref: journal.toRef,
        metadata: {
          ...journal.eventMetadata,
          mutationTransactionId: journal.transactionId,
        },
        idempotencyKey: journal.transactionId,
        idempotencyMetadataKey: "mutationTransactionId",
      });
    })();
  } finally {
    db.close();
  }
}

async function finalizeMoveTransaction(transaction: MoveTransaction): Promise<{
  utilityPreserved: boolean;
  warnings: string[];
}> {
  const { journal } = transaction;
  validateCommittedMove(journal);
  const warnings: string[] = [];
  let utilityPreserved = true;
  if (journal.phase === "filesystem-committed") {
    const indexResult = rekeyIndexForMove({
      stashDir: path.dirname(path.dirname(path.dirname(transaction.transactionDir))),
      type: journal.type,
      oldName: journal.oldName,
      newName: journal.newName,
      oldPath: journal.oldPath,
      newPath: journal.newPath,
      fromRef: journal.fromRef,
      toRef: journal.toRef,
      twinOldPath: journal.twinOldPath,
      twinNewPath: journal.twinNewPath,
      sourceName: journal.sourceName,
      sourceRoot: journal.sourceRoot,
      includeLegacyBare: journal.includeLegacyBare,
    });
    utilityPreserved = indexResult.preserved;
    if (indexResult.warning) warnings.push(indexResult.warning);
    if (!indexResult.complete) throw new Error(indexResult.warning ?? "move index re-key did not complete");
    const touched = new Set<string>([journal.newPath]);
    if (journal.twinNewPath) touched.add(journal.twinNewPath);
    for (const citer of journal.citers) {
      if (citer.absPath === journal.oldPath || citer.absPath === journal.twinOldPath) continue;
      touched.add(citer.absPath);
    }
    const stashDir = path.dirname(path.dirname(path.dirname(transaction.transactionDir)));
    if (!(await indexWrittenAssets(stashDir, [...touched], { recoverMoves: false }))) {
      utilityPreserved = false;
      warnings.push("write-path index refresh failed; the derived index will heal on the next full index");
    }
    setMoveJournalPhase(transaction, "index-finalized");
  }
  if (journal.phase === "index-finalized") {
    const stateResult = rekeyStateDbForMove(
      journal.fromRef,
      journal.toRef,
      journal.twinNewPath !== null,
      journal.sourceName,
      journal.sourceRoot,
      journal.includeLegacyBare,
    );
    if (stateResult.warning) warnings.push(stateResult.warning);
    if (!stateResult.complete) throw new Error(stateResult.warning ?? "move state finalization did not complete");
    setMoveJournalPhase(transaction, "state-finalized");
  }
  if (journal.phase === "state-finalized") {
    persistMoveEvent(journal);
    mvMutationHookForTests?.("mv-event-persisted");
    setMoveJournalPhase(transaction, "event-finalized");
  }
  if (journal.phase === "event-finalized") setMoveJournalPhase(transaction, "committed");
  return { utilityPreserved, warnings };
}

// ── Command ───────────────────────────────────────────────────────────────────

export const mvCommand = defineJsonCommand({
  meta: {
    name: "mv",
    description:
      "Rename an asset within its type directory (Experimental). Moves the file (a memory's .derived.md twin " +
      "moves together), rewrites inbound refs across the writable stash in the same pass — body prose, " +
      "frontmatter ref lists (xrefs/refs/supersededBy/...), fenced code examples, task .yml files under tasks/, " +
      "workflow .yaml/.yml programs under workflows/, and alias spellings of the same asset (.md-suffixed, " +
      "local//-prefixed, and resolver-fallback forms are rewritten to the new canonical ref) — and re-keys the " +
      "search-index row in place (including its usage-event history) plus the state.db salience/outcome rows, " +
      "so the asset's accumulated usage-ranking history survives the rename. Read-only sources are scanned but " +
      "never written; their citing files are reported in `readOnlyCiters` as manual follow-ups. Operates on the " +
      "primary writable stash only. The source ref (and the target name) may carry the .md-suffixed alias " +
      "spelling — both are canonicalized — but resolver-fallback source spellings are rejected, naming the " +
      "canonical ref. Wiki refs are not supported (use `akm wiki lint` after a manual wiki rename); workflow " +
      "refs cannot be MOVED in v1 (workflows may be .yaml programs — rename the file manually and verify with " +
      "`akm lint`), though workflow files ARE rewritten as citers.",
  },
  args: {
    ref: {
      type: "positional",
      description: "Current asset ref (required), e.g. memory:projectA/old-note",
      // Optional in citty so run() is invoked even when omitted; re-validated
      // below to surface a structured UsageError (exit 2) instead of citty's
      // unstructured missing-argument failure. The "(required)" note in the
      // description keeps the rendered help honest about that contract.
      required: false,
    },
    newName: {
      type: "positional",
      description:
        "New name (required; subdirectories allowed, e.g. projectA/new-note), or a same-type ref like memory:new-note",
      required: false,
    },
  },
  async run({ args }) {
    const refArg = typeof args.ref === "string" ? args.ref.trim() : "";
    const targetArg = typeof args.newName === "string" ? args.newName.trim() : "";
    if (!refArg || !targetArg) {
      throw new UsageError(
        "Usage: akm mv <ref> <new-name>.",
        "MISSING_REQUIRED_ARGUMENT",
        "Pass the asset's current ref and its new name, e.g. `akm mv memory:projectA/old-note projectA/new-note`.",
      );
    }

    await withAssetMutationLease("mv", async () => {
      // ── Validation (everything before any write; a failure moves nothing) ──
      const source = parseAssetRef(refArg);
      if (source.origin && source.origin !== "local") {
        throw new UsageError(
          `akm mv operates on the primary writable stash only — the origin prefix "${source.origin}//" is not supported.`,
          "INVALID_FLAG_VALUE",
        );
      }
      if (source.type === "wiki") {
        throw new UsageError(
          "akm mv does not support wiki refs — wiki pages have their own xref + lint system. " +
            "Rename the page manually, fix citations in the same pass, and verify with `akm wiki lint <name>`.",
          "INVALID_FLAG_VALUE",
        );
      }
      if (source.type === "workflow") {
        throw new UsageError(
          "akm mv does not support workflow refs in v1 — workflows may live as .yaml/.yml programs, which the " +
            "flat-markdown rename path would misresolve or rename to .md. Rename the file manually under " +
            "workflows/ (keeping its extension), fix inbound refs in the same pass, and verify with `akm lint`.",
          "INVALID_FLAG_VALUE",
        );
      }
      if (!MV_SUPPORTED_TYPES.includes(source.type)) {
        throw new UsageError(
          `akm mv supports flat-markdown asset types (${MV_SUPPORTED_TYPES.join(", ")}); "${source.type}:" refs cannot be moved.`,
          "INVALID_FLAG_VALUE",
        );
      }
      // The `.derived` suffix is the distilled-twin marker: a twin's entry_key
      // must stay exactly `<base entry_key>.derived` (db.ts
      // getBaseBeliefStatesForDerivedTwins), so a twin can never move alone and
      // no independent asset may squat on the suffix. The `.md`-suffixed alias
      // spelling of a twin ref names the same file, so it is caught here too.
      if (source.type === "memory" && /\.derived(\.md)?$/.test(source.name)) {
        const baseRef = refToString({ type: "memory", name: source.name.replace(/\.derived(\.md)?$/, "") });
        throw new UsageError(
          `"${refToString({ type: source.type, name: source.name })}" names a .derived.md distilled twin — a twin ` +
            "cannot be moved on its own without breaking its belief-inheritance coupling to the base memory. " +
            `Rename the base ref instead (akm mv ${baseRef} <new-name>); the twin moves with it.`,
          "INVALID_FLAG_VALUE",
        );
      }

      // The target may be a bare name ("projectA/new-note") or a ref-shaped
      // spelling. Parsing the bare form through the same ref grammar gives it
      // identical name validation (traversal, null bytes, absolute paths).
      const target = parseAssetRef(targetArg.includes(":") ? targetArg : `${source.type}:${targetArg}`);
      if (target.origin) {
        throw new UsageError(
          `The target must be a name within the ${source.type} type — origin prefixes are not supported.`,
          "INVALID_FLAG_VALUE",
        );
      }
      if (target.type !== source.type) {
        throw new UsageError(
          `Cross-type move is not supported: "${refToString({ type: source.type, name: source.name })}" is a ` +
            `${source.type}: asset but the target names the ${target.type}: type. akm mv renames within one asset type.`,
          "INVALID_FLAG_VALUE",
        );
      }
      // Accept the `.md`-suffixed alias spelling of the TARGET, but operate on
      // the canonical extensionless name: every MV_SUPPORTED_TYPES layout is
      // the markdownSpec family, whose `toAssetPath` writes `<name>.md` either
      // way — so `bar.md` names the same file as `bar`, while a `bar.md`-keyed
      // toRef/entry_key would rewrite citers to a non-canonical ref and strand
      // the re-keyed history behind a row the write-path index pass (which
      // derives the canonical name `bar` from the file) immediately duplicates.
      const newName = target.name.endsWith(".md") ? target.name.slice(0, -".md".length) : target.name;
      if (!newName) {
        throw new UsageError(
          `Target "${targetArg}" names no asset once the .md extension is stripped — nothing moved.`,
          "INVALID_FLAG_VALUE",
        );
      }
      // Reject empty path segments: `path.posix.normalize` (parseAssetRef's
      // name normalization) PRESERVES a trailing slash — "bar/" (and "bar\",
      // normalized to it) sails through the traversal checks, and the file
      // would land at e.g. memories/bar/.md: a dot-prefixed file the index
      // walker skips, unreachable by `akm show`, with every citer rewritten to
      // the phantom ref "memory:bar/". Interior doubles ("a//b") are collapsed
      // by the normalization, so a trailing empty segment is the only shape
      // that reaches this check — but reject ANY empty segment regardless.
      if (newName.split("/").some((segment) => segment.length === 0)) {
        throw new UsageError(
          `Target "${targetArg}" contains an empty path segment (trailing "/" or "\\") — the file would be written ` +
            "as a hidden dotfile the index cannot see. Pass a name, e.g. `akm mv <ref> projectA/new-note` — nothing moved.",
          "INVALID_FLAG_VALUE",
        );
      }
      if (source.type === "memory" && newName.endsWith(".derived")) {
        throw new UsageError(
          `The target name "${newName}" ends with the reserved .derived suffix (the distilled-twin marker) — a base ` +
            "memory renamed onto it would masquerade as a twin of a memory that does not exist. Pick a name without " +
            "the suffix; a real twin always moves together with its base.",
          "INVALID_FLAG_VALUE",
        );
      }
      const toRef = refToString({ type: source.type, name: newName });

      const stashDir = resolveStashDir();
      const config = loadConfig();
      const configuredSources = resolveSourceEntries(stashDir, config);
      const primarySource = configuredSources.find((entry) => path.resolve(entry.path) === path.resolve(stashDir));
      const durableSourceName = primarySource?.registryId ?? "stash";
      const includeLegacyBare = shouldReadLegacyBareImproveState(durableSourceName, stashDir, config);
      await recoverInterruptedMoveTransactions(stashDir);
      const typeDir = TYPE_DIRS[source.type];
      const typeRoot = path.join(stashDir, typeDir);

      const oldRelPath = refToRelPath(source.type, source.name);
      const newRelPath = refToRelPath(source.type, newName);
      if (!oldRelPath || !newRelPath) {
        // Unreachable for MV_SUPPORTED_TYPES; guards a future registry change.
        throw new UsageError(
          `"${source.type}:" refs are not path-resolvable and cannot be moved.`,
          "INVALID_FLAG_VALUE",
        );
      }

      const oldPath = resolveMoveSourcePath(stashDir, oldRelPath, source.type, source.name);
      if (!oldPath) {
        throw new UsageError(
          `Cannot resolve ${refToString({ type: source.type, name: source.name })} in the writable stash at ` +
            `${stashDir} — nothing moved.`,
          "MISSING_REQUIRED_ARGUMENT",
          "akm mv renames assets in the primary writable stash only. Check the ref with `akm show <ref>` or `akm search`.",
        );
      }
      // The accepted spelling may be the `.md`-suffixed alias of the same file
      // (markdownSpec.toAssetPath maps `foo` and `foo.md` to memories/foo.md).
      // Everything keyed off the source — the citer rewrite patterns, the index
      // entry_key re-key, the state.db asset_ref re-key, the report — must use
      // the CANONICAL extensionless name derived from the resolved path, or the
      // real rows (keyed by the canonical spelling) are silently missed.
      const sourceName = deriveCanonicalAssetNameFromStashRoot(source.type, stashDir, oldPath) ?? source.name;
      const fromRef = refToString({ type: source.type, name: sourceName });

      const newPath = path.join(stashDir, newRelPath);
      // Defense-in-depth: parseAssetRef already rejects `../` traversal, but the
      // computed target must land inside the type root regardless.
      if (!isWithin(newPath, typeRoot)) {
        throw new UsageError(
          `Target "${targetArg}" escapes the ${typeDir}/ type root — nothing moved.`,
          "PATH_ESCAPE_VIOLATION",
        );
      }
      if (path.resolve(newPath) === path.resolve(oldPath)) {
        throw new UsageError(`Source and target resolve to the same file (${fromRef}) — nothing to move.`);
      }
      if (fs.existsSync(newPath)) {
        throw new UsageError(
          `Target ${toRef} already exists at ${toPosix(path.relative(stashDir, newPath))} — nothing moved.`,
          "RESOURCE_ALREADY_EXISTS",
          "Pick an unused name, or move the existing asset out of the way first.",
        );
      }

      // Memory `.derived.md` twin: moves together with its base (the entry_key
      // suffix coupling the belief-state inheritance relies on). The TARGET
      // twin-collision check runs whenever the target could carry a twin —
      // NOT only when the source has one: renaming a twin-less memory onto a
      // name whose orphaned `<name>.derived.md` lingers (consolidate/dedup
      // delete the base file without twin cleanup) would silently adopt the
      // stranger file as the renamed memory's distillation.
      const isBaseMemory = source.type === "memory" && !sourceName.endsWith(".derived");
      const twinOldPath = isBaseMemory ? oldPath.replace(/\.md$/, ".derived.md") : null;
      const hasTwin = twinOldPath !== null && fs.existsSync(twinOldPath);
      const targetTwinPath = isBaseMemory ? newPath.replace(/\.md$/, ".derived.md") : null;
      if (targetTwinPath && fs.existsSync(targetTwinPath)) {
        throw new UsageError(
          `Target twin ${toRef}.derived already exists at ${toPosix(path.relative(stashDir, targetTwinPath))} — ` +
            "renaming onto it would adopt that orphaned distilled twin as this memory's own. Nothing moved.",
          "RESOURCE_ALREADY_EXISTS",
          "Pick an unused name, or delete the orphaned .derived.md file first if it belongs to a removed memory.",
        );
      }
      const twinNewPath = hasTwin ? targetTwinPath : null;
      const sourceOriginalHash = hashFile(oldPath);
      const twinOriginalHash = hasTwin && twinOldPath ? hashFile(twinOldPath) : null;

      // ── Plan the inbound-ref rewrite (no writes yet) ───────────────────────
      const rewriteCtx = buildRewriteContext({
        type: source.type,
        fromRef,
        toRef,
        isBaseMemory,
        stashDir,
        oldPath,
        twinOldPath: hasTwin ? twinOldPath : null,
      });
      const plans: CiterRewritePlan[] = [];
      for (const absPath of collectCiterFiles(stashDir)) {
        let raw: string;
        try {
          raw = fs.readFileSync(absPath, "utf8");
        } catch {
          continue;
        }
        const { content, count } = rewriteRefs(raw, rewriteCtx);
        if (count > 0) {
          plans.push({
            absPath,
            relPath: toPosix(path.relative(stashDir, absPath)),
            count,
            content,
            originalHash: hashContent(raw),
          });
        }
      }

      // Read-only sources: scanned, never written — manual follow-ups.
      const readOnlyCiters: Array<{ file: string; count: number }> = [];
      for (const src of configuredSources) {
        if (path.resolve(src.path) === path.resolve(stashDir)) continue;
        for (const absPath of collectCiterFiles(src.path)) {
          let raw: string;
          try {
            raw = fs.readFileSync(absPath, "utf8");
          } catch {
            continue;
          }
          // Same detection as the writable pass (canonical + alias spellings,
          // alias tokens resolved against the WRITABLE stash where the moved
          // file lives) — count-only, never written.
          const { count } = rewriteRefs(raw, rewriteCtx);
          if (count > 0) readOnlyCiters.push({ file: absPath, count });
        }
      }

      // ── Apply citer edits, then rename last (see module docstring) ────────
      // The target's parent directory is created FIRST: if it cannot be (a
      // segment of the target's subdirectory path exists as a FILE, or the
      // parent is unwritable), the command must abort before any citer has
      // been edited — otherwise citers would already point at a ref whose
      // file never arrives.
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      const transaction = applyMoveFilesystem({
        stashDir,
        oldPath,
        newPath,
        twinOldPath: hasTwin ? twinOldPath : null,
        twinNewPath,
        sourceOriginalHash,
        twinOriginalHash,
        type: source.type,
        oldName: sourceName,
        newName,
        fromRef,
        toRef,
        sourceName: durableSourceName,
        sourceRoot: stashDir,
        includeLegacyBare,
        eventMetadata: {
          from: fromRef,
          to: toRef,
          rewroteFiles: plans.length,
          readOnlyCiters: readOnlyCiters.length,
          twinMoved: hasTwin,
        },
        plans,
      });

      // Filesystem commit is irreversible. Any finalization error leaves the
      // journal for the next mutation to finish forward; it never rolls back.
      const finalized = await finalizeMoveTransaction(transaction);
      const cleanupWarning = cleanupMoveTransaction(transaction.transactionDir);
      const warnings = [...finalized.warnings, ...(cleanupWarning ? [cleanupWarning] : [])];

      output("mv", {
        ok: true,
        from: fromRef,
        to: toRef,
        rewrote: plans.map((plan) => ({ file: plan.relPath, count: plan.count })),
        readOnlyCiters,
        utilityPreserved: finalized.utilityPreserved,
        // Additive: present only when a re-key could not be completed, so the
        // report (not just --verbose stderr) says WHY history may reset.
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    });
  },
});
