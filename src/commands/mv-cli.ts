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
 * embeddings / asset_salience rows keyed by entry_id — the "rename resets
 * learned ranking" cost the conventions warn about. This verb does the whole
 * pass: move the file, rewrite inbound refs, and re-key the index row IN
 * PLACE so the accumulated history survives.
 *
 * Scope (v1, Experimental — see STABILITY.md):
 *   - flat-markdown asset types only ({@link MV_SUPPORTED_TYPES});
 *   - the primary writable stash only (no `--target`);
 *   - the source ref must be the CANONICAL spelling — lint-resolver fallback
 *     spellings are rejected with the canonical ref named (see
 *     {@link resolveMoveSourcePath});
 *   - wiki refs are rejected (wikis have their own xref + lint system);
 *   - a memory's `.derived.md` twin moves together and keeps its
 *     `entry_key === <base entry_key> + ".derived"` coupling; a twin ref
 *     cannot be moved alone, and target names ending `.derived` are rejected
 *     (reserved suffix).
 *
 * Ordering (partial-failure mitigation — the operation spans FS + DB and is
 * NOT transactional): validate everything first, compute the full rewrite
 * plan, apply the citer edits, rename the file(s) LAST among the FS steps,
 * then re-key the index. The command is RE-RUNNABLE after an interruption:
 * a crash before the rename leaves the source resolvable under its old ref
 * (already-edited citers simply yield zero further rewrites on the retry);
 * a crash after the rename but before the index re-key is healed by the next
 * full `akm index` (at the cost of the utility history the re-key preserves).
 * Graph tables (graph_files) key extractions by file path and stay stale
 * until the next graph pass — acceptable, the graph is a derived cache.
 */

import fs from "node:fs";
import path from "node:path";
import { defineJsonCommand, output } from "../cli/shared";
import { parseAssetRef, refToString } from "../core/asset/asset-ref";
import { deriveCanonicalAssetNameFromStashRoot, TYPE_DIRS } from "../core/asset/asset-spec";
import { type AkmAssetType, isWithin, resolveStashDir, toPosix } from "../core/common";
import { UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { getDbPath } from "../core/paths";
import { warnVerbose } from "../core/warn";
import { closeDatabase, openExistingDatabase, rebuildFts, rekeyEntryInPlace } from "../indexer/db/db";
import { indexWrittenAssets, WRITE_PATH_INDEX_BUSY_TIMEOUT_MS } from "../indexer/index-written-assets";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { refToRelPath, resolveRefPathInStash } from "./lint/base-linter";

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
 *   - `task` / `env` / `secret` — not markdown assets.
 */
const MV_SUPPORTED_TYPES: readonly string[] = [
  "memory",
  "knowledge",
  "command",
  "agent",
  "workflow",
  "lesson",
  "session",
  "fact",
];

// ── Ref rewriting ─────────────────────────────────────────────────────────────

/**
 * Boundary grammar shared with lint's `REF_RE` (base-linter.ts): a ref starts
 * at line start or after whitespace / backtick / quote / `(`, and its slug
 * runs until whitespace, `"`, `'`, backtick, `)`, `]`, `>`, or `,`. Complete-
 * ref matching is what keeps a longer ref sharing the old ref as a prefix
 * (e.g. `memory:a/base-note-extra` when moving `memory:a/base-note`)
 * untouched.
 */
const REF_PREFIX_SRC = "(^|[\\s`\"'(])";
const REF_SUFFIX_SRC = "(?![^\\s\"'`)\\]>,\\n])";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the rewrite pattern for one old ref. When the source is a base
 * memory, the optional `.derived` tail also rewrites explicit twin refs
 * (`memory:a/note.derived` → `memory:a/new.derived`) — the twin file moves
 * together, so its ref must too. The tail group is empty-capturing otherwise
 * so the replacer's group indices stay stable.
 */
function buildRefPattern(fromRef: string, includeDerivedTail: boolean): RegExp {
  const tail = includeDerivedTail ? "(\\.derived)?" : "()";
  return new RegExp(`${REF_PREFIX_SRC}${escapeRegExp(fromRef)}${tail}${REF_SUFFIX_SRC}`, "gm");
}

/** Replace every boundary-matched occurrence, returning the count replaced. */
function rewriteRefs(content: string, pattern: RegExp, toRef: string): { content: string; count: number } {
  let count = 0;
  const next = content.replace(pattern, (_match, prefix: string, derivedTail: string | undefined) => {
    count += 1;
    return `${prefix}${toRef}${derivedTail ?? ""}`;
  });
  return { content: next, count };
}

// ── File walking ──────────────────────────────────────────────────────────────

/**
 * Every `.md` file under `root`, recursively. Skips dot-directories (index
 * state, `.cache/` mirrors) and `registry/` caches — the same read-only
 * carve-outs `akm lint --fix` honours (lint/index.ts).
 */
function collectMarkdownFiles(root: string): string[] {
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
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
  };
  walk(root);
  return results;
}

