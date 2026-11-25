// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The AKM workspace's own `akm` adapter.
 *
 * A BEHAVIOR-PRESERVING PORT that reproduces
 * TODAY'S classification and placement VERBATIM by REUSING the existing matcher
 * stack. It is NOT re-derived onto frontmatter `type` (that is the sibling
 * `okf` adapter's job), NOT split per-`type` (the 14 AKM formats are `type`
 * VALUES the single `akm` adapter emits), and introduces NO new
 * positional/directory heuristics of its own.
 *
 * ── identify / spellings / describe ──
 *
 * What an akm bundle holds, and under which id, is decided by the file's PATH alone: `identify` is the file's path
 * inside the bundle minus the type's own suffix (`refForFile`: skill = its dir, script keeps its extension, Markdown
 * strips `.md`, env/task strip their ext, secret/session keep the natural path). `spellings` inverts it over every
 * placement spec, the folder's own type first. The TYPE of a loose `.md` (one no folder types) is the content's, as
 * before the adapter refactor (`recognizeMatch`: `type: workflow`, `agent:`, `$ARGUMENTS`, `model:`, else knowledge),
 * and only `describe` (index time) reads it; a typed folder beats frontmatter. `describe` carries the full index-time
 * metadata surface and may read the file.
 *
 * The winning `MatchResult.renderer` is carried on `documentJson.renderer` so
 * presentation can be wired via `TYPE_PRESENTATION` without a new
 * `IndexDocument` field.
 *
 * ── validate ──
 *
 * The shared base checks (`createBaseChecker`: unquoted-colon / missing-updated /
 * stale-path / missing-ref / redacted-content), then the
 * per-type linters (SkillLinter/WorkflowLinter/TaskLinter/…) in `akm-lint.ts`.
 *
 * ── Cycle-safety ──
 *
 * This module VALUE-imports `matchers.ts` (indexer/walk) for classification and
 * `asset-placement.ts` (core/asset) for placement — delegating to the existing
 * logic, not re-implementing it. Neither is a taxonomy import-cycle (SCC)
 * participant: `matchers.ts` resolves renderers via `type-presentation.ts`, and
 * `asset-placement.ts` is a pure leaf (only Node builtins + `recognition-util`).
 * Nothing in `src/` imports this adapter back except the `adapters/index.ts`
 * barrel — which is NOT test-only: `core/adapter/registry.ts:33` imports it
 * in production for the frozen `BUILTIN_ADAPTERS` list
 * (`installations.ts#detectAdapterId`, `provider-utils.ts#detectStashRoot`).
 * The adapter is still itself a leaf, since neither the barrel nor the
 * registry import anything that imports back into this file.
 */

import fs from "node:fs";
import path from "node:path";
import type { AdapterRenderedExecutionSource } from "../../../execution/source";
import {
  getMarkdownFragmentContent,
  hasMarkdownFragmentContent,
  setMarkdownFragmentContent,
} from "../../../indexer/passes/markdown-projection";
import { applyPostContributorFields, applyPreContributorFields } from "../../../indexer/passes/metadata";
import {
  assetPathCandidatesForName,
  deriveCanonicalAssetNameFromStashRoot,
  isSecretSidecar,
  placementTypes,
  refForFile,
  stashDirNames,
  typeForStashDir,
} from "../../asset/asset-placement";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { LintFindings, LintRun } from "../../lint/types";
import type { AssetEntry } from "../bundle-adapter";
import { buildFileContext, type FileContext, fileContextOfEntry, type MatchResult } from "../directory/file-context";
import type { PathFileContext } from "../directory/matchers";
import { placeTypeOf } from "../directory/place-rules";
import { executionDefaultsFromFrontmatter, renderMarkdownExecutionSource } from "../execution-source";
import type { FileChange } from "../file-change";
import { recognizeMatch, recognizeMatchByPath } from "../recognize-match";
import { type Bundle, type IndexDocument, type IndexMetadata, rootOf } from "../types";
import type { FileDiagnostic, FileValidateContext } from "../validate-context";
import { AkmFormatAdapterBase } from "./akm-format";
import { derivedSiblingPath, perTypeDiagnostics, skillDirectoryDiagnostics, type TypeCheckInput } from "./akm-lint";
import { applyFoldedMetadata, extractPackageMetadata, foldRecognizedMetadata } from "./akm-metadata";
import { createBaseChecker, hashContent, type ParsedForValidate, parseForValidate, RESERVED_FILES } from "./shared";

