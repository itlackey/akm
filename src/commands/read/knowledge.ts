// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Knowledge-command helpers extracted from `src/cli.ts`.
 *
 * Covers the shared pipeline for reading, naming, and writing markdown assets
 * (knowledge and memory) from the CLI. Extracted to keep the CLI entry point
 * focused on command definitions and routing.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse } from "yaml";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "../../core/asset/asset-create";
import { assembleAsset } from "../../core/asset/asset-serialize";
import { resolveAssetPathFromName } from "../../core/asset/asset-spec";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { isHttpUrl, isWithin, resolveStashDir, tryReadStdinText } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { resolveStashStandards } from "../../core/standards/resolve-stash-standards";
import { warn } from "../../core/warn";
import {
  commitWriteTargetBoundary,
  formatRefForMessage,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../core/write-source";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { fetchWebsiteMarkdownSnapshot, shouldAllowPrivateWebsiteUrlForTests } from "../../sources/website-ingest";
import { writeSupersededEdge } from "../improve/memory/memory-belief";
import { refExistsInAnyStash, refToRelPath, resolveRefPathInStash } from "../lint/base-linter";

const MAX_CAPTURED_ASSET_SLUG_LENGTH = 64;

// ── Asset-name normalisation ─────────────────────────────────────────────────

/**
 * Validate and normalise a markdown asset name supplied by the user.
 *
 * Strips the `.md` extension, rejects empty names, and guards against path
 * traversal (`..` segments). The `fallback` is used when `name` is undefined.
 */
export function normalizeMarkdownAssetName(name: string | undefined, fallback: string): string {
  const trimmed = (name ?? fallback)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/i, "");
  if (!trimmed) throw new UsageError("Asset name cannot be empty.");
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new UsageError("Asset name must be a relative path without '.' or '..' segments.");
  }
  return trimmed;
}

// `--path`/`--name` create semantics are shared across all asset-creating
// commands; re-exported here so existing `./knowledge` importers keep working.
export { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath };

