// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The first-class `llm-wiki` adapter — akm 0.9.0 chunk-4 (DEV-7 restore).
 *
 * The `wiki` ASSET-TYPE dies in chunk 4 (plan §11 Chunk 4 / §7.4), but the LLM
 * Wiki structure stays first-class as its OWN adapter. This relocates the native
 * wiki semantics from `src/wiki/wiki.ts` + `src/wiki/wiki-templates.ts` into a
 * `BundleAdapter` implementing `docs/design/akm-0.9.0-bundle-adapter-spec.md` §7
 * (llm-wiki row), §6 (wiki-page row), §0.2 (the `wiki` asset-type is retired;
 * the adapter is first-class), §1.2 (probe = schema.md + pages/), §9 (links).
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/llm-wiki/` + goldens
 * `tests/fixtures/format-family-goldens/llm-wiki/{recognition,placement,renderer,lint}.json`.
 * The adapter is built to MATCH those goldens (driven by
 * `tests/core/adapter/llm-wiki-adapter.test.ts`).
 *
 * ── Structure (spec §7, wiki.ts canonical-content contract) ──
 *
 *   - `schema.md` / `index.md` / `log.md` at the wiki ROOT are RESERVED
 *     (recognized, never indexed as concepts) — analogous to OKF's index.md/log.md.
 *   - `raw/<slug>.md` are immutable ingested sources → the adapter's own `type`
 *     = `wiki-source` (RESOLVED, reading A: recognition golden). First-class
 *     addressable + searchable; lint tracks whether each is cited.
 *   - `pages/**.md` are agent-authored pages → open `type` = frontmatter
 *     `pageKind` (concept/entity/note/<custom>). None of concept/entity/note/
 *     wiki-source is in `KNOWN_TYPES`, so they present GENERICALLY (renderer
 *     golden); the retired `wiki-md` renderer is deliberately unused.
 *   - Anything else (root README, stray root `.md`, other dirs) is NOT a wiki
 *     asset (`recognize` abstains) — pages live under `pages/`.
 *
 * ── Links / citations (spec §9) ──
 *
 * A page's `IndexDocument.links` = its resolved `xrefs:` frontmatter (the
 * `wiki:<name>/<conceptId>` form, stripped to the target conceptId) PLUS its
 * body bundle-relative markdown links, deduped, first-appearance order. Its
 * `sources:` frontmatter resolves to the cited raw conceptIds (citation edges),
 * carried on `documentJson` (adapter extras — plan §4.3) and consumed by the
 * uncited-raw lint check.
 *
 * ── validate (spec §6/§7, §9) — native wiki checks ONLY ──
 *
 * The native structural checks ported from `wiki.ts#lintWiki`: `broken-xref`
 * (an xref target that does not resolve to an existing page), `uncited-raw`
 * (a `raw/` source not cited by any page's `sources:`), `missing-description`
 * (a page with no description), and `broken-source` (a page `sources:` entry
 * with no matching raw file). Broken xrefs are TOLERATED (warning, non-blocking,
 * spec §9). The shared `runBaseValidateChecks` (unquoted-colon / missing-updated
 * / stale-path / missing-ref) is NOT run: wiki files never carry an `updated`
 * field, so `missing-updated` would fire on every page/reserved file and
 * contradict the lint golden's clean result — the native checks are the wiki's
 * complete validation surface. The `orphan` issue CODE is APPROVED but the
 * recorded chunk-4 behavior (lint golden edgeCases) is to emit `broken-xref`
 * only (the actionable finding) and surface `orphan` after the xref is fixed —
 * so no `orphan` finding is emitted here.
 *
 * ── Cycle-safety ──
 *
 * Imported ONLY by the test-only `adapters/index.ts` barrel (nothing in `src/`
 * imports that), so this leaf can never gain an inbound edge from a cycle
 * participant. It value-imports only pure leaves (`frontmatter`, `shared`) plus
 * Node builtins + `yaml` (already a runtime dep). Verified: `bun
 * scripts/lint-import-cycles.ts` stays within baseline (13) with this file present.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter, parseFrontmatterBlock } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent, nonEmptyString } from "./shared";

/** A wiki is a single-component bundle; its one component is conventionally `main` (recognition golden). */
const WIKI_COMPONENT_ID = "main";