// `recognizeMatch` + the builtin matcher list moved to the cycle-free leaf
// `../recognize-match` so both this adapter AND the indexer
// metadata pass import it without closing a metadata ↔ adapter cycle. Re-exported
// here so existing `akm-adapter` importers (tests, sibling modules) are
// unaffected.
export { recognizeMatch } from "../recognize-match";

/**
 * OKF reserved structural files: `index.md` (directory listing) and `log.md` (update
 * history) are bundle structure at EVERY depth — never a concept document. The
 * `okf` / `llm-wiki` adapters already exclude them (`shared.ts`'s
 * `RESERVED_FILES`); this brings the `akm` adapter into conformance so a
 * `knowledge/index.md` never classifies as a `knowledge` item. Case-insensitive,
 * matched on the bare filename so the exclusion holds at any depth.
 */
/** True when `name` (a bare file name) is an OKF reserved file, case-insensitively. */
function isReservedFileName(name: string): boolean {
  return RESERVED_FILES.has(name.toLowerCase());
}

/**
 * AKM-stash indexing policy, moved here from the indexer's `shouldIndexStashFile`
 * pre-filter. Each adapter
 * abstains on its own bundle's files; the core walk keeps only universal hygiene.
 *
 * Path-based ONLY: a file's bytes are never read. Returns `true` when the `akm`
 * adapter must ABSTAIN (no asset):
 *   - a bundle's root README (it describes the bundle itself);
 *   - a `.sensitive`/`.lock` sidecar under any `secrets/` ancestor (`.sensitive` is a retired marker).
 */
function akmStashAbstains(relPath: string): boolean {
  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return false;

  // A bundle's root README describes the bundle itself; it is not an AKM
  // knowledge asset. Nested README files remain adapter-owned documentation
  // and are handled by the normal typed-directory matcher policy.
  if (segments.length === 1 && segments[0]?.toLowerCase() === "readme.md") return true;

  // Any ancestor directory counts, matching the directory matcher's rule, so a
  // nested `projects/x/secrets/` honors its markers too.
  const ancestorDirs = segments.slice(0, -1);
  return ancestorDirs.includes("secrets") && isSecretSidecar(relPath);
}

/**
 * The search-surface `IndexDocument` fields that have NO first-class `IndexDocument`
 * home and therefore ride `documentJson` so the persist-time fold
 * (`search-fields.ts`) can still reach them — the exact set
 * `buildSearchFields` folds into the `hints`/`content` FTS columns beyond the
 * first-class name/description/tags/aliases/searchHints, plus the provenance the
 * tests read (renderer/source). Kept as a named list so the fold surface and
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
  "source",
  "category",
  "supersededBy",
  "contradictedBy",
  "run",
  "setup",
  "cwd",
  "wikiRole",
  "sources",
  "evidenceSources",
  "evidence",
  // #935: a workflow's step targets and a task's target, read as declared links.
  "uses",
  // D2 (#730): the OKF v0.2 provenance `promoteProposal` stamps onto AKM-native
  // writes (generated/verified/sources, namespaced — see `types.ts`'s
  // `OkfProvenance` doc). Carried so the akm adapter rereads what it wrote and
  // `akm show` surfaces it, exactly like every other field in this list.
  "provenance",
  // #1453: the other frontmatter keys, read only by `--filter` / `--prefer`.
  "frontmatter",
] as const satisfies readonly (keyof IndexDocument)[];

/**
 * Map the fully-assembled `IndexDocument` (produced by the shared metadata
 * pipeline) onto the metadata the index records. First-class ranking/embedding
 * fields land on named IndexDocument fields; every other search-surface or
 * signal field rides `documentJson` (opaque adapter extras) so nothing the
 * ranking/embedding/filter inputs read is lost.
 * The winning renderer name is carried on `documentJson.renderer`.
 */
