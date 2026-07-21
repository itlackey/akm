// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The reference `okf` adapter — akm 0.9.0 chunk-2, WI-A.
 *
 * Implements `docs/design/akm-0.9.0-bundle-adapter-spec.md` §5 (the reference
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
 *  - placeNew / directoryList / looksLikeRoot per §5 / §1.2.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent, nonEmptyString, readTags, runBaseValidateChecks } from "./shared";

/** Reserved OKF files (case-insensitive) — recognized, never indexed as concepts (§5, OKF §1.4). */
const RESERVED_FILES = new Set(["index.md", "log.md"]);

/** Upper bound on the bounded `content` FTS field (§3: "content: FTS 1 (bounded)"). Small fixtures are never truncated. */
const MAX_CONTENT_CHARS = 100_000;

/** POSIX-normalize separators without importing a cycle-participant helper. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True when `name` (a bare file name) is a reserved OKF file, case-insensitively. */
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
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  const out: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = linkRe.exec(body)) !== null) {
    let target = match[1]!.trim();
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
  const updated = nonEmptyString(data.timestamp);
  const links = resolveOkfLinks(body, file.relPath);

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
    type,
    name,
    content: body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body,
  };
  if (description !== undefined) doc.description = description;
  if (tags !== undefined) doc.tags = tags;
  if (updated !== undefined) doc.updated = updated;
  if (links.length > 0) doc.links = links;
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

    // Base checks (unquoted-colon / missing-updated / stale-path / missing-ref).
    const base = await runBaseValidateChecks(relPath, parsed, c.root, ctx);
    // §0.1: for OKF content a `timestamp` satisfies the freshness requirement
    // (the base-linter's `missing-updated` maps to `timestamp`). Suppress the
    // `missing-updated` diagnostic when a non-empty `timestamp` is present.
    const hasTimestamp = nonEmptyString(parsed.data.timestamp) !== undefined;
    for (const diag of base) {
      if (hasTimestamp && diag.issue === "missing-updated") continue;
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

  /** `<c.root>/<conceptId>.md` (§5). */
  placeNew(c: BundleComponent, conceptId: string): string {
    return path.join(c.root, `${conceptId}.md`);
  },

  /** OKF concepts live anywhere under the component root (§5). */
  directoryList(_c: BundleComponent): string[] {
    return ["."];
  },

  /** Install-time probe: a root is an OKF bundle when it has a root `index.md` (§1.2; `okf_version` NOT required). */
  looksLikeRoot(root: string): boolean {
    return fs.existsSync(path.join(root, "index.md"));
  },
};
