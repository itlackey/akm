// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The reference `okf` adapter — akm 0.9.0 chunk-2, WI-A.
 *
 * Implements `docs/architecture/specs/akm-0.9.0-bundle-adapter-spec.md` §5 (the reference
 * OKF adapter) + §5.1 (BINDING: `okf` reads `type` FROM FRONTMATTER, with NO
 * directory gate) EXACTLY. This is pure OKF: `type` from frontmatter, identity
 * from path, no directory routing anywhere.
 *
 *  - recognize (§5): any `.md` NOT named `index.md`/`log.md` (case-insensitive,
 *    reserved) → one concept. `type` = frontmatter `type` when a non-empty
 *    string, else the `knowledge` default. conceptId = the concept's path
 *    within the component root minus `.md`. The OKF field projection (§0.1/§3):
 *    name ← title (fallback: last path segment), description ← description,
 *    tags ← tags, updated ← timestamp. The directory a file sits in NEVER
 *    affects `type`.
 *  - links (§9): BOTH OKF link forms — `/`-rooted bundle-relative and standard
 *    relative — resolve deterministically into target conceptIds, stored on
 *    `IndexDocument.links`. Unresolvable / out-of-component links are dropped
 *    (tolerant).
 *  - validate (§5, LENIENT): base checks only; unknown frontmatter never fails;
 *    `missing-type` is INFO; `missing-ref` on OKF links is a non-blocking
 *    WARNING (consumers tolerate broken links). Reads go through
 *    `ctx.readFile`; ref existence via `ctx.resolveRef`. Never touches the live
 *    filesystem.
 *  - directoryList / looksLikeRoot per §5 / §1.2. Authoring is deliberately
 *    absent; AKM-native writers fail before mutating an OKF bundle.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import { isRecord, toPosix } from "../../common";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type {
  BundleComponent,
  Diagnostic,
  IndexDocument,
  OkfSourceEntry,
  OkfVerifiedEntry,
  ValidateContext,
} from "../types";
import { hashContent, nonEmptyString, RESERVED_FILES, readTags, runBaseValidateChecks } from "./shared";

/** v0.2 frontmatter keys consumed into first-class fields below (§0.1) — excluded from the generic `documentJson` extras fold alongside the v0.1 five, so nothing is duplicated between a first-class field and the opaque extras bag. */
const CONSUMED_FRONTMATTER_KEYS = [
  "type",
  "title",
  "description",
  "tags",
  "timestamp",
  "generated",
  "verified",
  "sources",
  "status",
  "stale_after",
  "okf_version",
];

/**
 * Parse one `verified:` actor mapping (`{by, at?}`). Tolerant: a missing/blank
 * `by` yields `undefined` (the entry is dropped, never rejecting the document
 * — OKF conformance leniency); `at` is independently optional.
 */
function parseActorMapping(value: unknown): OkfVerifiedEntry | undefined {
  if (!isRecord(value)) return undefined;
  const by = nonEmptyString(value.by);
  if (by === undefined) return undefined;
  const at = nonEmptyString(value.at);
  return at !== undefined ? { by, at } : { by };
}

/**
 * Parse the `verified:` family. v0.2 permits EITHER a list of `{by, at?}`
 * mappings OR a single mapping written without the list dash (the shorthand
 * form) — both normalize to a non-empty array here. Malformed entries are
 * dropped individually; an entirely-empty/malformed result is `undefined`
 * rather than `[]` (mirrors every other optional-field convention on this
 * adapter: absent, not empty).
 */