function indexMetadataFromEntry(
  entry: IndexDocument,
  base: Pick<IndexDocument, "hash" | "type">,
  rendererName: string,
): IndexMetadata {
  const extras: Record<string, unknown> = { renderer: rendererName };
  for (const field of DOCUMENT_JSON_CARRIED_FIELDS) {
    const value = entry[field];
    if (value !== undefined) extras[field] = value;
  }

  const doc: IndexMetadata = {
    ...base,
    name: entry.name,
    documentJson: extras,
  };
  // First-class search + signal fields (only when present).
  if (entry.description !== undefined) doc.description = entry.description;
  if (entry.tags !== undefined) doc.tags = entry.tags;
  if (entry.content !== undefined) doc.content = entry.content;
  if (entry.contentTruncated !== undefined) doc.contentTruncated = entry.contentTruncated;
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
  if (entry.created !== undefined) doc.created = entry.created;
  if (entry.updated !== undefined) doc.updated = entry.updated;
  if (entry.observed !== undefined) doc.observed = entry.observed;
  if (entry.expires !== undefined) doc.expires = entry.expires;
  // Internal fragment substrate follows the recognition projection without
  // becoming an IndexDocument field or serialized search payload.
  if (hasMarkdownFragmentContent(entry)) setMarkdownFragmentContent(doc, getMarkdownFragmentContent(entry));
  return doc;
}

/** A file's path fields, for the matchers: nothing is read. */
function pathContext(relPath: string) {
  return buildFileContext("/", path.posix.join("/", relPath));
}

/**
 * What the akm adapter makes of the file at `relPath`, with its ref and canonical name; `null` when the path is no
 * asset (a reserved structural file, one the adapter abstains on, one no matcher claims, or one whose placement gives
 * no ref). `recognize` says how the type is found: by the path alone, or by the file's content as well.
 */
function classify(
  relPath: string,
  recognize: (file: PathFileContext) => MatchResult | null,
): { match: MatchResult; conceptId: string; canonicalName: string } | null {
  const file = pathContext(relPath);
  // `index.md` / `log.md` are OKF reserved structural files at
  // every depth — never items. Excluded BEFORE classification so a directory
  // listing or update log never becomes a `knowledge` (or other) concept.
  if (isReservedFileName(file.fileName)) return null;
  // Adapter-owned filtering: AKM-stash policy (formerly the indexer's
  // `shouldIndexStashFile` pre-filter).
  if (akmStashAbstains(relPath)) return null;
  const match = recognize(file);
  if (match === null) return null;
  // The ref is the file's bundle-relative path minus the type's own suffix;
  // `entry.name` below keeps the canonical name relative to the type folder
  // (identity != search text). Invalid placements are not projected onto a
  // different identity.
  const conceptId = refForFile(match.type, "/", file.absPath);
  const canonicalName = deriveCanonicalAssetNameFromStashRoot(match.type, "/", file.absPath);
  if (conceptId === undefined || canonicalName === undefined) return null;
  return { match, conceptId, canonicalName };
}

/** {@link classify} by the path alone: reads nothing. The id of an asset, and the type the write gates use. */
export function classifyAkmPath(relPath: string) {
  return classify(relPath, recognizeMatchByPath);
}

/** {@link classify} with the file's content: the type the index records (`akm lint` and `describe`). */
export function classifyAkmFile(relPath: string, file: FileContext) {
  return classify(relPath, () => recognizeMatch(file));
}

function describe(file: FileContext, relPath: string): IndexMetadata {
  const classified = classifyAkmFile(relPath, file);
  if (classified === null) throw new Error(`"${relPath}" is no akm asset.`);
  const { match, canonicalName } = classified;
  const dirPath = path.dirname(file.absPath);

  // describe carries the FULL index-time metadata surface,
  // reproducing `buildEntryFromFile`'s flat-walk metadata
  // output by SHARING its P1/P2/P4 assembly and substituting the synchronous
  // `foldRecognizedMetadata` (+ `applyFoldedMetadata`, which replicates the
  // in-place contributor precedence) for the async P3 renderer contributors.
  // `entry.name` = the BARE canonical name (conceptId minus the stash-subdir
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

  return indexMetadataFromEntry(
    entry,
    {
      // Hash over the full raw bytes (incrementality/fingerprints, `types.ts`
      // hash doc comment) — an opaque digest, not indexed content.
      hash: hashContent(file.content()),
      type: match.type,
    },
    match.renderer,
  );
}