// ── Source resolution ─────────────────────────────────────────────────────────

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
  if (path.resolve(resolved) === path.resolve(stashDir, relPath)) return resolved;

  // Fallback hit — reject, steering to the canonical spelling when it exists.
  const typedRef = refToString({ type: refType, name: refName });
  const canonicalName = deriveCanonicalAssetNameFromStashRoot(refType, stashDir, resolved);
  const canonicalRelPath = canonicalName ? refToRelPath(refType, canonicalName) : null;
  if (
    canonicalName &&
    canonicalName !== refName &&
    canonicalRelPath &&
    path.resolve(stashDir, canonicalRelPath) === path.resolve(resolved)
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
    `"${typedRef}" resolves to ${toPosix(path.relative(stashDir, resolved))}, outside the ${TYPE_DIRS[refType]}/ ` +
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
 */
function rekeyIndexForMove(opts: {
  stashDir: string;
  type: string;
  oldName: string;
  newName: string;
  oldPath: string;
  newPath: string;
  toRef: string;
  twinOldPath: string | null;
  twinNewPath: string | null;
}): boolean {
  const dbPath = getDbPath();
  try {
    if (!fs.existsSync(dbPath)) return true;
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
      const rekeyed = rekeyEntryInPlace(db, {
        oldEntryKey: oldKey,
        newEntryKey: newKey,
        newName: opts.newName,
        newFilePath: opts.newPath,
      });
      if (rekeyed === null && strandedRow(opts.oldPath)) preserved = false;
      let twinRekeyed: number | null = null;
      if (opts.twinNewPath) {
        // The twin coupling (db.ts getBaseBeliefStatesForDerivedTwins) is
        // `twin entry_key === base entry_key + ".derived"` — preserved here.
        twinRekeyed = rekeyEntryInPlace(db, {
          oldEntryKey: `${oldKey}.derived`,
          newEntryKey: `${newKey}.derived`,
          newName: `${opts.newName}.derived`,
          newFilePath: opts.twinNewPath,
          newDerivedFrom: opts.toRef,
        });
        if (twinRekeyed === null && opts.twinOldPath && strandedRow(opts.twinOldPath)) preserved = false;
      }
      if (rekeyed !== null || twinRekeyed !== null) {
        rebuildFts(db, { incremental: true });
      }
    } finally {
      closeDatabase(db);
    }
    if (!preserved) {
      warnVerbose(
        "akm mv: the index holds a row for the moved file under an unexpected key — its utility history was not " +
          "re-keyed and resets on the next `akm index`.",
      );
    }
    return preserved;
  } catch (error) {
    warnVerbose(
      "akm mv: index re-key skipped (the index heals on the next `akm index`; utility history for the moved asset may reset):",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

// ── Command ───────────────────────────────────────────────────────────────────

export const mvCommand = defineJsonCommand({
  meta: {
    name: "mv",
    description:
      "Rename an asset within its type directory (Experimental). Moves the file (a memory's .derived.md twin " +
      "moves together), rewrites inbound refs across the writable stash in the same pass — body prose, " +
      "frontmatter ref lists (xrefs/refs/supersededBy/...), and fenced code examples — and re-keys the search " +
      "index row in place so the asset's accumulated usage-ranking history (utility scores, embeddings, " +
      "salience) survives the rename. Read-only sources are scanned but never written; their citing files are " +
      "reported in `readOnlyCiters` as manual follow-ups. Operates on the primary writable stash only, and the " +
      "source ref must be the asset's canonical spelling (alias/fallback spellings are rejected, naming the " +
      "canonical ref). Wiki refs are not supported (use `akm wiki lint` after a manual wiki rename).",
  },
  args: {
    ref: {
      type: "positional",
      description: "Current asset ref, e.g. memory:projectA/old-note",
      // Optional in citty so run() is invoked even when omitted; re-validated
      // below to surface a structured UsageError (exit 2) instead of citty's
      // unstructured missing-argument failure.
      required: false,
    },
    newName: {
      type: "positional",
      description: "New name (subdirectories allowed, e.g. projectA/new-note), or a same-type ref like memory:new-note",
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
    if (!MV_SUPPORTED_TYPES.includes(source.type)) {
      throw new UsageError(
        `akm mv supports flat-markdown asset types (${MV_SUPPORTED_TYPES.join(", ")}); "${source.type}:" refs cannot be moved.`,
        "INVALID_FLAG_VALUE",
      );
    }
    // The `.derived` suffix is the distilled-twin marker: a twin's entry_key
    // must stay exactly `<base entry_key>.derived` (db.ts
    // getBaseBeliefStatesForDerivedTwins), so a twin can never move alone and
    // no independent asset may squat on the suffix.
    if (source.type === "memory" && source.name.endsWith(".derived")) {
      const baseRef = refToString({ type: "memory", name: source.name.slice(0, -".derived".length) });
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
    const newName = target.name;
    if (source.type === "memory" && newName.endsWith(".derived")) {
      throw new UsageError(
        `The target name "${newName}" ends with the reserved .derived suffix (the distilled-twin marker) — a base ` +
          "memory renamed onto it would masquerade as a twin of a memory that does not exist. Pick a name without " +
          "the suffix; a real twin always moves together with its base.",
        "INVALID_FLAG_VALUE",
      );
    }
    const fromRef = refToString({ type: source.type, name: source.name });
    const toRef = refToString({ type: source.type, name: newName });

    const stashDir = resolveStashDir();
    const typeDir = TYPE_DIRS[source.type];
    const typeRoot = path.join(stashDir, typeDir);

    const oldRelPath = refToRelPath(source.type, source.name);
    const newRelPath = refToRelPath(source.type, newName);
    if (!oldRelPath || !newRelPath) {
      // Unreachable for MV_SUPPORTED_TYPES; guards a future registry change.
      throw new UsageError(`"${source.type}:" refs are not path-resolvable and cannot be moved.`, "INVALID_FLAG_VALUE");
    }

    const oldPath = resolveMoveSourcePath(stashDir, oldRelPath, source.type, source.name);
    if (!oldPath) {
      throw new UsageError(
        `Cannot resolve ${fromRef} in the writable stash at ${stashDir} — nothing moved.`,
        "MISSING_REQUIRED_ARGUMENT",
        "akm mv renames assets in the primary writable stash only. Check the ref with `akm show <ref>` or `akm search`.",
      );
    }

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
    // suffix coupling the belief-state inheritance relies on).
    const isBaseMemory = source.type === "memory" && !source.name.endsWith(".derived");
    const twinOldPath = isBaseMemory ? oldPath.replace(/\.md$/, ".derived.md") : null;
    const hasTwin = twinOldPath !== null && fs.existsSync(twinOldPath);
    const twinNewPath = hasTwin ? newPath.replace(/\.md$/, ".derived.md") : null;
    if (twinNewPath && fs.existsSync(twinNewPath)) {
      throw new UsageError(
        `Target twin ${toRef}.derived already exists at ${toPosix(path.relative(stashDir, twinNewPath))} — nothing moved.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }

    // ── Plan the inbound-ref rewrite (no writes yet) ───────────────────────
    const pattern = buildRefPattern(fromRef, isBaseMemory);
    const plans: Array<{ absPath: string; relPath: string; count: number; content: string }> = [];
    for (const absPath of collectMarkdownFiles(stashDir)) {
      let raw: string;
      try {
        raw = fs.readFileSync(absPath, "utf8");
      } catch {
        continue;
      }
      const { content, count } = rewriteRefs(raw, pattern, toRef);
      if (count > 0) {
        plans.push({ absPath, relPath: toPosix(path.relative(stashDir, absPath)), count, content });
      }
    }

    // Read-only sources: scanned, never written — manual follow-ups.
    const readOnlyCiters: Array<{ file: string; count: number }> = [];
    let sources: ReturnType<typeof resolveSourceEntries> = [];
    try {
      sources = resolveSourceEntries(stashDir);
    } catch (error) {
      warnVerbose(
        "akm mv: could not enumerate configured sources for the read-only citer scan:",
        error instanceof Error ? error.message : String(error),
      );
    }
    for (const src of sources) {
      if (path.resolve(src.path) === path.resolve(stashDir)) continue;
      for (const absPath of collectMarkdownFiles(src.path)) {
        let raw: string;
        try {
          raw = fs.readFileSync(absPath, "utf8");
        } catch {
          continue;
        }
        const { count } = rewriteRefs(raw, pattern, toRef);
        if (count > 0) readOnlyCiters.push({ file: absPath, count });
      }
    }

    // ── Apply citer edits, then rename last (see module docstring) ────────
    for (const plan of plans) {
      fs.writeFileSync(plan.absPath, plan.content, "utf8");
    }
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);
    if (twinOldPath && twinNewPath) {
      fs.renameSync(twinOldPath, twinNewPath);
    }

    // ── Index: re-key in place, then reindex the touched files ────────────
    const utilityPreserved = rekeyIndexForMove({
      stashDir,
      type: source.type,
      oldName: source.name,
      newName,
      oldPath,
      newPath,
      toRef,
      twinOldPath: hasTwin ? twinOldPath : null,
      twinNewPath,
    });
    // Rewritten citers (and the moved file itself) go through the standard
    // write-path reindex so their FTS hints reflect the new ref immediately.
    // Fail-open; an absent/empty index is skipped inside the helper.
    const touched = new Set<string>([newPath]);
    if (twinNewPath) touched.add(twinNewPath);
    for (const plan of plans) {
      // A self-citing moved file was edited at its OLD path but now lives at
      // the new one; report the file that exists.
      if (plan.absPath === oldPath) continue;
      if (twinOldPath && plan.absPath === twinOldPath) continue;
      touched.add(plan.absPath);
    }
    await indexWrittenAssets(stashDir, [...touched]);

    appendEvent({
      eventType: "mv",
      ref: toRef,
      metadata: {
        from: fromRef,
        to: toRef,
        rewroteFiles: plans.length,
        readOnlyCiters: readOnlyCiters.length,
        twinMoved: hasTwin,
      },
    });

    output("mv", {
      ok: true,
      from: fromRef,
      to: toRef,
      rewrote: plans.map((plan) => ({ file: plan.relPath, count: plan.count })),
      readOnlyCiters,
      utilityPreserved,
    });
  },
});