function slugifyAssetName(value: string, fallbackPrefix: string): string {
  const slug = value
    .toLowerCase()
    .replace(/^[#>\-\s]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CAPTURED_ASSET_SLUG_LENGTH);
  return slug || `${fallbackPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Derive a slug-style asset name from `content` and an optional `preferred`
 * hint (e.g. a URL-derived page title or the source filename stem).
 */
export function inferAssetName(content: string, fallbackPrefix: string, preferred?: string): string {
  const firstNonEmptyLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const basis = preferred?.trim() || firstNonEmptyLine || fallbackPrefix;
  return slugifyAssetName(basis, fallbackPrefix);
}

// ── Content reading ──────────────────────────────────────────────────────────

/**
 * Read knowledge content from a local file path or stdin (`"-"`).
 *
 * Returns the raw text and an optional `preferredName` derived from the
 * source filename stem (used as a slug fallback when no `--name` flag was
 * supplied).
 */
export function readKnowledgeContent(source: string): { content: string; preferredName?: string } {
  if (source === "-") {
    const content = tryReadStdinText();
    if (!content?.trim()) {
      throw new UsageError("No stdin content received. Pipe a document into stdin or pass a file path.");
    }
    return { content };
  }

  const resolvedSource = path.resolve(source);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedSource);
  } catch {
    throw new UsageError(`Knowledge source not found: "${source}". Pass a readable file path or "-" for stdin.`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`Knowledge source must be a file: "${source}".`);
  }
  return {
    content: fs.readFileSync(resolvedSource, "utf8"),
    preferredName: path.basename(resolvedSource, path.extname(resolvedSource)),
  };
}

/**
 * Read knowledge content from a local path, stdin (`"-"`), or a remote URL.
 *
 * URLs are fetched via `fetchWebsiteMarkdownSnapshot`; local sources delegate
 * to `readKnowledgeContent`.
 */
export async function readKnowledgeInput(
  source: string,
  options?: { stashDir?: string; allowPrivateHosts?: boolean },
): Promise<{ content: string; preferredName?: string }> {
  if (!isHttpUrl(source)) return readKnowledgeContent(source);
  const snapshot = await fetchWebsiteMarkdownSnapshot(source, {
    stashDir: options?.stashDir,
    allowPrivateHosts: options?.allowPrivateHosts ?? shouldAllowPrivateWebsiteUrlForTests(source),
  });
  return { content: snapshot.content, preferredName: snapshot.preferredName };
}

// ── Cross-references (--xref) ────────────────────────────────────────────────

/**
 * Soft cap on xrefs per asset, from the back-linking conventions' "~5" rule.
 * Exceeding it warns on stderr but never blocks the write (the cap is a
 * heuristic, not a validator bound).
 */
export const XREF_SOFT_CAP = 5;

/**
 * Validate `--xref` flag values before ANY write happens.
 *
 * Each ref (`type:name`) must resolve to a real asset in the resolved write
 * target or any configured stash source (mirrors lint's missing-ref root set,
 * so cross-stash provenance refs into read-only sources are accepted). An
 * unresolvable ref is input validation of an explicitly passed flag — it
 * throws {@link UsageError} (exit 2) naming every bad ref, and the caller must
 * invoke this before writing so a failed validation leaves the stash
 * untouched. Resolution reuses the lint ref-resolver helpers
 * (`refToRelPath` / `refExistsInAnyStash`) — do not fork a second resolver.
 *
 * Returns the trimmed, deduplicated refs in argv order. More than
 * {@link XREF_SOFT_CAP} refs emits a stderr warning (soft cap) but still
 * returns them all.
 */
export function resolveXrefsForWrite(rawXrefs: string[], target?: string): string[] {
  const xrefs: string[] = [];
  for (const raw of rawXrefs) {
    const trimmed = raw.trim();
    if (trimmed && !xrefs.includes(trimmed)) xrefs.push(trimmed);
  }
  if (xrefs.length === 0) return xrefs;

  const cfg = loadConfig();
  const stashRoot = resolveWriteTarget(cfg, target).source.path;
  const extraStashRoots = resolveSourceEntries(stashRoot, cfg)
    .map((s) => s.path)
    .filter((p) => p !== stashRoot && fs.existsSync(p));
  const allRoots = [stashRoot, ...extraStashRoots];

  const unresolved: string[] = [];
  for (const ref of xrefs) {
    const colonIdx = ref.indexOf(":");
    const refType = colonIdx > 0 ? ref.slice(0, colonIdx) : "";
    const refName = colonIdx > 0 ? ref.slice(colonIdx + 1) : "";
    const relPath = refType && refName ? refToRelPath(refType, refName) : null;
    if (relPath === null || !refExistsInAnyStash(relPath, refType, refName, allRoots)) {
      unresolved.push(ref);
    }
  }
  if (unresolved.length > 0) {
    const first = unresolved[0];
    const colonIdx = first.indexOf(":");
    const hint =
      colonIdx > 0
        ? `Find the intended asset with \`akm search "${first.slice(colonIdx + 1)}" --type ${first.slice(0, colonIdx)}\`. Refs use the form type:name.`
        : "Refs use the form type:name, e.g. --xref knowledge:auth-flow.";
    throw new UsageError(
      `--xref ref${unresolved.length > 1 ? "s" : ""} did not resolve in the write target or any configured source: ${unresolved.join(", ")}`,
      "INVALID_FLAG_VALUE",
      hint,
    );
  }

  if (xrefs.length > XREF_SOFT_CAP) {
    warn(
      `Warning: ${xrefs.length} xrefs exceeds the ~${XREF_SOFT_CAP} soft cap from the back-linking conventions. ` +
        "Each xref folds into this asset's search hints, so extras blur its ranking signal. Writing anyway.",
    );
  }
  return xrefs;
}

/**
 * Merge validated xrefs into a markdown document's frontmatter `xrefs:` list.
 *
 * A document without frontmatter gains a single block; a document WITH
 * frontmatter keeps every existing key and gets the refs dedupe-appended to
 * its `xrefs:` list — never a nested second block. Runs BEFORE the asset is
 * written so write-path indexing sees the final content. Returns `content`
 * unchanged when `xrefs` is empty.
 *
 * The merge round-trips the frontmatter through the YAML parser, so it is
 * only safe when the existing block parses as a YAML mapping. Malformed YAML
 * would silently fall back to `parseFrontmatter`'s lenient scalar-only
 * scanner and re-serializing that lossy result would destroy list/nested
 * values (`tags: [a, b]` → `tags: ""`). Rather than corrupt data the caller
 * asked to preserve, a block that is not a parseable YAML mapping throws
 * {@link UsageError} (exit 2, before any write) — fix the frontmatter or run
 * the command without `--xref`, which keeps the file verbatim. Known
 * cosmetic limitation: YAML comments and anchors in a VALID block do not
 * survive the round-trip (values are preserved).
 */
export function mergeXrefsIntoContent(content: string, xrefs: string[]): string {
  if (xrefs.length === 0) return content;
  const parsed = parseFrontmatter(content);
  if (parsed.frontmatter?.trim()) {
    if (!isParseableYamlMapping(parsed.frontmatter)) {
      throw new UsageError(
        "--xref cannot merge into this document: its frontmatter is not a parseable YAML mapping, and rewriting it would drop the values the parser could not read.",
        "INVALID_FLAG_VALUE",
        "Fix the document's frontmatter (e.g. an unterminated quote) and retry, or run the command without --xref to keep the file verbatim.",
      );
    }
  }
  const existingValue = parsed.data.xrefs;
  const existing = Array.isArray(existingValue)
    ? existingValue.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : typeof existingValue === "string" && existingValue.trim()
      ? [existingValue.trim()]
      : [];
  const merged = [...existing];
  for (const ref of xrefs) {
    if (!merged.includes(ref)) merged.push(ref);
  }
  return assembleAsset({ ...parsed.data, xrefs: merged }, parsed.content);
}

/**
 * True when a raw frontmatter block (the text between the `---` fences)
 * parses as a YAML mapping — the precondition for any round-trip rewrite.
 * Malformed YAML falls back to `parseFrontmatter`'s lossy lenient scanner
 * (scalars only), and re-serializing that result destroys list/nested values
 * (`tags: [a, b]` → `tags: ""`), so writers must refuse instead of rewriting.
 */
function isParseableYamlMapping(frontmatter: string): boolean {
  try {
    const fmValue = yamlParse(frontmatter) as unknown;
    return fmValue !== null && typeof fmValue === "object" && !Array.isArray(fmValue);
  } catch {
    return false;
  }
}

// ── Corrections (--supersedes) ───────────────────────────────────────────────

/**
 * A validated `--supersedes` target: the old asset a correction demotes.
 * Produced by {@link resolveSupersedesForWrite}, consumed by
 * {@link writeMarkdownAsset} AFTER the new asset is written.
 */
export interface SupersededTarget {
  /** The old asset's ref (`type:name`) as passed on the CLI (trimmed). */
  ref: string;
  /** Absolute path of the old asset's primary on-disk file. */
  filePath: string;
  /** Stash/source root containing the file (the reindex scope after mutation). */
  stashRoot: string;
  /**
   * Whether the demotion may be applied: true only when the file lives under
   * the resolved write target or the working stash. Refs resolving in any
   * other configured source are reported (`applied: false`) but never mutated.
   */
  writable: boolean;
  /** Human-readable reason when `writable` is false. */
  reason?: string;
}

/**
 * Validate `--supersedes` flag values before ANY write happens.
 *
 * The conventions' corrections pattern needs TWO writes: the new correction
 * asset (with an xref to what it corrects) and a metadata edit demoting the
 * old asset (`beliefState: superseded` + `supersededBy: [<new ref>]`). This
 * helper performs the validation half: each ref must resolve to a real asset
 * (same resolver + root set as {@link resolveXrefsForWrite}); an unresolvable
 * ref throws {@link UsageError} (exit 2) naming every bad ref, so a failed
 * validation leaves the stash untouched — no partial correction.
 *
 * Demotion targets must live under the resolved write target's source path or
 * the working stash — honoring the "only operate on writable sources"
 * constraint (and never dirtying a non-target source outside its boundary
 * commit). A ref that resolves only in another configured source — read-only
 * OR writable-but-not-the-target — is returned with `writable: false` and a
 * reason (naming the `--target` remedy when the source is writable); the
 * caller writes the correction anyway and reports the demotion as not
 * applied.
 *
 * Returns the deduplicated plan in argv order; empty input returns [].
 */
export function resolveSupersedesForWrite(rawRefs: string[], target?: string): SupersededTarget[] {
  const refs: string[] = [];
  for (const raw of rawRefs) {
    const trimmed = raw.trim();
    if (trimmed && !refs.includes(trimmed)) refs.push(trimmed);
  }
  if (refs.length === 0) return [];

  const cfg = loadConfig();
  const stashRoot = resolveWriteTarget(cfg, target).source.path;
  let workingStash: string | undefined;
  try {
    workingStash = resolveStashDir({ readOnly: true });
  } catch {
    // No working stash configured — the write target alone accepts demotions.
  }
  const mutableRoots: string[] = [stashRoot];
  if (workingStash && path.resolve(workingStash) !== path.resolve(stashRoot)) mutableRoots.push(workingStash);
  const otherSources = resolveSourceEntries(stashRoot, cfg).filter(
    (s) => !mutableRoots.some((m) => path.resolve(m) === path.resolve(s.path)) && fs.existsSync(s.path),
  );
  // Mutable roots first: when a ref resolves in several roots, demote the copy
  // this command is allowed to mutate. Non-mutable roots keep their SearchSource
  // so the skip reason can distinguish "re-run with --target" (a configured
  // writable source that simply is not this write's target) from genuinely
  // read-only sources.
  const orderedRoots: Array<{ path: string; source?: SearchSource }> = [
    ...mutableRoots.filter((p) => fs.existsSync(p)).map((p) => ({ path: p })),
    ...otherSources.map((s) => ({ path: s.path, source: s })),
  ];

  const plan: SupersededTarget[] = [];
  const unresolved: string[] = [];
  for (const ref of refs) {
    const colonIdx = ref.indexOf(":");
    const refType = colonIdx > 0 ? ref.slice(0, colonIdx) : "";
    const refName = colonIdx > 0 ? ref.slice(colonIdx + 1) : "";
    const relPath = refType && refName ? refToRelPath(refType, refName) : null;
    let located: { root: string; source?: SearchSource; filePath: string } | null = null;
    if (relPath !== null) {
      for (const root of orderedRoots) {
        const filePath = resolveRefPathInStash(relPath, refType, refName, root.path);
        if (filePath !== null) {
          located = { root: root.path, source: root.source, filePath };
          break;
        }
      }
    }
    if (located === null) {
      unresolved.push(ref);
      continue;
    }
    const { root, source, filePath } = located;
    const writable = source === undefined;
    // The eligibility rule is write-target-or-working-stash, NOT source
    // writability: mutating a non-target writable source would leave it dirty
    // outside any boundary commit. Name the remedy when one exists.
    const namedWritableSource = source?.writable === true ? source.registryId : undefined;
    plan.push({
      ref,
      filePath,
      stashRoot: root,
      writable,
      ...(writable
        ? {}
        : {
            reason: namedWritableSource
              ? `resolves outside the write target and the working stash, in writable source "${namedWritableSource}" at ${root}; ` +
                `re-run with --target ${namedWritableSource} to demote it there`
              : `resolves outside the write target and the working stash, in a read-only source at ${root}; ` +
                "demotion only applies to assets in the write target or the working stash",
          }),
    });
  }

  if (unresolved.length > 0) {
    const first = unresolved[0];
    const colonIdx = first.indexOf(":");
    const hint =
      colonIdx > 0
        ? `Find the intended asset with \`akm search "${first.slice(colonIdx + 1)}" --type ${first.slice(0, colonIdx)}\`. Refs use the form type:name.`
        : "Refs use the form type:name, e.g. --supersedes memory:projectA/old-note.";
    throw new UsageError(
      `--supersedes ref${unresolved.length > 1 ? "s" : ""} did not resolve in the write target or any configured source: ${unresolved.join(", ")}`,
      "INVALID_FLAG_VALUE",
      hint,
    );
  }
  return plan;
}

// ── Asset writing ────────────────────────────────────────────────────────────

/**
 * Write a markdown asset (knowledge or memory) to the resolved write target.
 *
 * Resolves the write target via the v1 precedence chain (`--target` →
 * `defaultWriteTarget` → working stash), validates the path is within the
 * type root, enforces `--force` semantics, and delegates the actual write
 * to `writeAssetToSource`.
 */
export async function writeMarkdownAsset(options: {
  type: "knowledge" | "memory";
  content: string;
  name?: string;
  fallbackPrefix: string;
  preferredName?: string;
  force?: boolean;
  /** Optional explicit `--target` override naming a configured source. */
  target?: string;
  /**
   * Optional `--path`: a relative directory under the type root in which to
   * place the asset. The filename still comes from `name` (or the content
   * slug). e.g. `path: "personal/projects"` → `memories/personal/projects/<name>.md`.
   */
  path?: string;
  /**
   * Validated `--supersedes` targets (from {@link resolveSupersedesForWrite}).
   * After the new asset is written, each writable target is demoted via
   * `writeSupersededEdge` (metadata-only frontmatter edit) BEFORE the git
   * boundary commit — so a git target batches the correction AND the demoted
   * incumbent into the single boundary commit — and then reindexed so the
   * demotion is immediately live. Non-writable targets warn on stderr and are
   * reported as `applied: false` in the returned `superseded` key.
   */
  supersedes?: SupersededTarget[];
}): Promise<{
  ref: string;
  path: string;
  stashDir: string;
  hint?: string;
  superseded?: Array<{ ref: string; applied: boolean; reason?: string }>;
}> {
  const cfg = loadConfig();
  const target = resolveWriteTarget(cfg, options.target);
  const { source, config } = target;

  const typeRoot = path.join(source.path, options.type === "knowledge" ? "knowledge" : "memories");
  // `--name` is the flat asset name; `--path` is the subdirectory under the
  // type root. Combine them into the nested name the path resolver expects.
  const subPath = normalizeCreateSubPath(options.path);
  const baseName = normalizeMarkdownAssetName(
    options.name,
    inferAssetName(options.content, options.fallbackPrefix, options.preferredName),
  );
  const normalizedName = combineCreatePath(subPath, baseName);
  // Pre-flight: existence + force semantics. The helper itself overwrites
  // unconditionally; the CLI surfaces a friendlier UsageError before any
  // disk activity when --force is absent.
  const assetPath = resolveAssetPathFromName(options.type, typeRoot, normalizedName);
  if (!isWithin(assetPath, typeRoot)) {
    throw new UsageError(`Resolved ${options.type} path escapes the stash: "${normalizedName}"`);
  }
  if (fs.existsSync(assetPath) && !options.force) {
    throw new UsageError(
      `${options.type === "knowledge" ? "Knowledge" : "Memory"} "${normalizedName}" already exists. Re-run with --force to overwrite it.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  // A correction cannot supersede ITSELF. Under `--force` the ref resolves to
  // the very file this command is about to overwrite, and the demotion would
  // immediately mark the fresh correction superseded (plus a self-xref) —
  // silently hiding the fix from `--belief current` and capping its rank.
  // Input validation: exit 2, before any write, nothing demoted.
  for (const item of options.supersedes ?? []) {
    if (path.resolve(item.filePath) === path.resolve(assetPath)) {
      throw new UsageError(
        `--supersedes ${item.ref} resolves to the asset being written ("${options.type}:${normalizedName}") — a correction cannot supersede itself.`,
        "INVALID_FLAG_VALUE",
        "Write the correction under a different --name, or drop --supersedes when overwriting an asset in place with --force.",
      );
    }
  }

  const ref = { type: options.type, name: normalizedName };
  const result = await writeAssetToSource(source, config, ref, options.content);
  // SPEC-5 (--supersedes): demote each superseded asset by mutating its
  // frontmatter (`beliefState: superseded` + sorted-set-append `supersededBy`;
  // every other key and the body are preserved). Ordered BEFORE
  // commitWriteTargetBoundary so a git target batches the correction and the
  // demoted incumbent into the single boundary commit instead of leaving the
  // metadata edit as dirty residue after it.
  const superseded: Array<{ ref: string; applied: boolean; reason?: string }> = [];
  const demotedByRoot = new Map<string, string[]>();
  for (const item of options.supersedes ?? []) {
    if (!item.writable) {
      const reason = item.reason ?? "target is not writable";
      warn(
        `Warning: superseded asset ${item.ref} was NOT demoted (${reason}). ` +
          "The correction was written and cites it in xrefs; demote the old asset where it is writable.",
      );
      superseded.push({ ref: item.ref, applied: false, reason });
      continue;
    }
    // The demotion round-trips the old file's frontmatter through the YAML
    // parser. A malformed block would silently fall back to the lossy lenient
    // scanner and re-serializing that result destroys list/nested values —
    // skip instead of rewriting, mirroring mergeXrefsIntoContent's
    // abort-on-malformed policy (the correction itself still writes).
    let oldFrontmatter: string | null = null;
    try {
      oldFrontmatter = parseFrontmatter(fs.readFileSync(item.filePath, "utf8")).frontmatter;
    } catch {
      // Unreadable file — let writeSupersededEdge surface the real fs error.
    }
    if (oldFrontmatter?.trim() && !isParseableYamlMapping(oldFrontmatter)) {
      const reason =
        "its existing frontmatter is not a parseable YAML mapping — rewriting it would drop the values the parser could not read";
      warn(
        `Warning: superseded asset ${item.ref} was NOT demoted (${reason}). ` +
          "The correction was written and cites it in xrefs; fix the old asset's frontmatter and re-run the correction with --force.",
      );
      superseded.push({ ref: item.ref, applied: false, reason });
      continue;
    }
    writeSupersededEdge(item.filePath, result.ref);
    superseded.push({ ref: item.ref, applied: true });
    const files = demotedByRoot.get(item.stashRoot) ?? [];
    files.push(item.filePath);
    demotedByRoot.set(item.stashRoot, files);
  }
  // 0.9.0 (issue #507): single batch commit at the write boundary for git
  // targets. No-op for filesystem/primary-stash targets.
  commitWriteTargetBoundary(target, `Update ${formatRefForMessage(ref)}`);
  // Write-path indexing: the asset is searchable immediately. Fail-open; reads
  // no longer trigger reindexes, so keeping the index current is the writer's
  // job. Demoted files reindex under their own containing root (usually the
  // write target itself; the working stash when writing to a --target) so
  // `--belief current` filtering and the beliefState ranking demotion take
  // effect without waiting for the next full index.
  const demotedInTargetRoot = demotedByRoot.get(source.path) ?? [];
  demotedByRoot.delete(source.path);
  await indexWrittenAssets(source.path, [result.path, ...demotedInTargetRoot]);
  for (const [root, files] of demotedByRoot) {
    await indexWrittenAssets(root, files);
  }
  // Placement hint (stash-organization conventions): CLI writers never receive
  // the resolveStashStandards prompt injection LLM flows get, so a type-root
  // write into a stash that carries convention/meta facts points the writer at
  // the placement conventions. Additive output key, advisory only — parallel
  // to search's `tip`. Fail-open: the hint must never break a completed write.
  let hint: string | undefined;
  if (!subPath && !normalizedName.includes("/")) {
    try {
      if (resolveStashStandards(source.path).trim().length > 0) {
        // Only point at the canonical organization fact when it actually
        // exists — resolveStashStandards fires for ANY convention/meta fact,
        // and a dead `akm show` pointer is worse than generic wording.
        const orgFactPath = path.join(source.path, "facts", "conventions", "organization.md");
        hint = fs.existsSync(orgFactPath)
          ? `Wrote to the ${options.type} root. This stash has placement conventions — see \`akm show fact:conventions/organization\`.`
          : `Wrote to the ${options.type} root. This stash has placement conventions — see the convention facts under its facts/ directory.`;
      }
    } catch {
      // Advisory only.
    }
  }
  return {
    ref: result.ref,
    path: result.path,
    stashDir: source.path,
    ...(hint ? { hint } : {}),
    ...(superseded.length > 0 ? { superseded } : {}),
  };
}