/** {@link classifyAkmFile} for text that is not on disk (what `akm check` is given). */
export function classifyAkmText(relPath: string, raw: string) {
  return classifyAkmFile(relPath, buildOverlayContext("/", relPath, raw));
}

/** Render AKM-native command/agent Markdown into the shared execution source. */
function renderExecutionSource(c: Bundle, entry: AssetEntry): AdapterRenderedExecutionSource | null {
  const file = fileContextOfEntry(rootOf(c), entry);
  const document = akmAdapter.recognize(c, file);
  if (document?.type !== "command" && document?.type !== "agent") return null;
  if (!document.ref) return null;
  const raw = file.content();
  return renderMarkdownExecutionSource({
    kind: document.type === "command" ? "command" : "persona",
    raw,
    identity: {
      ref: document.ref,
      bundle: c.id,
      adapter: "akm",
      file: file.relPath,
    },
    defaults: (data) =>
      executionDefaultsFromFrontmatter(data, {
        kind: document.type === "command" ? "command" : "persona",
        allowTopLevelEngine: true,
      }),
  });
}

/**
 * A read-only {@link FileContext} backed by an OVERLAY string (a pending
 * change's content) instead of the live filesystem — the `validate` contract
 * ({@link BundleAdapter.validate} doc comment) forbids
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
    file: absPath,
    relPath,
    key: relPath,
    ext,
    fileName,
    parentDir,
    parentDirAbs,
    ancestorDirs,
    stashRoot: root,
    content: () => raw,
    bytes: () => Buffer.from(raw),
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
 * `validate` = shared base checks + the winning `type`'s per-type
 * extra checks, reproducing today's `akmLint`/`getLinterForType` dispatch
 * byte-for-byte (the FROZEN `lint/all-types.json` `perType` golden is the gate).
 *
 * Per change (non-delete, readable): the `type` is recovered by running the
 * SAME sync matcher arbitration ({@link recognizeMatch}) over an OVERLAY
 * FileContext ({@link buildOverlayContext}) — no live-FS read. `task` files
 * keep raw YAML for the canonical task-v3 parser and use no frontmatter;
 * everything else parses via `parseFrontmatter`.
 * Base checks (shared) then the per-type extra checks run; a `skills/` directory
 * pass reproduces `SkillLinter.lintDirectory` across the change set.
 */
async function validate(c: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]> {
  const diagnostics: FileDiagnostic[] = [];
  const seenSkillDirs = new Set<string>();
  const { check, rulesFor } = createBaseChecker(rootOf(c), ctx);

  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;

    const overlay = buildOverlayContext(rootOf(c), change.path, raw);
    const match = recognizeMatch(overlay);
    const type = match?.type;

    // Task parsing belongs to perTypeChecks' canonical v3 parser. Base
    // checks need only a frontmatter-free placeholder here.
    const parsed: ParsedForValidate =
      type === "task" ? { raw, data: {}, content: raw, frontmatter: null, bodyStartLine: 1 } : parseForValidate(raw);

    diagnostics.push(...check(change.path, parsed));
    const input: TypeCheckInput = {
      type,
      relPath: change.path,
      raw,
      data: parsed.data,
      frontmatter: parsed.frontmatter,
      body: parsed.content,
      ext: overlay.ext,
      rules: rulesFor(change.path),
      derivedSiblingExists: (await ctx.readFile(derivedSiblingPath(change.path))) !== null,
    };
    diagnostics.push(...perTypeDiagnostics(input, change.path));
    diagnostics.push(...(await skillDirectoryDiagnostics(change.path, seenSkillDirs, ctx)));
  }

  return diagnostics;
}

export class AkmAdapter extends AkmFormatAdapterBase {
  readonly id = "akm";
  // Bump when a change to the matchers (or `describe`) can retype or re-ref a
  // file that has not changed, or when the document records new fields from it
  // (0.9.4: frontmatter dates, #1228; 0.9.5: path refs, #1432; 0.9.7: selection frontmatter, #1453; 0.10.0: a wiki's
  // raw/ is no longer wiki-source; 0.10.1: a loose .md is typed by its content again): the version is
  // folded into each directory's freshness, so the next incremental `akm index`
  // re-drains it and re-files those rows, including old command refs inferred
  // from body placeholders and loose files' type-folder refs. Vectors are kept
  // when the search text is unchanged.
  readonly version = "0.10.1";
  override readonly writes = placementTypes();