/** The adapter's own `type` for immutable ingested sources under `raw/` (recognition golden, reading A). */
const WIKI_SOURCE_TYPE = "wiki-source";

/** Default open `type` for a `pages/` file whose frontmatter carries no `pageKind`. */
const DEFAULT_PAGE_KIND = "note";

/** Reserved wiki files (case-insensitive) at the wiki ROOT — recognized, never indexed as concepts (spec §7). */
const RESERVED_ROOT_FILES = new Set(["schema.md", "index.md", "log.md"]);

/** Content subdirectory holding immutable ingested sources. */
const RAW_SUBDIR = "raw";
/** Content subdirectory holding agent-authored pages. */
const PAGES_SUBDIR = "pages";

/** Upper bound on the bounded `content` FTS field (mirrors okf-adapter). */
const MAX_CONTENT_CHARS = 100_000;

/** POSIX-normalize separators. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** conceptId = component-root-relative path minus `.md`. */
function conceptIdOf(relPath: string): string {
  return toPosix(relPath).replace(/\.md$/i, "");
}

/** The parsed wiki frontmatter fields the adapter reads (list-valued keys need a real YAML parse). */
interface WikiPageFrontmatter {
  description?: string;
  pageKind?: string;
  xrefs: string[];
  sources: string[];
  wikiRole?: string;
}

/**
 * Parse a wiki page's frontmatter with a real YAML parser so list-valued keys
 * (`xrefs:`, `sources:`) round-trip (the project's hand-rolled `parseFrontmatter`
 * deliberately drops YAML lists — see `wiki.ts#parsePageFrontmatterYaml`).
 * Tolerant: malformed YAML / no frontmatter yields empty fields.
 */
function parseWikiFrontmatter(raw: string): WikiPageFrontmatter {
  const out: WikiPageFrontmatter = { xrefs: [], sources: [] };
  const block = parseFrontmatterBlock(raw);
  let data: Record<string, unknown> = {};
  if (block) {
    try {
      const value = parseYaml(block.frontmatter);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        data = value as Record<string, unknown>;
      }
    } catch {
      // malformed YAML — fall back to the lightweight parser (scalars only)
      try {
        data = parseFrontmatter(raw).data;
      } catch {
        data = {};
      }
    }
  }
  out.description = nonEmptyString(data.description);
  out.pageKind = nonEmptyString(data.pageKind);
  out.wikiRole = nonEmptyString(data.wikiRole);
  if (Array.isArray(data.xrefs)) {
    out.xrefs = data.xrefs
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim());
  }
  if (Array.isArray(data.sources)) {
    out.sources = data.sources
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
  }
  return out;
}

/** True when `relPath` is a RESERVED wiki file at the component root (schema/index/log). */
function isReservedRootFile(relPath: string): boolean {
  const posix = toPosix(relPath);
  if (posix.includes("/")) return false; // reserved files are special ONLY at the wiki root
  return RESERVED_ROOT_FILES.has(posix.toLowerCase());
}

/** First path segment of a component-root-relative POSIX path (or the whole thing when flat). */
function firstSegment(relPath: string): string {
  const posix = toPosix(relPath);
  const slash = posix.indexOf("/");
  return slash < 0 ? posix : posix.slice(0, slash);
}

/**
 * Resolve one xref token (`wiki:<bundleId>/<conceptId>`) to a same-wiki target
 * conceptId, or `null` when it points at another wiki / is not a wiki xref.
 * `bundleId` is the bundle id (`c.id`); cross-wiki xrefs are left alone
 * (wiki.ts#lintWiki: "a cross-wiki link is a feature, not a defect").
 */
function resolveXref(xref: string, bundleId: string): string | null {
  const prefix = `wiki:${bundleId}/`;
  if (!xref.startsWith(prefix)) return null;
  const target = xref.slice(prefix.length).replace(/\.md$/i, "");
  return target.length > 0 ? target : null;
}

/**
 * Resolve a page body's bundle-relative markdown links to component-root-relative
 * conceptIds. `/`-rooted links resolve from the component root; standard relative
 * links resolve against the linking page's own directory. External schemes,
 * anchors, non-`.md` targets, and links escaping the component root are dropped
 * (tolerant, §9). First-appearance order; duplicates collapse.
 */
