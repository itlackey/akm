/**
 * Issue #224: `quality: "proposed"` is excluded from default search.
 *
 * Covers:
 *  - default search excludes `proposed` entries
 *  - `--include-proposed` (i.e. `akmSearch({ includeProposed: true })`) restores them
 *  - `generated` and `curated` remain on by default
 *  - unknown quality values warn once and remain searchable
 *  - SearchHit projection surfaces optional `quality` when present
 *
 * Mirrors the harness in `tests/parallel-search.test.ts` and
 * `tests/issue-36-repro.test.ts`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../src/commands/search";
import { saveConfig } from "../src/core/config";
import { akmIndex } from "../src/indexer/indexer";
import { _resetUnknownQualityWarnings, isProposedQuality, validateStashEntry } from "../src/indexer/metadata";
import type { SourceSearchHit } from "../src/sources/types";

// ── Temp directory tracking ─────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-issue224-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function tmpStash(): string {
  const dir = createTmpDir("akm-issue224-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

async function buildTestIndex(stashDir: string) {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  return akmIndex({ stashDir, full: true });
}

// ── Environment isolation ───────────────────────────────────────────────────

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-issue224-cache-");
  testConfigDir = createTmpDir("akm-issue224-config-");
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  _resetUnknownQualityWarnings();
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalAkmStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalAkmStashDir;
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Author three skills with deliberately distinct quality markers under the
 * same query token so default-vs-include-proposed deltas are obvious.
 */
function seedQualitySpread(stashDir: string): void {
  // Curated entry
  writeFile(
    path.join(stashDir, "skills", "deploy-curated", "SKILL.md"),
    "---\ndescription: Curated deploy skill\ntags:\n  - deploy\nquality: curated\n---\n# Deploy curated\n",
  );

  // Generated entry
  writeFile(
    path.join(stashDir, "skills", "deploy-generated", "SKILL.md"),
    "---\ndescription: Generated deploy skill\ntags:\n  - deploy\nquality: generated\n---\n# Deploy generated\n",
  );

  // Proposed entry — should be filtered by default
  writeFile(
    path.join(stashDir, "skills", "deploy-proposed", "SKILL.md"),
    "---\ndescription: Proposed deploy skill\ntags:\n  - deploy\nquality: proposed\n---\n# Deploy proposed\n",
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Issue #224: proposed quality is excluded from default search", () => {
  test("default search returns curated + generated, excludes proposed", async () => {
    const stashDir = tmpStash();
    seedQualitySpread(stashDir);
    await buildTestIndex(stashDir);

    const result = await akmSearch({ query: "deploy", source: "stash" });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const names = hits.map((h) => h.name);

    expect(names).toContain("deploy-curated");
    expect(names).toContain("deploy-generated");
    expect(names).not.toContain("deploy-proposed");
  });

  test("--include-proposed surfaces proposed entries alongside the rest", async () => {
    const stashDir = tmpStash();
    seedQualitySpread(stashDir);
    await buildTestIndex(stashDir);

    const result = await akmSearch({ query: "deploy", source: "stash", includeProposed: true });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const names = hits.map((h) => h.name);

    expect(names).toContain("deploy-curated");
    expect(names).toContain("deploy-generated");
    expect(names).toContain("deploy-proposed");
  });

  test("empty-query enumeration also excludes proposed by default", async () => {
    const stashDir = tmpStash();
    seedQualitySpread(stashDir);
    await buildTestIndex(stashDir);

    // Empty query path goes through getAllEntries — exercise that code path too.
    const result = await akmSearch({ query: ".", source: "stash", limit: 50 });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const names = hits.map((h) => h.name);

    expect(names).toContain("deploy-curated");
    expect(names).toContain("deploy-generated");
    expect(names).not.toContain("deploy-proposed");

    const opted = await akmSearch({ query: ".", source: "stash", limit: 50, includeProposed: true });
    const optedNames = opted.hits.filter((h): h is SourceSearchHit => h.type !== "registry").map((h) => h.name);
    expect(optedNames).toContain("deploy-proposed");
  });
});

describe("Issue #224: SearchHit surfaces optional quality field", () => {
  test("hits carry quality verbatim when present, omit it otherwise", async () => {
    const stashDir = tmpStash();
    seedQualitySpread(stashDir);
    await buildTestIndex(stashDir);

    const result = await akmSearch({ query: "deploy", source: "stash", includeProposed: true });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    const curated = hits.find((h) => h.name === "deploy-curated");
    const generated = hits.find((h) => h.name === "deploy-generated");
    const proposed = hits.find((h) => h.name === "deploy-proposed");

    expect(curated?.quality).toBe("curated");
    expect(generated?.quality).toBe("generated");
    expect(proposed?.quality).toBe("proposed");
  });
});

describe("Issue #224: unknown quality values warn once and remain searchable", () => {
  test("validateStashEntry preserves unknown quality and warns once per value", () => {
    const calls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      calls.push(args.map(String).join(" "));
    };
    try {
      _resetUnknownQualityWarnings();

      const a = validateStashEntry({ name: "a", type: "skill", quality: "experimental" });
      const b = validateStashEntry({ name: "b", type: "skill", quality: "experimental" });
      const c = validateStashEntry({ name: "c", type: "skill", quality: "draft" });

      expect(a?.quality).toBe("experimental");
      expect(b?.quality).toBe("experimental");
      expect(c?.quality).toBe("draft");

      // One warn per unique unknown value — not per occurrence.
      const unknownWarns = calls.filter((c) => c.includes("unknown quality value"));
      expect(unknownWarns.length).toBe(2);
      expect(unknownWarns.some((m) => m.includes("experimental"))).toBe(true);
      expect(unknownWarns.some((m) => m.includes("draft"))).toBe(true);

      // Known values must not warn.
      const known = validateStashEntry({ name: "d", type: "skill", quality: "curated" });
      expect(known?.quality).toBe("curated");
      const knownGen = validateStashEntry({ name: "e", type: "skill", quality: "generated" });
      expect(knownGen?.quality).toBe("generated");
      const knownProp = validateStashEntry({ name: "f", type: "skill", quality: "proposed" });
      expect(knownProp?.quality).toBe("proposed");
      const stillTwo = calls.filter((c) => c.includes("unknown quality value")).length;
      expect(stillTwo).toBe(2);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("unknown quality entries remain in default search (treated as included-by-default)", async () => {
    const stashDir = tmpStash();
    writeFile(
      path.join(stashDir, "skills", "deploy-experimental", "SKILL.md"),
      "---\ndescription: Experimental quality marker test\ntags:\n  - deploy\nquality: experimental\n---\n# deploy\n",
    );

    // Suppress warns from the indexer load path so they don't pollute test output.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await buildTestIndex(stashDir);

      const result = await akmSearch({ query: "deploy", source: "stash" });
      const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
      const names = hits.map((h) => h.name);
      expect(names).toContain("deploy-experimental");

      // Quality field is surfaced verbatim on the hit.
      const experimental = hits.find((h) => h.name === "deploy-experimental");
      expect(experimental?.quality).toBe("experimental");
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("Issue #224: isProposedQuality helper", () => {
  test("returns true only for the literal 'proposed' marker", () => {
    expect(isProposedQuality("proposed")).toBe(true);
    expect(isProposedQuality("curated")).toBe(false);
    expect(isProposedQuality("generated")).toBe(false);
    expect(isProposedQuality(undefined)).toBe(false);
    expect(isProposedQuality("PROPOSED")).toBe(false);
    expect(isProposedQuality("experimental")).toBe(false);
  });
});