function parseVerified(value: unknown): OkfVerifiedEntry[] | undefined {
  if (value === undefined || value === null) return undefined;
  const candidates = Array.isArray(value) ? value : [value];
  const out: OkfVerifiedEntry[] = [];
  for (const candidate of candidates) {
    const parsed = parseActorMapping(candidate);
    if (parsed) out.push(parsed);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the `sources:` object-list family. Each entry needs at minimum a
 * non-empty `resource`; entries failing that are dropped individually (never
 * rejects the document). This is a DIFFERENT shape from the AKM-native
 * `IndexDocument.sources: string[]` (wiki citations) — the two are never
 * mixed, hence the caller lands this under `provenance.sources` instead.
 */
function parseOkfSources(value: unknown): OkfSourceEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: OkfSourceEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const resource = nonEmptyString(item.resource);
    if (resource === undefined) continue;
    const entry: OkfSourceEntry = { resource };
    const id = nonEmptyString(item.id);
    if (id !== undefined) entry.id = id;
    const title = nonEmptyString(item.title);
    if (title !== undefined) entry.title = title;
    const author = nonEmptyString(item.author);
    if (author !== undefined) entry.author = author;
    if (typeof item.usage_count === "number" && Number.isFinite(item.usage_count)) {
      entry.usage_count = item.usage_count;
    }
    const lastModified = nonEmptyString(item.last_modified);
    if (lastModified !== undefined) entry.last_modified = lastModified;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/** Parse the `status:` lifecycle field — a strict whitelist; any other value (including a foreign/future status) is left unset rather than guessed at. */
function parseLifecycleStatus(value: unknown): "draft" | "stable" | "deprecated" | undefined {
  return value === "draft" || value === "stable" || value === "deprecated" ? value : undefined;
}

/** True when `name` (a bare file name) is a reserved OKF file, case-insensitively (§5, OKF §1.4). */
function isReservedFileName(name: string): boolean {
  return RESERVED_FILES.has(name.toLowerCase());
}

/**
 * Resolve BOTH OKF link forms found in a concept body into target conceptIds
 * (§9, §5):
 *   - `/`-rooted bundle-relative — `[x](/tables/customers.md)` — resolved from
 *     the component root;
 *   - standard relative — `[y](./other.md)`, `[z](../a/b.md)` — resolved
 *     relative to the linking concept's own directory.
 * Both are resolved against the component root, `.md` stripped, to yield a
 * component-root-relative conceptId (matching how `recognize` derives the
 * target file's own conceptId). Deterministic string/path work — no LLM, no
 * I/O. Non-`.md` targets, external schemes (`http:`…), in-page anchors, and any
 * link that escapes the component root are dropped (tolerant, §5). Order of
 * first appearance is preserved; duplicates collapse.
 */
export function resolveOkfLinks(body: string, fileRelPath: string): string[] {
  const dir = path.posix.dirname(toPosix(fileRelPath));
  const definitions = new Map<string, string>();
  for (const match of body.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/gm)) {
    definitions.set(match[1]!.trim().toLowerCase(), match[2]!);
  }
  const candidates: Array<{ index: number; target: string }> = [];
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    candidates.push({ index: match.index, target: match[1]! });
  }
  for (const match of body.matchAll(/(?<!!)\[[^\]]*\]\[([^\]]+)\]/g)) {
    const target = definitions.get(match[1]!.trim().toLowerCase());
    if (target) candidates.push({ index: match.index, target });
  }
  candidates.sort((a, b) => a.index - b.index);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let target = candidate.target.trim();
    // Drop an optional markdown link title: `[x](/a.md "Title")`.
    const wsIdx = target.search(/\s/);
    if (wsIdx >= 0) target = target.slice(0, wsIdx);
    // Strip fragment / query.
    const hashIdx = target.indexOf("#");
    if (hashIdx >= 0) target = target.slice(0, hashIdx);
    const queryIdx = target.indexOf("?");
    if (queryIdx >= 0) target = target.slice(0, queryIdx);
    if (!target) continue;
    // Skip external schemes (http:, mailto:, …) and protocol-relative URLs.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (target.startsWith("//")) continue;
    // Only concept links (`.md`).
    if (!target.toLowerCase().endsWith(".md")) continue;

    let resolved: string;
    if (target.startsWith("/")) {
      // Bundle/component-root-relative.
      resolved = path.posix.normalize(target.slice(1));
    } else {
      // Standard relative — resolve against the linking concept's directory.
      const base = dir === "." ? "" : dir;
      resolved = path.posix.normalize(path.posix.join(base, target));
    }
    // Drop anything that escapes the component root.
    if (resolved.startsWith("../") || resolved === ".." || resolved.startsWith("/")) continue;
    const conceptId = resolved.replace(/\.md$/i, "");
    if (!conceptId || seen.has(conceptId)) continue;
    seen.add(conceptId);
    out.push(conceptId);
  }
  return out;
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  // `okf` owns `.md` only (extensions: [".md"]). No directory gate anywhere.
  if (file.ext !== ".md") return null;
  // Reserved OKF files are recognized (excluded), never indexed as concepts.
  if (isReservedFileName(file.fileName)) return null;

  const conceptId = toPosix(file.relPath).replace(/\.md$/i, "");
  const raw = file.content();
  const parsed = parseFrontmatter(raw);
  const data = parsed.data;
  const body = parsed.content;

  // §5.1 BINDING: `type` from FRONTMATTER; default `knowledge` when absent.
  const type = nonEmptyString(data.type) ?? "knowledge";
  // §0.1/§3 OKF field projection.
  const lastSegment = conceptId.split("/").pop() ?? conceptId;
  const name = nonEmptyString(data.title) ?? lastSegment;
  const description = nonEmptyString(data.description);
  const tags = readTags(data.tags);
  const links = resolveOkfLinks(body, file.relPath);

  // v0.2 trust/provenance/lifecycle families (§0.1, okf-support.md v0.2 note).
  // `generated.at` — v0.2's replacement for `timestamp` — takes precedence;
  // `timestamp` remains a fully valid fallback (the v0.2-permitted legacy
  // reading, not merely tolerated). Both stay fully optional (never rejects).
  const generatedMapping = isRecord(data.generated) ? data.generated : undefined;
  const generatedAt = generatedMapping ? nonEmptyString(generatedMapping.at) : undefined;
  const generatedBy = generatedMapping ? nonEmptyString(generatedMapping.by) : undefined;
  const legacyTimestamp = nonEmptyString(data.timestamp);
  const updated = generatedAt ?? legacyTimestamp;

  const verified = parseVerified(data.verified);
  const okfSources = parseOkfSources(data.sources);
  const provenance: IndexDocument["provenance"] =
    generatedBy !== undefined || generatedAt !== undefined || verified !== undefined || okfSources !== undefined
      ? {
          ...(generatedBy !== undefined ? { generatedBy } : {}),
          ...(generatedAt !== undefined ? { generatedAt } : {}),
          ...(verified !== undefined ? { verified } : {}),
          ...(okfSources !== undefined ? { sources: okfSources } : {}),
        }
      : undefined;
  const lifecycleStatus = parseLifecycleStatus(data.status);
  const staleAfter = nonEmptyString(data.stale_after);
  // `okf_version` is upstream-declared only on a bundle-root `index.md` (never
  // indexed as a concept, §5) — read defensively from any concept anyway
  // (best-effort, conformance Rule 9); a producer that also tags ordinary
  // concepts with it is neither rejected nor silently ignored.
  const okfVersion = nonEmptyString(data.okf_version);

  const doc: IndexDocument = {
    ref: `${c.id}//${conceptId}`,
    bundle: c.id,
    component: c.id,
    conceptId,
    path: file.absPath,
    // hash over the full raw file (frontmatter + body) so any edit invalidates
    // incrementality/fingerprints (`types.ts` hash doc comment).
    hash: hashContent(raw),
    adapterId: "okf",
    ownsPresentation: true,
    type,
    name,
    content: body,
  };
  if (description !== undefined) doc.description = description;
  if (tags !== undefined) doc.tags = tags;
  if (updated !== undefined) doc.updated = updated;
  if (links.length > 0) doc.links = links;
  if (provenance !== undefined) doc.provenance = provenance;
  if (lifecycleStatus !== undefined) doc.lifecycleStatus = lifecycleStatus;
  if (staleAfter !== undefined) doc.staleAfter = staleAfter;
  if (okfVersion !== undefined) doc.okfVersion = okfVersion;
  const extras = Object.fromEntries(Object.entries(data).filter(([key]) => !CONSUMED_FRONTMATTER_KEYS.includes(key)));
  if (Object.keys(extras).length > 0) doc.documentJson = extras;
  return doc;
}

