// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The AKM workspace's own `akm` adapter — akm 0.9.0 chunk-2, WI-B.
 *
 * Implements `docs/design/akm-0.9.0-bundle-adapter-spec.md` §5.1 (BINDING) +
 * §6 + §7 (the `akm` row) EXACTLY: a BEHAVIOR-PRESERVING PORT that reproduces
 * TODAY'S classification and placement VERBATIM by REUSING the existing matcher
 * stack. It is NOT re-derived onto frontmatter `type` (that is the sibling
 * `okf` adapter's job, §5), NOT split per-`type` (the 14 AKM formats are `type`
 * VALUES the single `akm` adapter emits, §6/§0.2), and introduces NO new
 * positional/directory heuristics of its own.
 *
 * ── recognize (§5.1): the sync `runMatchers` reproduction ──
 *
 * `file-context.ts#runMatchers` (`:242-265`) is async ONLY because of its lazy
 * `ensureBuiltinsRegistered()` dynamic import; its ARBITRATION is pure and
 * synchronous. We reproduce it here by importing the SAME five builtin matcher
 * functions (`matchers.ts` `extensionMatcher` / `directoryMatcher` /
 * `parentDirHintMatcher` / `smartMdMatcher` / `workflowProgramMatcher`) in the
 * SAME order they are registered, collecting every non-null
 * `MatchResult` and picking the winner by **specificity descending, ties broken
 * by later-registered (higher index) winning** — byte-identical to
 * `runMatchers`'s `b.specificity - a.specificity` then `b.index - a.index`.
 * Because the matcher functions (which resolve renderer names via the static
 * `TYPE_PRESENTATION` table in `type-presentation.ts`, all built-in types
 * present at load) are the exact ones `runMatchers` uses, {@link recognizeMatch}
 * agrees with the async `runMatchers` on `type` / `specificity` / `renderer` for
 * every input. This is "use the existing matchers" literally — same functions,
 * same arbitration.
 *
 * The winning `MatchResult.renderer` is carried on `documentJson.renderer` so
 * WI-C can wire presentation via `TYPE_PRESENTATION` without a new
 * `IndexDocument` field (WI-C owns presentation).
 *
 * ── conceptId (§5.1 + ref-grammar decision D-R2): the QUALIFIED spelling ──
 *
 * conceptId = `<stash-subdir>/<canonical-name>` — the placement stash-subdir
 * (`stashDirFor(type)`) followed by the winning type's canonical name
 * (`deriveCanonicalAssetNameFromStashRoot`: skill = its dir, script keeps its
 * extension, markdown strips `.md`, env/task strip their ext, secret/session
 * keep the natural path). For markdown types this IS the OKF concept ID
 * (path − `.md`); it is the same spelling {@link placeNew} consumes, so
 * recognize/place share one identity (D-R2 resolved the earlier split). The
 * `type` is carried separately on `IndexDocument.type`, per §0.2 (type ≠
 * identity), and `entry.name` keeps the BARE canonical name for FTS parity.
 *
 * ── placeNew / directoryList / looksLikeRoot: type-driven placement ──
 *
 * Placement is type-driven (`path-resolver.ts#buildDiskCandidates`: the primary
 * candidate is `assetPathForName(ref.type, join(root, stashDirFor(ref.type)),
 * ref.name)`). §5.1 removes `type` from the ref, so {@link placeNew} recovers
 * it from the conceptId's LEADING path segment — the qualified `<stash-subdir>/
 * <name>` form of §1.3 — reverse-mapping that segment against the placement
 * stash-subdir map and then delegating to `assetPathForName`. See the method
 * doc for the recognize/place conceptId-spelling note.
 *
 * ── validate: base checks only (WI-B) ──
 *
 * Base validate checks only for this WI (shared `validateChangesWithBaseChecks`
 * — the ported unquoted-colon / missing-updated / stale-path / missing-ref).
 * The per-type linters (SkillLinter/WorkflowLinter/TaskLinter/…) are WI-C.
 *
 * ── Cycle-safety (chunk-3 cutover, baseline 18) ──
 *
 * This module VALUE-imports `matchers.ts` (indexer/walk) for classification and
 * `asset-placement.ts` (core/asset) for placement — delegating to the existing
 * logic, not re-implementing it. Neither is a taxonomy import-cycle (SCC)
 * participant: `matchers.ts` resolves renderers via `type-presentation.ts`, and
 * `asset-placement.ts` is a pure leaf (only Node builtins + `recognition-util`).
 * Nothing in `src/` imports this adapter back (only the test-only
 * `adapters/index.ts` barrel does, and nothing in `src/` imports THAT), so the
 * adapter is itself a leaf — verified: `bun scripts/lint-import-cycles.ts` stays
 * within baseline and this module is NOT a participant.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  applyPostContributorFields,
  applyPreContributorFields,
  extractPackageMetadata,
} from "../../../indexer/passes/metadata";
import type { FileContext } from "../../../indexer/walk/file-context";
import {
  assetPathForName,
  deriveCanonicalAssetNameFromStashRoot,
  placementTypes,
  stashDirFor,
  stashDirNames,
} from "../../asset/asset-placement";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import { recognizeMatch } from "../recognize-match";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { perTypeValidateChecks, skillDirectoryDiagnostics } from "./akm-lint";
import { applyFoldedMetadata, foldRecognizedMetadata } from "./akm-metadata";
import { hashContent, type ParsedForValidate, runBaseValidateChecks } from "./shared";

// `recognizeMatch` + the builtin matcher list moved to the cycle-free leaf
// `../recognize-match` (Chunk 5 M-b) so both this adapter AND the indexer
// metadata pass import it without closing a metadata ↔ adapter cycle. Re-exported
// here so existing `akm-adapter` importers (tests, sibling modules) are
// unaffected.
export { recognizeMatch } from "../recognize-match";

/**
 * OKF reserved structural files (ref-grammar decision D-R6, spec §5.1 /
 * adapter-spec §5.1/§6): `index.md` (directory listing) and `log.md` (update
 * history) are bundle structure at EVERY depth — never a concept document. The
 * `okf` / `llm-wiki` adapters already exclude them (`okf-adapter.ts`
 * `RESERVED_FILES`); this brings the `akm` adapter into conformance so a
 * `knowledge/index.md` never classifies as a `knowledge` item. Case-insensitive,
 * matched on the bare filename so the exclusion holds at any depth.
 */
const RESERVED_FILES = new Set(["index.md", "log.md"]);

/** True when `name` (a bare file name) is an OKF reserved file, case-insensitively (D-R6). */
function isReservedFileName(name: string): boolean {
  return RESERVED_FILES.has(name.toLowerCase());
}

/** Wiki-directory infrastructure files excluded at a `wikis/<name>/` root (ported from the retired `shouldIndexStashFile`). */
const WIKI_INFRA_FILES = new Set(["schema.md", "index.md", "log.md"]);

/**
 * AKM-stash indexing policy, moved here from the indexer's `shouldIndexStashFile`
 * pre-filter (owner ruling 2026-07-21 — adapter-owned filtering). Each adapter
 * abstains on its own bundle's files; the core walk keeps only universal hygiene.
 *
 * PATH/STAT-based ONLY — never reads `file.content()`, so the bytes-never-read
 * invariant for sensitive env/secret files holds by construction. Returns `true`
 * when the `akm` adapter must ABSTAIN (recognize → null):
 *   - an `env/…` `.env` file with a sibling `.sensitive` marker;
 *   - anything under the frozen legacy `vaults/` dir (the `vault` type is gone);
 *   - a `secrets/` `.sensitive`/`.lock` marker, or a secret with a sibling
 *     `<name>.sensitive` marker;
 *   - a `wikis/<name>/` root-level infra file (schema.md/index.md/log.md).
 */
function akmStashAbstains(root: string, absPath: string): boolean {
  const relPath = path.relative(root, absPath);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) return false;

  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return false;

  // Skip env `.env` files that have a sibling `.sensitive` marker file.
  if (segments[0] === "env" && (absPath.endsWith(".env") || path.basename(absPath) === ".env")) {
    if (fs.existsSync(absPath.replace(/\.env$/, ".sensitive"))) return true;
  }

  // The legacy `vaults/` directory (frozen copy left by the 0.8 migration) is
  // never indexed — the `vault` asset type was removed in 0.9.0.
  if (segments[0] === "vaults") return true;

  // Skip secret files that are themselves a `.sensitive` marker, or that have a
  // sibling `<name>.sensitive` marker. Secrets are otherwise indexed by name
  // only (their bytes are never read for classification here).
  if (segments[0] === "secrets") {
    if (absPath.endsWith(".sensitive") || absPath.endsWith(".lock")) return true;
    if (fs.existsSync(`${absPath}.sensitive`)) return true;
  }

  // Inside a `wikis/<name>/` directory, the root-level infrastructure files
  // schema.md / index.md / log.md are excluded.
  const wikisIdx = segments.indexOf("wikis");
  if (wikisIdx < 0 || wikisIdx + 1 >= segments.length) return false;
  const wikiRelativeSegments = segments.slice(wikisIdx + 2);
  return wikiRelativeSegments.length === 1 && WIKI_INFRA_FILES.has(wikiRelativeSegments[0]!);
}

/** Reverse the placement map (stash subdir → akm type). Built per call so a runtime-registered custom type is honored (live-delegation, not a snapshot). */
function stashDirToType(stashDir: string): string | undefined {
  for (const type of placementTypes()) {
    if (stashDirFor(type) === stashDir) return type;
  }
  return undefined;
}

/**
 * The search-surface `IndexDocument` fields that have NO first-class `IndexDocument`
 * home (spec §3) and therefore ride `documentJson` so the persist-time fold
 * (`search-fields.ts:28-33`) can still reach them — the exact set
 * `buildSearchFields` folds into the `hints`/`content` FTS columns beyond the
 * first-class name/description/tags/aliases/searchHints, plus the provenance the
 * WI-C tests read (renderer/source). Kept as a named list so the fold surface and
 * the mapping stay in lockstep.
 */
const DOCUMENT_JSON_CARRIED_FIELDS = [
  "examples",
  "usage",
  "intent",
  "xrefs",
  "pageKind",
  "whenToUse",
  "toc",
  "parameters",
  "bodyOpening",
  "source",
  "category",
  "supersededBy",
  "contradictedBy",
  "run",
  "setup",
  "cwd",
  "wikiRole",
  "sources",
  "generation",
  "sourceRefs",
  "evidenceSources",
] as const satisfies readonly (keyof IndexDocument)[];

/**
 * Map the fully-assembled `IndexDocument` (produced by the shared metadata
 * pipeline) onto an `IndexDocument` (spec §3). First-class ranking/embedding
 * fields land on named IndexDocument fields; every other search-surface or
 * signal field rides `documentJson` (opaque adapter extras) so nothing the
 * ranking/embedding/filter inputs read is lost — the M-b shadow-parity gate.
 * The winning renderer name is carried on `documentJson.renderer` (WI-C contract).
 */
function indexDocumentFromEntry(
  entry: IndexDocument,
  base: Pick<IndexDocument, "ref" | "bundle" | "component" | "conceptId" | "path" | "hash" | "adapterId" | "type">,
  rendererName: string,
): IndexDocument {
  const extras: Record<string, unknown> = { renderer: rendererName };
  for (const field of DOCUMENT_JSON_CARRIED_FIELDS) {
    const value = entry[field];
    if (value !== undefined) extras[field] = value;
  }

  const doc: IndexDocument = {
    ...base,
    name: entry.name,
    documentJson: extras,
  };
  // First-class search + signal fields (only when present).
  if (entry.description !== undefined) doc.description = entry.description;
  if (entry.tags !== undefined) doc.tags = entry.tags;
  if (entry.aliases !== undefined) doc.aliases = entry.aliases;
  if (entry.searchHints !== undefined) doc.searchHints = entry.searchHints;
  if (entry.quality !== undefined) doc.quality = entry.quality;
  if (entry.confidence !== undefined) doc.confidence = entry.confidence;
  if (entry.beliefState !== undefined) doc.beliefState = entry.beliefState;
  if (entry.currentBeliefRefs !== undefined) doc.currentBeliefRefs = entry.currentBeliefRefs;
  if (entry.scope !== undefined) doc.scope = entry.scope as Record<string, string>;
  if (entry.captureMode !== undefined) doc.captureMode = entry.captureMode;
  if (entry.lessonStrength !== undefined) doc.lessonStrength = entry.lessonStrength;
  if (entry.derivedFrom !== undefined) doc.derivedFrom = entry.derivedFrom;
  return doc;
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  // D-R6 (spec §5.1): `index.md` / `log.md` are OKF reserved structural files at
  // every depth — never items. Excluded BEFORE classification so a directory
  // listing or update log never becomes a `knowledge` (or other) concept.
  if (isReservedFileName(file.fileName)) return null;
  // Adapter-owned filtering (owner ruling 2026-07-21): AKM-stash policy that used
  // to live in the indexer's `shouldIndexStashFile` pre-filter. Path/stat-based —
  // `file.content()` is never read to reach this abstention.
  if (akmStashAbstains(c.root, file.absPath)) return null;
  const match = recognizeMatch(file);
  if (match === null) return null;

  // canonical name = the winning type's per-type canonical name (§5.1:
  // reproduce AssetSpec.toCanonicalName). Fall back to the BASENAME minus its
  // extension only if the type's toCanonicalName abstains (e.g. a `skills/x.md`
  // flat file, or a `SKILL.md` sitting directly at the skills/ root with no name
  // dir). The basename fallback is byte-identical to the pre-0.9.0 flat-walk's
  // `?? baseName` fallback (metadata.ts `generateMetadata`), so `entry.name`
  // stays the BARE canonical name — never the stash-root-relative path, which
  // would re-embed the `<stash-subdir>/` type prefix and double-prefix every
  // downstream legacy `type:name` ref (e.g. `skill:skills/x`).
  const derived = deriveCanonicalAssetNameFromStashRoot(match.type, c.root, file.absPath);
  const canonicalName = derived ?? path.basename(file.absPath).replace(/\.[^./]+$/, "");
  // conceptId = the QUALIFIED `<stash-subdir>/<canonical-name>` spelling
  // (ref-grammar decision D-R2): the same form `placeNew` consumes, and for
  // markdown types the OKF concept ID (path − .md). Both branches now feed a
  // BARE canonicalName (the abstain fallback is the basename, above), so the
  // stash-subdir is prefixed uniformly — a flat `skills/x.md` yields
  // `skills/x`, never the un-prefixed `x` or the double-prefixed
  // `skills/skills/x`. `entry.name` below keeps the BARE canonical name —
  // identity ≠ search text.
  const stashDir = stashDirFor(match.type);
  const conceptId = stashDir !== undefined ? `${stashDir}/${canonicalName}` : canonicalName;
  const dirPath = path.dirname(file.absPath);

  // Chunk 5 M-b: recognize now carries the FULL index-time metadata surface
  // (spec §2/§3), reproducing `buildEntryFromFile`'s flat-walk metadata
  // output by SHARING its P1/P2/P4 assembly and substituting the synchronous
  // `foldRecognizedMetadata` (+ `applyFoldedMetadata`, which replicates the
  // in-place contributor precedence) for the async P3 renderer contributors.
  // `entry.name` = the BARE canonical name (conceptId minus the D-R2 stash-subdir
  // prefix) so the FTS `name` column
  // matches the pre-0.9.0 indexer (search-behavior parity), NOT the frontmatter
  // title. Parity is by construction — the two paths differ only in the P3 step,
  // pinned equal by the akm-adapter fold-parity test.
  const entry: IndexDocument = {
    name: canonicalName,
    type: match.type,
    quality: "generated",
    confidence: 0.55,
    source: "filename",
  };
  applyPreContributorFields(entry, file.absPath, file, extractPackageMetadata(dirPath));
  applyFoldedMetadata(entry, foldRecognizedMetadata(match.renderer, file));
  applyPostContributorFields(entry, file.absPath, canonicalName, dirPath);

  return indexDocumentFromEntry(
    entry,
    {
      ref: `${c.id}//${conceptId}`,
      bundle: c.id,
      component: c.id,
      conceptId,
      path: file.absPath,
      // Hash over the full raw bytes (incrementality/fingerprints, `types.ts`
      // hash doc comment) — an opaque digest, not indexed content.
      hash: hashContent(file.content()),
      adapterId: "akm",
      type: match.type,
    },
    match.renderer,
  );
}

