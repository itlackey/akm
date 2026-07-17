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
 * synchronous. We reproduce it here by importing the SAME six builtin matcher
 * functions (`matchers.ts` `extensionMatcher` / `directoryMatcher` /
 * `parentDirHintMatcher` / `smartMdMatcher` / `wikiMatcher` /
 * `workflowProgramMatcher`) in the SAME order they are registered
 * (`builtinMatchers`, `matchers.ts:310-317`), collecting every non-null
 * `MatchResult` and picking the winner by **specificity descending, ties broken
 * by later-registered (higher index) winning** — byte-identical to
 * `runMatchers`'s `b.specificity - a.specificity` then `b.index - a.index`.
 * Because the matcher functions and the static `TYPE_TO_RENDERER` literal
 * (`asset-registry.ts:21-36`, all 14 built-in types present at load) are the
 * exact ones `runMatchers` uses, {@link recognizeMatch} agrees with the async
 * `runMatchers` on `type` / `specificity` / `renderer` for every input. This is
 * "use the existing matchers" literally — same functions, same arbitration.
 *
 * The winning `MatchResult.renderer` is carried on `documentJson.renderer` so
 * WI-C can wire presentation via `TYPE_PRESENTATION` without a new
 * `IndexDocument` field (WI-C owns presentation).
 *
 * ── conceptId (§5.1): per-`type` canonical name, reproduced ──
 *
 * conceptId = the winning type's canonical name, reproduced via
 * `asset-spec.ts#deriveCanonicalAssetNameFromStashRoot` (skill = its dir,
 * script keeps its extension, markdown strips `.md`, env/task strip their ext,
 * secret/session keep the natural path). The `type` is carried separately on
 * `IndexDocument.type`, per §0.2 (type ≠ identity).
 *
 * ── placeNew / directoryList / looksLikeRoot: type-driven placement ──
 *
 * Placement is type-driven today (`path-resolver.ts#buildDiskCandidates`
 * `:27-38`: `resolveAssetPathFromName(ref.type, join(root, TYPE_DIRS[ref.type]),
 * ref.name)`). §5.1 removes `type` from the ref, so {@link placeNew} recovers
 * it from the conceptId's LEADING path segment — the qualified `<stash-subdir>/
 * <name>` form of §1.3 — reverse-mapping that segment against `TYPE_DIRS` and
 * then delegating to the unchanged `resolveAssetPathFromName`. See the method
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
 * participant: `matchers.ts` resolves renderers via `type-presentation.ts`
 * (chunk-3 sever, not `asset-registry`), and `asset-placement.ts` is the pure
 * leaf extracted from `asset-spec.ts` precisely so this adapter avoids the
 * `asset-spec` → `asset-registry`/`output-renderers` SCC. Nothing in `src/`
 * imports this adapter back (only the test-only `adapters/index.ts` barrel does,
 * and nothing in `src/` imports THAT), so the adapter is itself a leaf — verified:
 * `bun scripts/lint-import-cycles.ts` stays at 18 and this module is NOT a participant.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AssetMatcher, FileContext, MatchResult } from "../../../indexer/walk/file-context";
import {
  directoryMatcher,
  extensionMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
  wikiMatcher,
  workflowProgramMatcher,
} from "../../../indexer/walk/matchers";
import {
  deriveCanonicalAssetNameFromStashRoot,
  resolveAssetPathFromName,
  TYPE_DIRS,
} from "../../asset/asset-placement";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { perTypeValidateChecks, skillDirectoryDiagnostics } from "./akm-lint";
import { foldRecognizedMetadata } from "./akm-metadata";
import { hashContent, nonEmptyString, type ParsedForValidate, runBaseValidateChecks } from "./shared";

/**
 * The six builtin matchers, in the SAME order `matchers.ts#registerBuiltinMatchers`
 * registers them (`builtinMatchers`, `matchers.ts:310-317`). The array index IS
 * the registration index `runMatchers` uses for tie-breaking.
 */
const AKM_MATCHERS: readonly AssetMatcher[] = [
  extensionMatcher,
  directoryMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
  wikiMatcher,
  workflowProgramMatcher,
];

/**
 * Synchronous reproduction of `file-context.ts#runMatchers`'s arbitration
 * (`:242-265`), minus its `ensureBuiltinsRegistered()` dynamic import. Runs
 * every builtin matcher in registration order, collects the non-null
 * `MatchResult`s, and returns the highest-specificity one (ties broken by the
 * later-registered matcher — higher index — winning). Returns null when no
 * matcher claims the file. Exported for the fidelity parity test that asserts
 * this agrees with the async `runMatchers`.
 */
export function recognizeMatch(file: FileContext): MatchResult | null {
  const hits: Array<{ result: MatchResult; index: number }> = [];
  for (let i = 0; i < AKM_MATCHERS.length; i++) {
    const result = AKM_MATCHERS[i](file);
    if (result !== null) hits.push({ result, index: i });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const specDiff = b.result.specificity - a.result.specificity;
    if (specDiff !== 0) return specDiff;
    return b.index - a.index;
  });
  return hits[0].result;
}

/** Reverse `TYPE_DIRS` (stash subdir → akm type). Built per call so a runtime-registered custom type is honored (live-delegation, not a snapshot). */
function stashDirToType(stashDir: string): string | undefined {
  for (const [type, dir] of Object.entries(TYPE_DIRS)) {
    if (dir === stashDir) return type;
  }
  return undefined;
}