  contentType(b: Bundle, entry: AssetEntry): string | undefined {
    return classifyAkmFile(entry.key, fileContextOfEntry(rootOf(b), entry))?.match.type;
  }

  declaredType(key: string): string | undefined {
    return placeTypeOf(key);
  }

  /** An akm bundle is linted by its sweep, with its fixes written as asset writes. */
  async lint(run: LintRun): Promise<LintFindings> {
    // Loaded here: the sweep reads through the asset facade, which loads the adapters.
    return (await import("./akm-sweep")).lintAkmBundle(run);
  }

  /** An akm asset is matched live, on the bytes the file has now. */
  override rendererFor(): string | undefined {
    return undefined;
  }

  protected identify(relPath: string): string | null {
    return classifyAkmPath(relPath)?.conceptId ?? null;
  }

  protected describe(_b: Bundle, file: FileContext): IndexMetadata {
    return describe(file, file.relPath);
  }

  protected override typeOf(relPath: string): string {
    const type = classifyAkmPath(relPath)?.match.type;
    if (type === undefined) throw new Error(`"${relPath}" is no akm asset.`);
    return type;
  }

  /**
   * Closed-form spellings (#857): every path that could hold `conceptId`. A ref is the file's bundle-relative path
   * minus the type's suffix, so this is `refForFile` inverted over every placement spec (`env`'s `.env`/`<name>.env`
   * duality included), the type of the ref's own folder first (`tasks/x.yml` before `tasks/x.md`), then in placement
   * order. A spelling `identify` gives another concept is left out by the base.
   */
  protected spellings(conceptId: string): string[] {
    const posix = conceptId.replace(/\\/g, "/");
    const home = typeForStashDir(posix.split("/")[0] ?? "");
    const types = [...placementTypes()].sort((left, right) => Number(right === home) - Number(left === home));
    return [...new Set(types.flatMap((type) => assetPathCandidatesForName(type, ".", posix)))].map((candidate) =>
      path.posix.normalize(candidate.replace(/\\/g, "/")),
    );
  }

  override renderExecutionSource(b: Bundle, entry: AssetEntry): AdapterRenderedExecutionSource | null {
    return renderExecutionSource(b, entry);
  }

  protected validateFiles(b: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]> {
    return validate(b, changes, ctx);
  }

  /** A skill's folder holds its `SKILL.md` and the resources that belong to it. */
  protected override packageDir(file: FileContext): string | undefined {
    return file.fileName === "SKILL.md" ? file.parentDirAbs : undefined;
  }

  /** The AKM workspace's owned stash subdirs: the placement stash-subdir names, feeding git exact-path staging. */
  override directoryList(_c: Bundle): string[] {
    return [...new Set(stashDirNames())];
  }

  /**
   * Install-time probe, reproducing today's stash-root detection
   * (`provider-utils.ts#detectStashRoot`/`hasStashDirs`): a root is an AKM
   * workspace root when it carries a `.stash` marker, multiple native placement
   * directories, or one native directory whose Markdown is absent or
   * declares the matching AKM type. The final check prevents an OKF bundle with
   * an unrelated open type under (for example) `knowledge/` from being claimed
   * by AKM merely because the directory name overlaps.
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
    const ownedDirs = entries.filter((entry) => entry.isDirectory() && ownedDirNames.has(entry.name));
    if (ownedDirs.length >= 2) return true;
    const only = ownedDirs[0];
    if (!only) return false;
    const expectedType = typeForStashDir(only.name);
    try {
      const markdown = fs
        .readdirSync(path.join(root, only.name), { withFileTypes: true })
        .find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
      if (!markdown) return true;
      const data = parseFrontmatter(fs.readFileSync(path.join(root, only.name, markdown.name), "utf8")).data;
      const declaredType = typeof data.type === "string" ? data.type.trim() : "";
      return !declaredType || declaredType === expectedType;
    } catch {
      return true;
    }
  }
}

export const akmAdapter = new AkmAdapter();