/**
 * A read-only {@link FileContext} backed by an OVERLAY string (a pending
 * change's content) instead of the live filesystem — the `validate` contract
 * ({@link BundleAdapter.validate} doc comment / adapter-spec §12.1) forbids
 * reading the live FS. It mirrors `buildFileContext`'s eager path-field
 * derivation exactly (so the matchers classify identically) and serves the
 * overlay bytes from `content()`/`frontmatter()`. `stat()` throws: no matcher
 * calls it, and there is no snapshot mtime to serve.
 */
function buildOverlayContext(root: string, relPathInput: string, raw: string): FileContext {
  const absPath = path.join(root, relPathInput);
  const relPath = path.relative(root, absPath).replace(/\\/g, "/");
  const ext = path.extname(absPath).toLowerCase();
  const fileName = path.basename(absPath);
  const parentDirAbs = path.dirname(absPath);
  const parentDir = path.basename(parentDirAbs);
  const relDir = path.dirname(relPath).replace(/\\/g, "/");
  const ancestorDirs = relDir === "." ? [] : relDir.split("/").filter((seg) => seg.length > 0);

  let cachedFrontmatter: Record<string, unknown> | null | undefined;
  let frontmatterComputed = false;

  return {
    absPath,
    relPath,
    ext,
    fileName,
    parentDir,
    parentDirAbs,
    ancestorDirs,
    stashRoot: root,
    content: () => raw,
    frontmatter: () => {
      if (!frontmatterComputed) {
        const parsed = parseFrontmatter(raw);
        cachedFrontmatter = Object.keys(parsed.data).length > 0 ? parsed.data : null;
        frontmatterComputed = true;
      }
      return cachedFrontmatter ?? null;
    },
    stat: () => {
      throw new Error("stat() is unavailable in a validate overlay FileContext");
    },
  };
}