/**
 * `name` = a sensible default (§ WI-B): a markdown concept's frontmatter
 * `title`/`name`, else the conceptId's last path segment. Non-markdown types
 * (env/secret/script/task) never have their body read for the name — the whole
 * file may be a secret value, so their name is the filename-derived last
 * segment only. Richer per-type metadata contributors are WI-C.
 */
function deriveName(file: FileContext, conceptId: string): string {
  const lastSegment = conceptId.split("/").pop() ?? conceptId;
  if (file.ext === ".md") {
    const fm = file.frontmatter();
    if (fm) {
      const title = nonEmptyString(fm.title) ?? nonEmptyString(fm.name);
      if (title !== undefined) return title;
    }
  }
  return lastSegment;
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  const match = recognizeMatch(file);
  if (match === null) return null;

  // conceptId = the winning type's per-type canonical name (§5.1: reproduce
  // AssetSpec.toCanonicalName). Fall back to the raw path minus its extension
  // only if the type's toCanonicalName abstains (e.g. a SKILL.md sitting
  // directly at the skills/ root with no name dir).
  const derived = deriveCanonicalAssetNameFromStashRoot(match.type, c.root, file.absPath);
  const conceptId = derived ?? file.relPath.replace(/\.[^./]+$/, "");

  const raw = file.content();
  const doc: IndexDocument = {
    ref: `${c.id}//${conceptId}`,
    bundle: c.id,
    component: c.id,
    conceptId,
    path: file.absPath,
    // Hash over the full raw bytes (incrementality/fingerprints, `types.ts`
    // hash doc comment) — an opaque digest, not indexed content.
    hash: hashContent(raw),
    adapterId: "akm",
    type: match.type,
    name: deriveName(file, conceptId),
  };

  // WI-C (spec §2): fold the 11 index-time metadata contributors into
  // `recognize`, keyed on the winning renderer NAME (`documentJson.renderer`).
  // First-class contributor fields land on the IndexDocument; the extras with
  // no first-class home (toc/parameters/source) ride `documentJson` alongside
  // the renderer name (do NOT invent new IndexDocument fields).
  const folded = foldRecognizedMetadata(match.renderer, file);
  if (folded.tags !== undefined) doc.tags = folded.tags;
  if (folded.searchHints !== undefined) doc.searchHints = folded.searchHints;
  if (folded.description !== undefined) doc.description = folded.description;
  if (folded.confidence !== undefined) doc.confidence = folded.confidence;

  const extras: Record<string, unknown> = { renderer: match.renderer };
  if (folded.toc !== undefined) extras.toc = folded.toc;
  if (folded.parameters !== undefined) extras.parameters = folded.parameters;
  if (folded.source !== undefined) extras.source = folded.source;
  doc.documentJson = extras;

  return doc;
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
  // `.md` (markdown types + skill + wiki), `.yaml`/`.yml` (workflow programs,
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
   * Type-driven placement (§5.1), reproducing `path-resolver.ts#buildDiskCandidates`
   * (`:27-38`): the primary candidate today is
   * `resolveAssetPathFromName(type, join(root, TYPE_DIRS[type]), name)`.
   *
   * §5.1 removes `type` from the ref, so the winning type is recovered from the
   * conceptId's LEADING path segment — the §1.3 qualified `<stash-subdir>/<name>`
   * form (e.g. `knowledge/http-caching`, `workflows/release`, `skills/<dir>`).
   * The leading segment is reverse-mapped against `TYPE_DIRS`; the remainder is
   * the per-type name handed to the unchanged `resolveAssetPathFromName`. An
   * unqualified conceptId (no recognized leading stash-subdir) falls back to a
   * direct `<root>/<conceptId>.md` — the same `${name}.md` fallback
   * `buildDiskCandidates` carries (`preserveDirectNameFallback`).
   *
   * NOTE (recognize/place conceptId spelling): `recognize()` emits the BARE
   * per-type canonical name on `IndexDocument.conceptId` (with `type` carried
   * separately, §0.2), whereas `placeNew` consumes the qualified path-form
   * (`<stash-subdir>/<name>`) because placement is type-driven and the bare name
   * cannot recover a type. Reconciling both onto one canonical stored spelling
   * is a cross-cutting index-persistence/ref concern owned downstream (Chunk
   * 3/5), out of WI-B's recognition+placement scope.
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
        return resolveAssetPathFromName(type, typeDir, rest);
      }
    }
    return path.join(c.root, `${posix}.md`);
  },

  /** The AKM workspace's owned stash subdirs (§7): the `TYPE_DIRS` values, feeding git exact-path staging. */
  directoryList(_c: BundleComponent): string[] {
    return [...new Set(Object.values(TYPE_DIRS))];
  },

  /**
   * Install-time probe (§1.2), reproducing today's stash-root detection
   * (`provider-utils.ts#detectStashRoot`/`hasStashDirs`): a root is an AKM
   * workspace root when it carries a `.stash` marker directory OR any immediate
   * subdirectory named after a `TYPE_DIRS` stash subdir. Pure stat/readdir; a
   * missing/unreadable root is not a root.
   */
  looksLikeRoot(root: string): boolean {
    try {
      if (fs.statSync(path.join(root, ".stash")).isDirectory()) return true;
    } catch {
      // no .stash marker — fall through to the type-dir probe
    }
    const stashDirNames = new Set(Object.values(TYPE_DIRS));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) => entry.isDirectory() && stashDirNames.has(entry.name));
  },
};
