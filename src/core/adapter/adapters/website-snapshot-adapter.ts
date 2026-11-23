// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `website-snapshot` adapter — akm 0.9.0 format-family work item (#46).
 *
 * A READ-ONLY (Mode A) view over a materialized crawl snapshot written by
 * `src/sources/snapshot-fetchers/website-ingest.ts`. The on-disk
 * pages are KNOWLEDGE-shaped markdown under `stash/knowledge/**` with no `type:`
 * field; this adapter types them `type: website`. Every Markdown file there
 * is a page, by its path (the fetcher always writes a `sourceUrl`); the
 * document KEEPS its `sourceUrl` (surfaced as
 * `sourceRef` on `documentJson`); and the conceptId STRIPS the
 * `stash/knowledge/` prefix. `manifest.json` is snapshot PROVENANCE
 * (`{url, fetchedAt}`), read by the probe but never indexed as a concept.
 *
 * Read-only (Mode B export routes content through the DESTINATION adapter,
 * which owns placement). `validate` runs base checks only
 * (a mirror the adapter does not author has no native validators); `updated`
 * never appears on a snapshot page, so `missing-updated` is filtered out.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/website-snapshot/` + goldens
 * `tests/fixtures/format-family-goldens/website-snapshot/{recognition,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter, parseFrontmatterBlock } from "../../asset/frontmatter";
import { toPosix } from "../../common";
import { DirectoryAdapterBase } from "../directory-adapter";
import type { FileChange } from "../file-change";
import type { Bundle, IndexMetadata } from "../types";
import type { FileDiagnostic, FileValidateContext } from "../validate-context";
import { createBaseChecker, hashContent, nonEmptyString, parseForValidate } from "./shared";

/** The crawl page root the snapshot writer materializes pages under. */
const PAGES_PREFIX = "stash/knowledge/";
/** The provenance manifest basename (probe marker only, never indexed). */
const MANIFEST_FILE = "manifest.json";

/** The snapshot-page fields the adapter reads (a real YAML parse so list-valued `tags:` round-trips). */
interface SnapshotFrontmatter {
  title?: string;
  description?: string;
  sourceUrl?: string;
}

function parseSnapshotFrontmatter(raw: string): SnapshotFrontmatter {
  const out: SnapshotFrontmatter = {};
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
  return out;
}

/** True when a page is a crawl snapshot page under `stash/knowledge/**`. */
function isSnapshotPage(relPath: string): boolean {
  const posix = toPosix(relPath);
  return posix.startsWith(PAGES_PREFIX) && posix.toLowerCase().endsWith(".md");
}

/** conceptId = page path − `stash/knowledge/` prefix − `.md`. */
function conceptIdOf(relPath: string): string {
  return toPosix(relPath).slice(PAGES_PREFIX.length).replace(/\.md$/i, "");
}

function describe(file: FileContext, conceptId: string): IndexMetadata {
  const raw = file.content();
  const fm = parseSnapshotFrontmatter(raw);
  const name = fm.title ?? conceptId.split("/").pop() ?? conceptId;
  const body = parseFrontmatter(raw).content;

  const doc: IndexMetadata = {
    hash: hashContent(raw),
    ownsPresentation: true,
    type: "website",
    name,
    content: body,
  };
  if (fm.description !== undefined) doc.description = fm.description;
  if (fm.sourceUrl !== undefined) doc.documentJson = { sourceRef: fm.sourceUrl };
  return doc;
}

async function validate(c: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]> {
  const diagnostics: FileDiagnostic[] = [];
  const { check } = createBaseChecker(c.root, ctx);
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    if (!isSnapshotPage(change.path)) continue;
    // A read-only crawl mirror carries `fetchedAt` provenance, never an `updated`
    // field — so the `missing-updated` rule does not apply to a snapshot page.
    diagnostics.push(...check(toPosix(change.path), parseForValidate(raw), ["missing-updated"]));
  }
  return diagnostics;
}

export class WebsiteSnapshotAdapter extends DirectoryAdapterBase {
  readonly id = "website-snapshot";
  readonly version = "0.10.0";
  override readonly extensions = [".md"];

  /** Every Markdown page under `stash/knowledge/` is a page of the snapshot (the fetcher always writes its `sourceUrl`). */
  protected identify(relPath: string): string | null {
    return isSnapshotPage(relPath) ? conceptIdOf(relPath) : null;
  }

  protected describe(_b: Bundle, file: FileContext, conceptId: string): IndexMetadata {
    return describe(file, conceptId);
  }

  protected validateFiles(b: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]> {
    return validate(b, changes, ctx);
  }

  protected spellings(conceptId: string): string[] {
    return [`${PAGES_PREFIX}${toPosix(conceptId).replace(/\.md$/i, "")}.md`];
  }

  // The snapshot is READ-ONLY (Mode A). Export (Mode B) routes content through
  // the DESTINATION adapter, which owns placement.

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
  }
}

export const websiteSnapshotAdapter = new WebsiteSnapshotAdapter();