/**
 * `validate` (spec §6) = shared base checks + the winning `type`'s per-type
 * extra checks, reproducing today's `akmLint`/`getLinterForType` dispatch
 * byte-for-byte (the FROZEN `lint/all-types.json` `perType` golden is the gate).
 *
 * Per change (non-delete, readable): the `type` is recovered by running the
 * SAME sync matcher arbitration ({@link recognizeMatch}) over an OVERLAY
 * FileContext ({@link buildOverlayContext}) — no live-FS read. `task` files are
 * parsed as pure YAML (mirroring `lint/index.ts`'s `subdir === "tasks"` branch)
 * so the TaskLinter's field checks see real data and `missing-updated` never
 * fires (frontmatter is `null`); everything else parses via `parseFrontmatter`.
 * Base checks (shared) then the per-type extra checks run; a `skills/` directory
 * pass reproduces `SkillLinter.lintDirectory` across the change set.
 */
async function validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const seenSkillDirs = new Set<string>();

  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;

    const overlay = buildOverlayContext(c.root, change.path, raw);
    const match = recognizeMatch(overlay);
    const type = match?.type;

    // Parse strategy per `lint/index.ts`: `task` → pure YAML (frontmatter null),
    // everything else → `parseFrontmatter`.
    let parsed: ParsedForValidate;
    if (type === "task") {
      let data: Record<string, unknown> = {};
      try {
        const doc = parseYaml(raw);
        if (doc && typeof doc === "object" && !Array.isArray(doc)) data = doc as Record<string, unknown>;
      } catch {
        data = {};
      }
      parsed = { data, content: raw, frontmatter: null };
    } else {
      const p = parseFrontmatter(raw);
      parsed = { data: p.data, content: p.content, frontmatter: p.frontmatter };
    }

    diagnostics.push(...(await runBaseValidateChecks(change.path, parsed, c.root, ctx)));
    diagnostics.push(
      ...(await perTypeValidateChecks({
        type,
        relPath: change.path,
        raw,
        data: parsed.data,
        frontmatter: parsed.frontmatter,
        body: parsed.content,
        ext: overlay.ext,
        ctx,
      })),
    );
    diagnostics.push(...(await skillDirectoryDiagnostics(change.path, seenSkillDirs, ctx)));
  }

  return diagnostics;
}

