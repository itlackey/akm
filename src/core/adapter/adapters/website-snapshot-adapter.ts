// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `website-snapshot` adapter — akm 0.9.0 format-family work item (#46).
 *
 * A READ-ONLY (Mode A) view over a materialized crawl snapshot written by
 * `src/sources/snapshot-fetchers/website-ingest.ts` (spec §6/§7). The on-disk
 * pages are KNOWLEDGE-shaped markdown under `stash/knowledge/**` with no `type:`
 * field; this adapter RE-TYPES them to the open `type: website`. Per
 * open-question-3 (RESOLVED, maintainer 2026-07) the re-type is GATED — it
 * applies only to a page carrying the `website` tag / a `sourceUrl` (a page
 * lacking both is not re-typed); the document KEEPS its `sourceUrl` (surfaced as
 * `sourceRef` on `documentJson`); and the conceptId STRIPS the
 * `stash/knowledge/` prefix. `manifest.json` is snapshot PROVENANCE
 * (`{url, fetchedAt}`), read by the probe but never indexed as a concept.
 *
 * Read-only ⇒ NO `placeNew` (Mode B export routes content through the
 * DESTINATION adapter, which owns placement). `validate` runs base checks only
 * (a mirror the adapter does not author has no native validators); `updated`
 * never appears on a snapshot page, so `missing-updated` is filtered out.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/website-snapshot/` + goldens
 * `tests/fixtures/format-family-goldens/website-snapshot/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter, parseFrontmatterBlock } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent, nonEmptyString, runBaseValidateChecks } from "./shared";

/** A snapshot bundle is single-component; its one component is `main`. */
const COMPONENT_ID = "main";
/** The crawl page root the snapshot writer materializes pages under. */
const PAGES_PREFIX = "stash/knowledge/";
/** The provenance manifest basename (probe marker only, never indexed). */
const MANIFEST_FILE = "manifest.json";
/** The tag the snapshot writer stamps on every crawled page. */
const WEBSITE_TAG = "website";
/** Upper bound on the bounded `content` FTS field (mirrors okf-adapter). */
const MAX_CONTENT_CHARS = 100_000;

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** The snapshot-page fields the adapter reads (a real YAML parse so list-valued `tags:` round-trips). */
interface SnapshotFrontmatter {
  title?: string;
  description?: string;
  sourceUrl?: string;
  tags: string[];
}

function parseSnapshotFrontmatter(raw: string): SnapshotFrontmatter {
  const out: SnapshotFrontmatter = { tags: [] };
  const block = parseFrontmatterBlock(raw);
  if (!block) return out;
  let data: Record<string, unknown> = {};
  try {
    const value = parseYaml(block.frontmatter);
    if (value && typeof value === "object" && !Array.isArray(value)) data = value as Record<string, unknown>;
  } catch {
    return out;
  }
  out.title = nonEmptyString(data.title);
  out.description = nonEmptyString(data.description);
  out.sourceUrl = nonEmptyString(data.sourceUrl);
  if (Array.isArray(data.tags)) {
    out.tags = data.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
  }
  return out;
}

/** True when a page is a crawl snapshot page under `stash/knowledge/**`. */
function isSnapshotPage(relPath: string): boolean {
  const posix = toPosix(relPath);
  return posix.startsWith(PAGES_PREFIX) && posix.toLowerCase().endsWith(".md");
}

/** The GATED re-type predicate (open-question-3): the page carries the `website` tag OR a `sourceUrl`. */
function isReTypeGated(fm: SnapshotFrontmatter): boolean {
  return fm.sourceUrl !== undefined || fm.tags.includes(WEBSITE_TAG);
}

/** conceptId = page path − `stash/knowledge/` prefix − `.md`. */
function conceptIdOf(relPath: string): string {
  return toPosix(relPath).slice(PAGES_PREFIX.length).replace(/\.md$/i, "");
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  if (file.ext !== ".md" || !isSnapshotPage(file.relPath)) return null;
  const raw = file.content();
  const fm = parseSnapshotFrontmatter(raw);
  if (!isReTypeGated(fm)) return null; // not a re-typed website page

  const conceptId = conceptIdOf(file.relPath);
  const name = fm.title ?? conceptId.split("/").pop() ?? conceptId;
  const body = parseFrontmatter(raw).content;

  const doc: IndexDocument = {
    ref: `${c.id}//${conceptId}`,
    bundle: c.id,
    component: COMPONENT_ID,
    conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "website-snapshot",
    type: "website",
    name,
    content: body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body,
  };
  if (fm.description !== undefined) doc.description = fm.description;
  if (fm.sourceUrl !== undefined) doc.documentJson = { sourceRef: fm.sourceUrl };
  return doc;
}

async function validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    if (!isSnapshotPage(change.path)) continue;
    const base = await runBaseValidateChecks(toPosix(change.path), parseFrontmatter(raw), c.root, ctx);
    // A read-only crawl mirror carries `fetchedAt` provenance, never an `updated`
    // field — so `missing-updated` is not a defect on a snapshot page.
    diagnostics.push(...base.filter((d) => d.issue !== "missing-updated"));
  }
  return diagnostics;
}

export const websiteSnapshotAdapter: BundleAdapter = {
  id: "website-snapshot",
  version: "0.9.0",
  extensions: [".md"],

  recognize,
  validate,

  // No placeNew: the snapshot is READ-ONLY (Mode A). Export (Mode B) routes
  // content through the DESTINATION adapter, which owns placement.

  /**
   * Install-time probe (§1.2): a root carrying the snapshot provenance
   * `manifest.json` (`{url, fetchedAt}`). No other bundle root carries this
   * exact marker, so the probe is unambiguous.
   */
  looksLikeRoot(root: string): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(root, MANIFEST_FILE), "utf8");
    } catch {
      return false;
    }
    try {
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      return typeof manifest.url === "string" && typeof manifest.fetchedAt === "string";
    } catch {
      return false;
    }
  },
};
