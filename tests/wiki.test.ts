/**
 * Tests for the multi-wiki surface (issue #119).
 *
 * Covers: lifecycle (create/list/show/remove), pages filtering, stash
 * invariants (unique slugs, frontmatter wrap, raw/ immutability), lint
 * findings (every kind), index regeneration, ingest workflow printer,
 * and the matcher (specificity 20 beats agent at 20).
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { buildFileContext } from "../src/file-context";
import { wikiMatcher } from "../src/matchers";
import {
  buildIngestWorkflow,
  createWiki,
  extractWikiNameFromRef,
  INDEX_MD,
  LOG_MD,
  lintWiki,
  listPages,
  listWikis,
  regenerateAllWikiIndexes,
  regenerateWikiIndex,
  removeWiki,
  resolveWikiDir,
  resolveWikisRoot,
  SCHEMA_MD,
  searchInWiki,
  showWiki,
  slugifyForWiki,
  stashRaw,
  validateWikiName,
  WIKIS_SUBDIR,
} from "../src/wiki";

const tempDirs: string[] = [];

function makeStash(prefix = "akm-wiki-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePage(wikiDir: string, relPath: string, body: string): string {
  const abs = path.join(wikiDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
  return abs;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Name validation + path resolution ───────────────────────────────────────

describe("validateWikiName", () => {
  test("accepts lowercase, digits, hyphens", () => {
    expect(() => validateWikiName("research")).not.toThrow();
    expect(() => validateWikiName("r2d2")).not.toThrow();
    expect(() => validateWikiName("my-wiki")).not.toThrow();
  });

  test("rejects empty, uppercase, leading hyphens, or path traversal", () => {
    expect(() => validateWikiName("")).toThrow();
    expect(() => validateWikiName("Research")).toThrow();
    expect(() => validateWikiName("-foo")).toThrow();
    expect(() => validateWikiName("foo/bar")).toThrow();
    expect(() => validateWikiName("../escape")).toThrow();
  });
});

describe("resolveWikiDir", () => {
  test("joins stashDir/wikis/<name>", () => {
    const stash = makeStash();
    expect(resolveWikiDir(stash, "research")).toBe(path.join(stash, WIKIS_SUBDIR, "research"));
  });

  test("rejects malformed names via validateWikiName", () => {
    const stash = makeStash();
    expect(() => resolveWikiDir(stash, "../escape")).toThrow();
  });
});

describe("extractWikiNameFromRef", () => {
  test("extracts wiki name from wiki:<name>/<page> refs", () => {
    expect(extractWikiNameFromRef("wiki:research/ml-basics")).toBe("research");
    expect(extractWikiNameFromRef("wiki:research")).toBe("research");
    expect(extractWikiNameFromRef("wiki:research/raw/paper")).toBe("research");
  });

  test("returns undefined for non-wiki refs", () => {
    expect(extractWikiNameFromRef("knowledge:foo")).toBeUndefined();
    expect(extractWikiNameFromRef("wiki:Invalid-Name")).toBeUndefined();
  });
});

// ── Lifecycle: create / list / show / remove ────────────────────────────────

describe("createWiki", () => {
  test("scaffolds schema, index, log, raw/.gitkeep", () => {
    const stash = makeStash();
    const result = createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
    expect(result.ref).toBe("wiki:research");
    expect(result.path).toBe(wikiDir);
    expect(result.created.length).toBe(4);
    expect(fs.existsSync(path.join(wikiDir, SCHEMA_MD))).toBe(true);
    expect(fs.existsSync(path.join(wikiDir, INDEX_MD))).toBe(true);
    expect(fs.existsSync(path.join(wikiDir, LOG_MD))).toBe(true);
    expect(fs.existsSync(path.join(wikiDir, "raw", ".gitkeep"))).toBe(true);
  });

  test("is idempotent — re-creating skips existing files", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const second = createWiki(stash, "research");
    expect(second.created.length).toBe(0);
    expect(second.skipped.length).toBeGreaterThanOrEqual(3);
  });

  test("rejects creating a stash-owned wiki when that name is already registered", () => {
    const stash = makeStash();
    const externalWiki = makeStash("akm-create-conflict-");
    const configHome = makeStash("akm-create-conflict-config-");
    const origHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      saveConfig({
        semanticSearchMode: "off",
        stashes: [{ type: "filesystem", path: externalWiki, name: "ics-docs", wikiName: "ics-docs" }],
      });
      expect(() => createWiki(stash, "ics-docs")).toThrow("Wiki already registered: ics-docs.");
    } finally {
      if (origHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origHome;
    }
  });
});

describe("listWikis", () => {
  test("returns [] when no wikis exist", () => {
    const stash = makeStash();
    expect(listWikis(stash)).toEqual([]);
  });

  test("lists wikis with pages/raws counts sorted by name", () => {
    const stash = makeStash();
    createWiki(stash, "zebra");
    createWiki(stash, "alpha");
    const result = listWikis(stash);
    expect(result.map((w) => w.name)).toEqual(["alpha", "zebra"]);
    expect(result[0].pages).toBe(0);
    expect(result[0].raws).toBe(0);
  });

  test("skips directories with invalid wiki names", () => {
    const stash = makeStash();
    fs.mkdirSync(path.join(stash, WIKIS_SUBDIR, "Weird-Name"), { recursive: true });
    fs.mkdirSync(path.join(stash, WIKIS_SUBDIR, ".hidden"), { recursive: true });
    createWiki(stash, "research");
    const result = listWikis(stash);
    expect(result.map((w) => w.name)).toEqual(["research"]);
  });
});

describe("showWiki", () => {
  test("returns path, description, counts, and empty recentLog", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const result = showWiki(stash, "research");
    expect(result.name).toBe("research");
    expect(result.ref).toBe("wiki:research");
    expect(result.description).toBeDefined();
    expect(result.pages).toBe(0);
    expect(result.raws).toBe(0);
    expect(result.recentLog).toEqual([]);
  });

  test("returns the top 3 log entries (newest-first convention)", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const logPath = path.join(stash, WIKIS_SUBDIR, "research", LOG_MD);
    // Newest first, per the schema-documented convention.
    fs.appendFileSync(
      logPath,
      "\n## 2026-04-23 ingest baz\n\nsummary: newest\n\n## 2026-04-22 lint\n\nfindings: 0\n\n## 2026-04-21 ingest bar\n\nsummary: third\n\n## 2026-04-20 ingest foo\n\nsummary: oldest\n",
    );
    const result = showWiki(stash, "research");
    expect(result.recentLog).toHaveLength(3);
    expect(result.recentLog[0]).toContain("2026-04-23 ingest baz");
    expect(result.recentLog[2]).toContain("2026-04-21 ingest bar");
  });

  test("throws NotFoundError for unknown wiki", () => {
    const stash = makeStash();
    expect(() => showWiki(stash, "missing")).toThrow(/not found/i);
  });
});

describe("removeWiki", () => {
  test("deletes pages/schema/index/log but preserves raw/ by default", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
    fs.writeFileSync(path.join(wikiDir, "raw", "kept.md"), "keep me", "utf8");
    const result = removeWiki(stash, "research");
    expect(result.preservedRaw).toBe(true);
    expect(fs.existsSync(path.join(wikiDir, "raw", "kept.md"))).toBe(true);
    expect(fs.existsSync(path.join(wikiDir, SCHEMA_MD))).toBe(false);
    expect(fs.existsSync(path.join(wikiDir, INDEX_MD))).toBe(false);
    expect(fs.existsSync(path.join(wikiDir, LOG_MD))).toBe(false);
  });

  test("with withSources: true, deletes everything including the wiki dir", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
    const result = removeWiki(stash, "research", { withSources: true });
    expect(result.preservedRaw).toBe(false);
    expect(fs.existsSync(wikiDir)).toBe(false);
  });

  test("unregisters an external wiki without deleting its source files", () => {
    const stash = makeStash();
    const externalWiki = makeStash("akm-external-wiki-");
    const configHome = makeStash("akm-external-wiki-config-");
    const origHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    writePage(externalWiki, "overview.md", "---\ndescription: Overview\n---\n# Overview\n");
    try {
      saveConfig({
        semanticSearchMode: "off",
        stashes: [{ type: "filesystem", path: externalWiki, name: "ics-docs", wikiName: "ics-docs" }],
      });

      const result = removeWiki(stash, "ics-docs");

      expect(result.unregistered).toBe(true);
      expect(fs.existsSync(path.join(externalWiki, "overview.md"))).toBe(true);
      expect(listWikis(stash).map((wiki) => wiki.name)).not.toContain("ics-docs");
      expect((loadConfig().stashes ?? []).some((entry) => entry.wikiName === "ics-docs")).toBe(false);
    } finally {
      if (origHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origHome;
    }
  });
});

// ── Pages ───────────────────────────────────────────────────────────────────

describe("listPages", () => {
  test("excludes schema.md, index.md, log.md, and raw/**", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
    writePage(wikiDir, "page-a.md", "---\ndescription: Page A\npageKind: concept\n---\n# A\n");
    writePage(wikiDir, "sub/page-b.md", "---\ndescription: Page B\n---\n# B\n");
    writePage(wikiDir, "raw/paper.md", "# raw doc\n");
    const pages = listPages(stash, "research");
    const refs = pages.map((p) => p.ref).sort();
    expect(refs).toEqual(["wiki:research/page-a", "wiki:research/sub/page-b"]);
    expect(pages.find((p) => p.ref === "wiki:research/page-a")?.description).toBe("Page A");
    expect(pages.find((p) => p.ref === "wiki:research/page-a")?.pageKind).toBe("concept");
  });
});

// ── Matcher: wiki wins at spec 20 ───────────────────────────────────────────

describe("wikiMatcher", () => {
  test("classifies wikis/<name>/page.md as wiki at specificity 20", () => {
    const stash = makeStash();
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
    fs.mkdirSync(wikiDir, { recursive: true });
    const abs = writePage(wikiDir, "passkey.md", "# passkey\n");
    const ctx = buildFileContext(stash, abs);
    const result = wikiMatcher(ctx);
    expect(result).toEqual({ type: "wiki", specificity: 20, renderer: "wiki-md" });
  });

  test("ignores .md files outside a wiki directory", () => {
    const stash = makeStash();
    const abs = writePage(stash, "knowledge/notes.md", "# hi\n");
    const ctx = buildFileContext(stash, abs);
    expect(wikiMatcher(ctx)).toBeNull();
  });

  test("ignores a bare .md directly under wikis/ with no wiki name", () => {
    const stash = makeStash();
    const wikisRoot = resolveWikisRoot(stash);
    fs.mkdirSync(wikisRoot, { recursive: true });
    const abs = writePage(stash, path.join(WIKIS_SUBDIR, "stray.md"), "");
    const ctx = buildFileContext(stash, abs);
    expect(wikiMatcher(ctx)).toBeNull();
  });

  test("wins over extensionMatcher's SKILL.md override when under wikis/", async () => {
    const stash = makeStash();
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
    fs.mkdirSync(wikiDir, { recursive: true });
    const abs = writePage(wikiDir, "SKILL.md", "# not actually a skill\n");
    const { runMatchers } = await import("../src/file-context");
    const ctx = buildFileContext(stash, abs);
    const result = await runMatchers(ctx);
    expect(result?.type).toBe("wiki");
  });
});

// ── Stash: raw/ invariants ─────────────────────────────────────────────────

describe("stashRaw", () => {
  test("creates raw/<slug>.md with frontmatter", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const result = stashRaw({
      stashDir: stash,
      wikiName: "research",
      content: "# Attention Is All You Need\n\nPaper abstract.\n",
      preferredName: "attention",
    });
    expect(result.slug).toBe("attention");
    expect(result.ref).toBe("wiki:research/raw/attention");
    const body = fs.readFileSync(result.path, "utf8");
    expect(body).toContain("wikiRole: raw");
    expect(body).toContain("slug: attention");
  });

  test("never overwrites — adds -1, -2, ... suffixes", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const r1 = stashRaw({ stashDir: stash, wikiName: "research", content: "a", preferredName: "dup" });
    const r2 = stashRaw({ stashDir: stash, wikiName: "research", content: "b", preferredName: "dup" });
    const r3 = stashRaw({ stashDir: stash, wikiName: "research", content: "c", preferredName: "dup" });
    expect(r1.slug).toBe("dup");
    expect(r2.slug).toBe("dup-1");
    expect(r3.slug).toBe("dup-2");
    expect(fs.readFileSync(r1.path, "utf8")).toContain("a");
  });

  test("preserves pre-existing frontmatter in source content", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const source = "---\ntitle: Pre-existing\ncustom: value\n---\n\n# body\n";
    const result = stashRaw({
      stashDir: stash,
      wikiName: "research",
      content: source,
      preferredName: "has-fm",
    });
    const body = fs.readFileSync(result.path, "utf8");
    expect(body).toContain("title: Pre-existing");
    expect(body).toContain("custom: value");
    expect(body).not.toContain("wikiRole: raw");
  });

  test("throws when the wiki doesn't exist", () => {
    const stash = makeStash();
    expect(() => stashRaw({ stashDir: stash, wikiName: "missing", content: "hi", preferredName: "x" })).toThrow(
      /not found/i,
    );
  });
});

describe("slugifyForWiki", () => {
  test("lowercases and hyphenates", () => {
    expect(slugifyForWiki("Hello World!")).toBe("hello-world");
    expect(slugifyForWiki("# My Title")).toBe("my-title");
    expect(slugifyForWiki("  > quoted text")).toBe("quoted-text");
  });

  test("falls back for empty input", () => {
    const result = slugifyForWiki("");
    expect(result.startsWith("note-")).toBe(true);
  });
});

// ── Lint ────────────────────────────────────────────────────────────────────

describe("lintWiki", () => {
  test("flags orphan, missing-description, broken-xref, uncited-raw", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
    // orphan: no incoming, no outgoing
    writePage(wikiDir, "truly-orphan.md", "---\ndescription: lonely\n---\n# orphan\n");
    // missing-description — still linked so it's not also an orphan
    writePage(wikiDir, "no-desc.md", "---\nxrefs:\n  - wiki:research/refs-missing\n---\n# no desc\n");
    // broken-xref — has a description, xrefs a nonexistent page
    writePage(
      wikiDir,
      "refs-missing.md",
      "---\ndescription: refs something that isn't there\nxrefs:\n  - wiki:research/ghost\n---\n# broken\n",
    );
    // uncited raw
    writePage(wikiDir, "raw/uncited-paper.md", "---\nwikiRole: raw\n---\nstuff");

    const report = lintWiki(stash, "research");
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toContain("orphan");
    expect(kinds).toContain("missing-description");
    expect(kinds).toContain("broken-xref");
    expect(kinds).toContain("uncited-raw");
  });

  test("does not flag cross-wiki xrefs as broken", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
    writePage(wikiDir, "page.md", "---\ndescription: cross-wiki\nxrefs:\n  - wiki:other-wiki/foo\n---\n# cross\n");
    const report = lintWiki(stash, "research");
    const brokenXref = report.findings.filter((f) => f.kind === "broken-xref");
    expect(brokenXref).toHaveLength(0);
  });

  test("does not flag stale-index when only a raw source or log was touched", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
    // Regenerate the index AFTER a page exists so its mtime is fresh.
    writePage(wikiDir, "page.md", "---\ndescription: present\n---\n# ok\n");
    regenerateWikiIndex(stash, "research");
    // Advance wall-clock ~50ms, then touch ONLY a raw source + the log. The
    // index tracks pages, so neither of these should flag stale-index.
    const future = new Date(Date.now() + 50);
    const rawPath = path.join(wikiDir, "raw", "just-stashed.md");
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    fs.writeFileSync(rawPath, "---\nwikiRole: raw\n---\nbody", "utf8");
    fs.utimesSync(rawPath, future, future);
    const logPath = path.join(wikiDir, LOG_MD);
    fs.appendFileSync(logPath, "\n## touch\n\nentry\n");
    fs.utimesSync(logPath, future, future);

    const report = lintWiki(stash, "research");
    const staleIndex = report.findings.filter((f) => f.kind === "stale-index");
    expect(staleIndex).toHaveLength(0);
  });
});

// ── Index regeneration ─────────────────────────────────────────────────────

describe("regenerateWikiIndex", () => {
  test("writes an index grouping pages by pageKind", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
    writePage(wikiDir, "alpha.md", "---\ndescription: A\npageKind: entity\n---\n");
    writePage(wikiDir, "beta.md", "---\ndescription: B\npageKind: concept\n---\n");
    writePage(wikiDir, "gamma.md", "---\ndescription: G\npageKind: entity\n---\n");
    const ok = regenerateWikiIndex(stash, "research");
    expect(ok).toBe(true);
    const indexBody = fs.readFileSync(path.join(wikiDir, INDEX_MD), "utf8");
    expect(indexBody).toContain("## Entity");
    expect(indexBody).toContain("## Concept");
    expect(indexBody).toContain("`wiki:research/alpha`");
    expect(indexBody).toContain("`wiki:research/beta`");
    expect(indexBody).toContain("`wiki:research/gamma`");
  });
});

describe("regenerateAllWikiIndexes", () => {
  test("regenerates every wiki under wikis/", () => {
    const stash = makeStash();
    createWiki(stash, "one");
    createWiki(stash, "two");
    const regenerated = regenerateAllWikiIndexes(stash);
    expect(regenerated.sort()).toEqual(["one", "two"]);
  });
});

// ── Ingest workflow printer ─────────────────────────────────────────────────

describe("buildIngestWorkflow", () => {
  test("returns wiki path + schema path + non-empty workflow string", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const result = buildIngestWorkflow(stash, "research");
    expect(result.wiki).toBe("research");
    expect(result.path).toBe(path.join(stash, WIKIS_SUBDIR, "research"));
    expect(result.schemaPath).toBe(path.join(stash, WIKIS_SUBDIR, "research", SCHEMA_MD));
    expect(result.workflow).toContain("akm wiki stash research");
    expect(result.workflow).toContain("akm wiki lint research");
    expect(result.workflow).toContain("akm wiki search research");
    expect(result.workflow).toContain("akm index");
  });
});

// ── searchInWiki ────────────────────────────────────────────────────────────

describe("searchInWiki", () => {
  test("returns only hits from the named wiki when index is absent (substring fallback)", async () => {
    const stash = makeStash();
    const origStash = process.env.AKM_STASH_DIR;
    const origHome = process.env.XDG_CONFIG_HOME;
    process.env.AKM_STASH_DIR = stash;
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wiki-search-home-"));
    tempDirs.push(process.env.XDG_CONFIG_HOME);
    try {
      createWiki(stash, "alpha");
      createWiki(stash, "beta");
      const alphaDir = path.join(stash, WIKIS_SUBDIR, "alpha");
      const betaDir = path.join(stash, WIKIS_SUBDIR, "beta");
      writePage(alphaDir, "attention.md", "---\ndescription: attention paper in alpha\n---\n# attention\n");
      writePage(betaDir, "attention.md", "---\ndescription: attention paper in beta\n---\n# attention\n");

      const response = await searchInWiki({ stashDir: stash, wikiName: "alpha", query: "attention" });
      for (const hit of response.hits) {
        // Every hit must live inside alpha's wiki directory
        expect(hit.type === "registry" ? "" : (hit as { path: string }).path).toContain(alphaDir);
      }
    } finally {
      if (origStash === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = origStash;
      if (origHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origHome;
    }
  });

  test("finds hits in a registered external wiki", async () => {
    const stash = makeStash();
    const externalWiki = makeStash("akm-external-search-");
    const origStash = process.env.AKM_STASH_DIR;
    const origHome = process.env.XDG_CONFIG_HOME;
    process.env.AKM_STASH_DIR = stash;
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "akm-external-search-home-"));
    tempDirs.push(process.env.XDG_CONFIG_HOME);
    try {
      writePage(externalWiki, "attention.md", "---\ndescription: External attention page\n---\n# Attention\n");
      saveConfig({
        semanticSearchMode: "off",
        stashes: [{ type: "filesystem", path: externalWiki, name: "ics-docs", wikiName: "ics-docs" }],
      });

      const response = await searchInWiki({ stashDir: stash, wikiName: "ics-docs", query: "attention" });

      expect(response.hits.some((hit) => hit.type !== "registry" && hit.ref.includes("wiki:ics-docs/attention"))).toBe(
        true,
      );
    } finally {
      if (origStash === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = origStash;
      if (origHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origHome;
    }
  });
});
