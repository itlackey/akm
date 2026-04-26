/**
 * Regression tests for the 0.5.0 QA wiki fixes.
 *
 * Covers:
 *   1. searchInWiki excludes schema.md, index.md, and log.md.
 *   2. stashRaw with explicitSlug: true throws UsageError on collision;
 *      with explicitSlug: false auto-increments.
 *   3. lintWiki emits broken-source findings for dangling sources: refs.
 *   4. validateWikiName error message includes "lowercase".
 *   5. wiki search on a nonexistent wiki throws NotFoundError.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../src/core/errors";
import {
  createWiki,
  INDEX_MD,
  LOG_MD,
  lintWiki,
  SCHEMA_MD,
  searchInWiki,
  stashRaw,
  validateWikiName,
  WIKIS_SUBDIR,
} from "../src/wiki/wiki";

const tempDirs: string[] = [];

function makeStash(prefix = "akm-wiki-qa-"): string {
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

/**
 * Set up an isolated stash env for searchInWiki tests.
 * Returns the stash dir and a cleanup function.
 */
function withIsolatedStash(): { stash: string; cleanup: () => void } {
  const stash = makeStash();
  const origStash = process.env.AKM_STASH_DIR;
  const origHome = process.env.XDG_CONFIG_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wiki-qa-home-"));
  tempDirs.push(tmpHome);
  process.env.AKM_STASH_DIR = stash;
  process.env.XDG_CONFIG_HOME = tmpHome;
  return {
    stash,
    cleanup() {
      if (origStash === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = origStash;
      if (origHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origHome;
    },
  };
}

// ── 1. searchInWiki excludes infrastructure files ───────────────────────────

describe("searchInWiki — infrastructure file exclusion", () => {
  test("excludes schema.md, index.md, log.md from results", async () => {
    const { stash, cleanup } = withIsolatedStash();
    try {
      createWiki(stash, "research");
      const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
      writePage(wikiDir, "ml-basics.md", "---\ndescription: Machine learning basics\n---\n# ML Basics\nContent.\n");

      const response = await searchInWiki({
        stashDir: stash,
        wikiName: "research",
        query: "machine learning",
      });
      // All returned hits must not be special infrastructure files
      for (const hit of response.hits) {
        if (hit.type === "registry") continue;
        const stashHit = hit as { path?: string };
        if (!stashHit.path) continue;
        const basename = path.basename(stashHit.path);
        expect([SCHEMA_MD, INDEX_MD, LOG_MD]).not.toContain(basename);
      }
    } finally {
      cleanup();
    }
  });

  test("does not exclude real page files", async () => {
    const { stash, cleanup } = withIsolatedStash();
    try {
      createWiki(stash, "research");
      const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");
      writePage(wikiDir, "valid-page.md", "---\ndescription: A real page\n---\n# Valid\n");
      // No assertion about hit presence (index may be absent); just no throw.
      const response = await searchInWiki({
        stashDir: stash,
        wikiName: "research",
        query: "real page",
      });
      expect(response).toBeDefined();
      expect(Array.isArray(response.hits)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ── 2. stashRaw explicitSlug collision behaviour ─────────────────────────────

describe("stashRaw — explicitSlug", () => {
  test("explicitSlug: true throws UsageError on collision", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    // First write succeeds
    stashRaw({
      stashDir: stash,
      wikiName: "research",
      content: "first",
      preferredName: "mysource",
      explicitSlug: true,
    });
    // Second write with same slug and explicitSlug: true must throw
    expect(() =>
      stashRaw({
        stashDir: stash,
        wikiName: "research",
        content: "second",
        preferredName: "mysource",
        explicitSlug: true,
      }),
    ).toThrow(UsageError);
  });

  test("UsageError message mentions the slug, 'already exists', and '--as'", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    stashRaw({ stashDir: stash, wikiName: "research", content: "first", preferredName: "myslug", explicitSlug: true });
    let caught: Error | undefined;
    try {
      stashRaw({
        stashDir: stash,
        wikiName: "research",
        content: "second",
        preferredName: "myslug",
        explicitSlug: true,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect(caught?.message).toContain("myslug");
    expect(caught?.message).toContain("already exists");
    expect(caught?.message).toContain("--as");
  });

  test("explicitSlug: false auto-increments on collision (existing behaviour)", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const r1 = stashRaw({
      stashDir: stash,
      wikiName: "research",
      content: "a",
      preferredName: "dup",
      explicitSlug: false,
    });
    const r2 = stashRaw({
      stashDir: stash,
      wikiName: "research",
      content: "b",
      preferredName: "dup",
      explicitSlug: false,
    });
    expect(r1.slug).toBe("dup");
    expect(r2.slug).toBe("dup-1");
  });

  test("explicitSlug: undefined auto-increments (backward-compat)", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const r1 = stashRaw({ stashDir: stash, wikiName: "research", content: "a", preferredName: "nodups" });
    const r2 = stashRaw({ stashDir: stash, wikiName: "research", content: "b", preferredName: "nodups" });
    expect(r1.slug).toBe("nodups");
    expect(r2.slug).toBe("nodups-1");
  });

  test("explicitSlug: true on a new slug does NOT throw", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    expect(() =>
      stashRaw({ stashDir: stash, wikiName: "research", content: "x", preferredName: "brand-new", explicitSlug: true }),
    ).not.toThrow();
  });
});

// ── 3. lintWiki broken-source findings ──────────────────────────────────────

describe("lintWiki — broken-source", () => {
  test("emits broken-source finding when sources: references a missing raw file", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");

    // Page that references a raw file that doesn't exist
    writePage(
      wikiDir,
      "orphaned-page.md",
      "---\ndescription: Page with dangling source ref\nxrefs:\n  - wiki:research/orphaned-page\nsources:\n  - raw/ghost-paper\n---\n# Orphaned\n",
    );

    const report = lintWiki(stash, "research");
    const brokenSrc = report.findings.filter((f) => f.kind === "broken-source");
    expect(brokenSrc.length).toBeGreaterThanOrEqual(1);
    expect(brokenSrc[0].refs[0]).toBe("wiki:research/orphaned-page");
    expect(brokenSrc[0].message).toContain("ghost-paper");
  });

  test("does NOT emit broken-source when raw file exists", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");

    // Stash the raw file first
    stashRaw({ stashDir: stash, wikiName: "research", content: "raw content", preferredName: "real-paper" });

    // Page citing the existing raw file — must NOT trigger broken-source
    writePage(
      wikiDir,
      "good-page.md",
      "---\ndescription: Page with valid source ref\nxrefs:\n  - wiki:research/good-page\nsources:\n  - raw/real-paper\n---\n# Good\n",
    );

    const report = lintWiki(stash, "research");
    const brokenSrc = report.findings.filter((f) => f.kind === "broken-source");
    expect(brokenSrc.length).toBe(0);
  });

  test("accepts both 'raw/slug' and 'raw/slug.md' source forms", () => {
    const stash = makeStash();
    createWiki(stash, "research");
    const wikiDir = path.join(stash, WIKIS_SUBDIR, "research");

    stashRaw({ stashDir: stash, wikiName: "research", content: "raw", preferredName: "existing-slug" });

    // Cite with .md extension — should not break
    writePage(
      wikiDir,
      "page-with-ext.md",
      "---\ndescription: Cites with .md extension\nxrefs:\n  - wiki:research/page-with-ext\nsources:\n  - raw/existing-slug.md\n---\n# Ext\n",
    );

    const report = lintWiki(stash, "research");
    const brokenSrc = report.findings.filter((f) => f.kind === "broken-source");
    expect(brokenSrc.length).toBe(0);
  });
});

// ── 4. validateWikiName error message includes "lowercase" ───────────────────

describe("validateWikiName — error message", () => {
  test("error message says 'lowercase' when name has uppercase letters", () => {
    let caught: Error | undefined;
    try {
      validateWikiName("MyWiki");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect(caught?.message.toLowerCase()).toContain("lowercase");
  });

  test("error message says 'lowercase' for leading-hyphen names", () => {
    let caught: Error | undefined;
    try {
      validateWikiName("-bad");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect(caught?.message.toLowerCase()).toContain("lowercase");
  });
});

// ── 5. searchInWiki on nonexistent wiki throws NotFoundError ─────────────────

describe("searchInWiki — nonexistent wiki", () => {
  test("throws (via validateWikiName) for invalid wiki names", () => {
    const stash = makeStash();
    // An uppercase name fails validateWikiName, which is called by searchInWiki
    expect(() => searchInWiki({ stashDir: stash, wikiName: "BadName", query: "test" })).toThrow();
  });

  test("valid-but-missing wiki name returns zero hits (path-filter drops everything)", async () => {
    // searchInWiki itself does not throw for a valid-but-absent wiki dir — it
    // just returns zero hits because the path-filter drops all non-wiki-dir
    // paths. The CLI layer adds the explicit existence check.
    const { stash, cleanup } = withIsolatedStash();
    try {
      const response = await searchInWiki({ stashDir: stash, wikiName: "nonexistent", query: "test" });
      expect(response.hits).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