function resolveBodyLinks(body: string, fileRelPath: string): string[] {
  const dir = path.posix.dirname(toPosix(fileRelPath));
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  const out: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = linkRe.exec(body)) !== null) {
    let target = match[1].trim();
    const wsIdx = target.search(/\s/);
    if (wsIdx >= 0) target = target.slice(0, wsIdx);
    const hashIdx = target.indexOf("#");
    if (hashIdx >= 0) target = target.slice(0, hashIdx);
    const queryIdx = target.indexOf("?");
    if (queryIdx >= 0) target = target.slice(0, queryIdx);
    if (!target) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // external scheme
    if (target.startsWith("//")) continue; // protocol-relative
    if (!target.toLowerCase().endsWith(".md")) continue;

    let resolved: string;
    if (target.startsWith("/")) {
      resolved = path.posix.normalize(target.slice(1));
    } else {
      const base = dir === "." ? "" : dir;
      resolved = path.posix.normalize(path.posix.join(base, target));
    }
    if (resolved.startsWith("../") || resolved === ".." || resolved.startsWith("/")) continue;
    const conceptId = resolved.replace(/\.md$/i, "");
    if (!conceptId || seen.has(conceptId)) continue;
    seen.add(conceptId);
    out.push(conceptId);
  }
  return out;
}

/** Resolve a page's `xrefs` + body links into deduped target conceptIds (links = relationships, §9). */
function resolvePageLinks(fm: WikiPageFrontmatter, body: string, fileRelPath: string, bundleId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (conceptId: string) => {
    if (conceptId.length > 0 && !seen.has(conceptId)) {
      seen.add(conceptId);
      out.push(conceptId);
    }
  };
  for (const xref of fm.xrefs) {
    const resolved = resolveXref(xref, bundleId);
    if (resolved !== null) push(resolved);
  }
  for (const link of resolveBodyLinks(body, fileRelPath)) push(link);
  return out;
}

/** Resolve a page's `sources:` entries (`raw/<slug>[.md]`) to raw conceptIds (citation edges). */
function resolveSources(fm: WikiPageFrontmatter): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of fm.sources) {
    const match = src.match(/^raw\/([^/\s]+?)(?:\.md)?$/i);
    if (!match) continue;
    const conceptId = `raw/${match[1]}`;
    if (!seen.has(conceptId)) {
      seen.add(conceptId);
      out.push(conceptId);
    }
  }
  return out;
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  if (file.ext !== ".md") return null;
  const relPath = toPosix(file.relPath);

  // Reserved root files (schema/index/log) are recognized but never indexed.
  if (isReservedRootFile(relPath)) return null;

  const head = firstSegment(relPath);
  const isRaw = head === RAW_SUBDIR && relPath.includes("/");
  const isPage = head === PAGES_SUBDIR && relPath.includes("/");
  // Only `raw/` sources and `pages/` pages are wiki assets. Everything else
  // (root README, stray root `.md`, other dirs) is abstained on.
  if (!isRaw && !isPage) return null;

  const conceptId = conceptIdOf(relPath);
  const lastSegment = conceptId.split("/").pop() ?? conceptId;
  const raw = file.content();
  const fm = parseWikiFrontmatter(raw);
  const body = parseFrontmatter(raw).content;

  const doc: IndexDocument = {
    ref: `${c.id}//${conceptId}`,
    bundle: c.id,
    component: WIKI_COMPONENT_ID,
    conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "llm-wiki",
    type: isRaw ? WIKI_SOURCE_TYPE : (fm.pageKind ?? DEFAULT_PAGE_KIND),
    name: lastSegment,
    content: body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body,
  };
  if (fm.description !== undefined) doc.description = fm.description;

  if (isPage) {
    const links = resolvePageLinks(fm, body, relPath, c.id);
    if (links.length > 0) doc.links = links;
    const sources = resolveSources(fm);
    // wiki page extras (adapter-owned; plan §4.3 — wikiRole/pageKind + citations).
    const extras: Record<string, unknown> = { pageKind: fm.pageKind ?? DEFAULT_PAGE_KIND, sources };
    if (fm.wikiRole !== undefined) extras.wikiRole = fm.wikiRole;
    doc.documentJson = extras;
  } else {
    doc.documentJson = { wikiRole: fm.wikiRole ?? "source" };
  }
  return doc;
}