export const akmAdapter: BundleAdapter = {
  id: "akm",
  version: "0.9.0",
  // Recognized-extension HINT, derived from what the matchers accept (§6):
  // `.md` (markdown types + skill), `.yaml`/`.yml` (workflow programs,
  // task YAML), `.env` (env files), and the 16 SCRIPT_EXTENSIONS. This is a
  // NON-EXHAUSTIVE hint for the akm adapter: recognition is directory-driven
  // via `recognize()` (e.g. a bare `secrets/<anything>` file with no extension
  // is a `secret`), so `recognize()` — not this list — is the source of truth.
  extensions: [
    ".md",
    ".yaml",
    ".yml",
    ".env",
    ".sh",
    ".ts",
    ".js",
    ".ps1",
    ".cmd",
    ".bat",
    ".py",
    ".rb",
    ".go",
    ".pl",
    ".php",
    ".lua",
    ".r",
    ".swift",
    ".kt",
    ".kts",
  ],

  recognize,
  validate,

  /**
   * Type-driven placement (§5.1), reproducing `path-resolver.ts#buildDiskCandidates`:
   * the primary candidate is
   * `assetPathForName(type, join(root, stashDirFor(type)), name)`.
   *
   * §5.1 removes `type` from the ref, so the winning type is recovered from the
   * conceptId's LEADING path segment — the §1.3 qualified `<stash-subdir>/<name>`
   * form (e.g. `knowledge/http-caching`, `workflows/release`, `skills/<dir>`).
   * The leading segment is reverse-mapped against the placement stash-subdir map;
   * the remainder is the per-type name handed to `assetPathForName`. An
   * unqualified conceptId (no recognized leading stash-subdir) falls back to a
   * direct `<root>/<conceptId>.md` — the same `${name}.md` fallback
   * `buildDiskCandidates` carries (`preserveDirectNameFallback`).
   *
   * `recognize()` emits the SAME qualified spelling (ref-grammar decision
   * D-R2), so recognize/place share one canonical identity — the earlier
   * bare-vs-qualified split is resolved.
   */
  placeNew(c: BundleComponent, conceptId: string): string {
    const posix = conceptId.replace(/\\/g, "/");
    const slash = posix.indexOf("/");
    if (slash > 0) {
      const head = posix.slice(0, slash);
      const rest = posix.slice(slash + 1);
      const type = stashDirToType(head);
      if (type !== undefined && rest.length > 0) {
        const typeDir = path.join(c.root, head);
        return assetPathForName(type, typeDir, rest);
      }
    }
    return path.join(c.root, `${posix}.md`);
  },

  /** The AKM workspace's owned stash subdirs (§7): the placement stash-subdir names, feeding git exact-path staging. */
  directoryList(_c: BundleComponent): string[] {
    return [...new Set(stashDirNames())];
  },

  /**
   * Install-time probe (§1.2), reproducing today's stash-root detection
   * (`provider-utils.ts#detectStashRoot`/`hasStashDirs`): a root is an AKM
   * workspace root when it carries a `.stash` marker directory OR any immediate
   * subdirectory named after a placement stash subdir. Pure stat/readdir; a
   * missing/unreadable root is not a root.
   */
  looksLikeRoot(root: string): boolean {
    try {
      if (fs.statSync(path.join(root, ".stash")).isDirectory()) return true;
    } catch {
      // no .stash marker — fall through to the type-dir probe
    }
    const ownedDirNames = new Set(stashDirNames());
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) => entry.isDirectory() && ownedDirNames.has(entry.name));
  },
};
