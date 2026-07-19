import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { buildSearchFields, buildSearchText } from "../../src/indexer/search/search-fields";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { rebuildFts, searchFts } from "../../src/storage/repositories/index-fts-repository";
import { DB_VERSION } from "../../src/storage/repositories/index-schema";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "fts"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

function tmpDbPath(label = "fts"): string {
  const dir = tmpDir(label);
  return path.join(dir, "test.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<IndexDocument> & { name: string; type: string }): IndexDocument {
  return {
    description: "A test entry",
    ...overrides,
  };
}

function insertEntry(db: Database, key: string, entry: IndexDocument, searchText: string): number {
  return upsertEntry(db, key, "/test/dir", `/test/dir/${key}.ts`, "/test/stash", entry, searchText);
}

// ── Test 1: Name match ranks higher than description-only match ─────────────

describe("FTS5 field weighting", () => {
  test("name match ranks higher than description-only match", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      // Entry with "deploy" in the name
      const nameEntry = makeEntry({
        name: "deploy",
        type: "script",
        description: "Runs a production release process",
      });
      insertEntry(db, "name-deploy", nameEntry, "deploy");

      // Entry with "deploy" only in the description
      const descEntry = makeEntry({
        name: "release-tool",
        type: "script",
        description: "Used to deploy applications to staging servers",
      });
      insertEntry(db, "desc-deploy", descEntry, "deploy");

      rebuildFts(db);

      const results = searchFts(db, "deploy", 10);
      expect(results.length).toBe(2);
      // The name match should rank first (lower bm25 score = better in FTS5)
      expect(results[0].entry.name).toBe("deploy");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 2: Name match ranks higher than tag-only match ─────────────────

  test("name match ranks higher than tag-only match", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      // Entry with "kubernetes" in the name
      const nameEntry = makeEntry({
        name: "kubernetes",
        type: "script",
        description: "Container orchestration management tool",
      });
      insertEntry(db, "name-k8s", nameEntry, "kubernetes");

      // Entry with "kubernetes" only in tags
      const tagEntry = makeEntry({
        name: "container-manager",
        type: "script",
        description: "Manages container lifecycle operations",
        tags: ["kubernetes", "docker"],
      });
      insertEntry(db, "tag-k8s", tagEntry, "kubernetes");

      rebuildFts(db);

      const results = searchFts(db, "kubernetes", 10);
      expect(results.length).toBe(2);
      expect(results[0].entry.name).toBe("kubernetes");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 3: Description match ranks higher than content-only (TOC) match ──

  test("description match ranks higher than content-only match", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      // Entry with "terraform" in description
      const descEntry = makeEntry({
        name: "infra-tool",
        type: "script",
        description: "Uses terraform to provision cloud infrastructure",
      });
      insertEntry(db, "desc-tf", descEntry, "terraform");

      // Entry with "terraform" only in content/TOC
      const contentEntry = makeEntry({
        name: "cloud-guide",
        type: "knowledge",
        description: "Guide to cloud architecture patterns",
        toc: [{ text: "terraform setup", level: 2, line: 1 }],
      });
      insertEntry(db, "content-tf", contentEntry, "terraform");

      rebuildFts(db);

      const results = searchFts(db, "terraform", 10);
      expect(results.length).toBe(2);
      expect(results[0].entry.name).toBe("infra-tool");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 4: Multi-field matches rank highest ──────────────────────────────

  test("multi-field matches rank highest", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      // Entry with "deploy" in BOTH name and description
      const multiEntry = makeEntry({
        name: "deploy",
        type: "script",
        description: "Deploy applications to production deploy pipelines",
        tags: ["deploy"],
      });
      insertEntry(db, "multi-deploy", multiEntry, "deploy");

      // Entry with "deploy" only in name
      const nameOnlyEntry = makeEntry({
        name: "deploy-lite",
        type: "script",
        description: "Lightweight release process for staging",
      });
      insertEntry(db, "name-deploy", nameOnlyEntry, "deploy");

      rebuildFts(db);

      const results = searchFts(db, "deploy", 10);
      expect(results.length).toBe(2);
      // The multi-field match should rank first
      expect(results[0].entry.name).toBe("deploy");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 5: FTS5 table has separate columns ───────────────────────────────

  test("FTS5 table has separate columns", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      // Query the FTS5 table config to verify it has the expected columns
      // FTS5 tables expose column info via sqlite_master
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entries_fts'").get() as
        | { sql: string }
        | undefined;
      expect(row).toBeDefined();
      const sql = (row as { sql: string }).sql.toLowerCase();
      // Should have separate columns instead of a single search_text
      expect(sql).toContain("name");
      expect(sql).toContain("description");
      expect(sql).toContain("tags");
      expect(sql).toContain("hints");
      expect(sql).toContain("content");
      // Should NOT have the old single search_text column
      expect(sql).not.toContain("search_text");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 6: DB_VERSION is incremented ─────────────────────────────────────

  test("DB_VERSION is at least 7 (multi-column FTS5)", () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(7);
  });

  // ── Test 7: Existing search queries still return results ──────────────────

  test("existing search queries still return results (no regression)", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      const entry = makeEntry({
        name: "deploy-tool",
        type: "script",
        description: "Deploy applications to production servers",
        tags: ["deploy", "production"],
        searchHints: ["release management"],
      });
      insertEntry(
        db,
        "deploy-tool",
        entry,
        "deploy tool deploy applications to production servers deploy production release management",
      );

      rebuildFts(db);

      // Verify various query patterns still work
      const deployResults = searchFts(db, "deploy", 10);
      expect(deployResults.length).toBeGreaterThanOrEqual(1);

      const productionResults = searchFts(db, "production", 10);
      expect(productionResults.length).toBeGreaterThanOrEqual(1);

      const multiWordResults = searchFts(db, "deploy production", 10);
      expect(multiWordResults.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Test buildSearchFields ──────────────────────────────────────────────────

describe("buildSearchFields", () => {
  test("returns separate field strings from entry", () => {
    const entry = makeEntry({
      name: "deploy-tool",
      type: "script",
      description: "Deploy applications to production",
      tags: ["deploy", "production"],
      searchHints: ["release management", "rollout"],
      toc: [
        { text: "Getting Started", level: 1, line: 1 },
        { text: "Configuration", level: 2, line: 5 },
      ],
    });

    const fields = buildSearchFields(entry);
    expect(fields.name).toContain("deploy");
    expect(fields.name).toContain("tool");
    expect(fields.description).toContain("deploy applications to production");
    expect(fields.tags).toContain("deploy");
    expect(fields.tags).toContain("production");
    expect(fields.hints).toContain("release management");
    expect(fields.hints).toContain("rollout");
    expect(fields.content).toContain("getting started");
    expect(fields.content).toContain("configuration");
  });

  test("handles entry with minimal fields", () => {
    const entry = makeEntry({
      name: "simple",
      type: "script",
    });

    const fields = buildSearchFields(entry);
    expect(fields.name).toBe("simple");
    expect(fields.description).toBe("a test entry");
    expect(fields.tags).toBe("");
    expect(fields.hints).toBe("");
    expect(fields.content).toBe("");
  });
});

// ── SPEC-8: bodyOpening folds into the FTS content field ────────────────────
//
// docs/design/stash-conventions-code-spec.md SPEC-8: when the metadata pass
// (gated by `index.indexBodyOpening`) has put the first body paragraph on
// IndexDocument.bodyOpening, buildSearchFields folds it into the lowest-weight
// `content` column (bm25 weight 1.0) — NOT `hints` — so orientation prose is
// retrievable without outranking name/description/tag matches. Entries
// without bodyOpening must keep byte-identical search fields.

/**
 * SPEC-8 adds `bodyOpening?: string` to IndexDocument. Attach it via a cast so
 * this file compiles before the field exists; the tests then go red on the
 * runtime search-field/FTS behavior instead of a compile error.
 */
function withBodyOpening(entry: IndexDocument, bodyOpening: string): IndexDocument {
  return { ...entry, bodyOpening } as IndexDocument;
}

describe("SPEC-8 bodyOpening indexing", () => {
  test("buildSearchFields folds bodyOpening into content (lowercased), not hints", () => {
    const entry = withBodyOpening(
      makeEntry({
        name: "project-orienter",
        type: "memory",
        description: "Where auth work lives",
        tags: ["auth"],
        searchHints: ["auth refresh"],
        toc: [{ text: "Decisions", level: 2, line: 3 }],
      }),
      "This page situates the Quokka onboarding ledger workstream.",
    );

    const fields = buildSearchFields(entry);
    // Folded verbatim (lowercased) into the catch-all content column…
    expect(fields.content).toContain("this page situates the quokka onboarding ledger workstream.");
    // …appended to the existing content parts, not replacing them.
    expect(fields.content).toContain("decisions");
    // The designated field is content — no higher-weight column may pick it up.
    expect(fields.hints).not.toContain("quokka");
    expect(fields.name).not.toContain("quokka");
    expect(fields.description).not.toContain("quokka");
    expect(fields.tags).not.toContain("quokka");
    // The concatenated search/embedding text inherits it via content.
    expect(buildSearchText(entry)).toContain("quokka onboarding ledger");
  });

  test("entries without bodyOpening keep byte-identical search fields (default pin)", () => {
    // Pins today's exact field bytes for a representative fully-populated
    // entry. SPEC-8's default-off promise is that this never shifts: the fold
    // may only add text when bodyOpening is present on the entry.
    const entry = makeEntry({
      name: "deploy-tool",
      type: "script",
      description: "Deploy applications to production",
      tags: ["deploy", "production"],
      aliases: ["release"],
      searchHints: ["release management"],
      toc: [{ text: "Getting Started", level: 1, line: 1 }],
      parameters: [{ name: "service", description: "Service slug" }],
    });

    expect(buildSearchFields(entry)).toEqual({
      name: "deploy tool",
      description: "deploy applications to production",
      tags: "deploy production release",
      hints: "release management",
      content: "getting started service service slug",
    });
  });

  test("an orientation-only phrase matches via the FTS content column", () => {
    const db = openIndexDatabase(tmpDbPath("spec8"));
    try {
      const entry = withBodyOpening(
        makeEntry({ name: "project-orienter", type: "memory", description: "Notes about the platform" }),
        "This memory situates the quokka onboarding ledger workstream.",
      );
      // search_text deliberately omits the phrase: the FTS columns are built
      // by rebuildFts from entry_json via buildSearchFields, so a hit proves
      // the fold — not a legacy search_text leak.
      const id = insertEntry(db, "orienter", entry, "project orienter notes about the platform");
      rebuildFts(db);

      const results = searchFts(db, "quokka", 10);
      expect(results.length).toBe(1);
      expect(results[0].entry.name).toBe("project-orienter");

      // Column-level pin: the token landed in `content`, and only there.
      const row = db.prepare("SELECT content, hints FROM entries_fts WHERE entry_id = ?").get(id) as
        | { content: string; hints: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.content ?? "").toContain("quokka");
      expect(row?.hints ?? "").not.toContain("quokka");
    } finally {
      closeDatabase(db);
    }
  });

  test("name match still outranks a bodyOpening-only match", () => {
    const db = openIndexDatabase(tmpDbPath("spec8-rank"));
    try {
      const nameEntry = makeEntry({
        name: "quokka-runbook",
        type: "knowledge",
        description: "Operational runbook",
      });
      insertEntry(db, "name-quokka", nameEntry, "quokka runbook");

      const bodyEntry = withBodyOpening(
        makeEntry({ name: "unrelated-notes", type: "memory", description: "General project notes" }),
        "Mentions the quokka rollout only in its body opening.",
      );
      insertEntry(db, "body-quokka", bodyEntry, "unrelated notes");

      rebuildFts(db);

      const results = searchFts(db, "quokka", 10);
      // The body-opening match IS retrievable (that's the feature)…
      expect(results.length).toBe(2);
      // …but the name match wins: content carries the lowest bm25 weight
      // (name 10.0 vs content 1.0), so orientation prose never outranks names.
      expect(results[0].entry.name).toBe("quokka-runbook");
    } finally {
      closeDatabase(db);
    }
  });
});