/** A page/raw record collected from a validate change set — the inputs the native checks cross-reference. */
interface WikiValidateItem {
  relPath: string;
  conceptId: string;
  kind: "page" | "raw";
  fm: WikiPageFrontmatter;
  body: string;
}

async function validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const items: WikiValidateItem[] = [];
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    const relPath = toPosix(change.path);
    if (isReservedRootFile(relPath)) continue; // reserved files are not concepts — no page checks
    const head = firstSegment(relPath);
    const isRaw = head === RAW_SUBDIR && relPath.includes("/");
    const isPage = head === PAGES_SUBDIR && relPath.includes("/");
    if (!isRaw && !isPage) continue;
    items.push({
      relPath,
      conceptId: conceptIdOf(relPath),
      kind: isRaw ? "raw" : "page",
      fm: parseWikiFrontmatter(raw),
      body: parseFrontmatter(raw).content,
    });
  }

  const existingConceptIds = new Set(items.map((i) => i.conceptId));
  const citedRawConceptIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== "page") continue;
    for (const src of resolveSources(item.fm)) citedRawConceptIds.add(src);
  }

  const diagnostics: Diagnostic[] = [];

  for (const item of items) {
    if (item.kind === "raw") {
      // uncited-raw: a raw source not cited by any page's `sources:`.
      if (!citedRawConceptIds.has(item.conceptId)) {
        diagnostics.push({
          file: item.relPath,
          issue: "uncited-raw",
          detail: `warning: raw source ${item.conceptId} is not cited by any page's sources: frontmatter (non-blocking).`,
          fixed: false,
        });
      }
      continue;
    }

    // missing-description
    if (item.fm.description === undefined) {
      diagnostics.push({
        file: item.relPath,
        issue: "missing-description",
        detail: "warning: page is missing a frontmatter `description` (non-blocking).",
        fixed: false,
      });
    }

    // broken-xref: same-wiki xref targets that do not resolve to an existing page.
    const targets = new Set<string>();
    for (const xref of item.fm.xrefs) {
      const resolved = resolveXref(xref, c.id);
      if (resolved !== null) targets.add(resolved);
    }
    for (const link of resolveBodyLinks(item.body, item.relPath)) targets.add(link);
    for (const target of targets) {
      if (!existingConceptIds.has(target)) {
        diagnostics.push({
          file: item.relPath,
          issue: "broken-xref",
          detail:
            `warning: cross-reference target not found: ${target} ` +
            "(non-blocking; cross-references must point at pages that actually exist — wiki schema hard rule).",
          fixed: false,
        });
      }
    }

    // broken-source: `sources:` entries must resolve to an existing raw file.
    for (const source of resolveSources(item.fm)) {
      if (!existingConceptIds.has(source)) {
        diagnostics.push({
          file: item.relPath,
          issue: "broken-source",
          detail: `warning: page references missing raw source ${source} (non-blocking).`,
          fixed: false,
        });
      }
    }
  }

  return diagnostics;
}

export const llmWikiAdapter: BundleAdapter = {
  id: "llm-wiki",
  version: "0.9.0",
  extensions: [".md"],

  recognize,
  validate,

  /** `<c.root>/<conceptId>.md` — the conceptId already carries its `pages/`/`raw/` prefix (placement golden). */
  placeNew(c: BundleComponent, conceptId: string): string {
    return path.join(c.root, `${conceptId}.md`);
  },

  /** The wiki owns its whole root (schema/index/log at root plus pages/ + raw/); one component. */
  directoryList(_c: BundleComponent): string[] {
    return ["."];
  },

  /** Install-time probe (§1.2): a root is an LLM Wiki when it has a root `schema.md` AND a `pages/` directory. */
  looksLikeRoot(root: string): boolean {
    try {
      if (!fs.existsSync(path.join(root, "schema.md"))) return false;
      return fs.statSync(path.join(root, PAGES_SUBDIR)).isDirectory();
    } catch {
      return false;
    }
  },
};

// Exported pure helpers for the conformance test.
export { resolveBodyLinks, resolvePageLinks, resolveSources, resolveXref };