async function validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;

    const relPath = toPosix(change.path);
    const fileName = relPath.split("/").pop() ?? relPath;
    const reserved = isReservedFileName(fileName);
    const parsed = parseFrontmatter(raw);

    // Base checks shared with native AKM formats. OKF's timestamp is optional,
    // so the AKM-specific freshness diagnostic is removed unconditionally.
    const base = await runBaseValidateChecks(relPath, parsed, c.root, ctx);
    for (const diag of base) {
      if (diag.issue === "missing-updated") continue;
      diagnostics.push(diag);
    }

    if (reserved) continue; // reserved files are not concepts — no type / link checks

    // §5: `missing-type` is INFO (not an error) — never blocks.
    if (nonEmptyString(parsed.data.type) === undefined) {
      diagnostics.push({
        file: relPath,
        issue: "missing-type",
        detail: "info: no frontmatter `type`; defaults to `knowledge` (OKF leniency, non-blocking)",
        fixed: false,
      });
    }

    // §5/§9: broken OKF links are a non-blocking WARNING — consumers tolerate them.
    for (const conceptId of resolveOkfLinks(parsed.content, relPath)) {
      const { exists } = await ctx.resolveRef(conceptId);
      if (!exists) {
        diagnostics.push({
          file: relPath,
          issue: "missing-ref",
          detail: `warning: OKF link target not found: ${conceptId} (non-blocking, consumers tolerate broken links)`,
          fixed: false,
        });
      }
    }
  }
  return diagnostics;
}

export const okfAdapter: BundleAdapter = {
  id: "okf",
  version: "0.9.0",
  extensions: [".md"],

  recognize,
  validate,

  readCandidates(c: BundleComponent, conceptId: string) {
    const canonical = conceptId.replace(/\\/g, "/").replace(/\.md$/i, "");
    return [{ path: path.join(c.root, `${canonical}.md`), conceptId: canonical }];
  },

  /** OKF concepts live anywhere under the component root (§5). */
  directoryList(_c: BundleComponent): string[] {
    return ["."];
  },

  /**
   * Install-time probe. A root index is sufficient; an index-less root is also
   * OKF when it contains at least one conformant concept with a non-empty open
   * `type`. More-specific native adapters run before this portable baseline.
   */
  looksLikeRoot(root: string): boolean {
    if (fs.existsSync(path.join(root, "index.md"))) return true;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name === ".git") continue;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || isReservedFileName(entry.name)) continue;
        const type = nonEmptyString(parseFrontmatter(fs.readFileSync(absolute, "utf8")).data.type);
        if (type) return true;
      }
    }
    return false;
  },
};
