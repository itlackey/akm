/**
 * Parity regression for Phase 4 (spec §10 step 4 / §6.2).
 *
 * `akm show` now consults `indexer.lookup(ref)` first, then reads the file
 * from disk. The risk called out in the v1 implementation plan is that
 * origin-prefixed refs (e.g. `local//skill:foo`) silently regress when the
 * indexer is consulted instead of the directory walker.
 *
 * This test pins both forms — bare ref and origin-prefixed ref — and asserts
 * that `indexer.lookup` returns the same on-disk path that `akmShowUnified`
 * resolves to. If a future refactor changes how the indexer keys assets, this
 * test fails fast instead of silently breaking show for installed sources.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmShowUnified } from "../../src/commands/show";
import { parseAssetRef } from "../../src/core/asset-ref";
import { resetConfigCache, saveConfig } from "../../src/core/config";
import { closeDatabase, getMeta, openDatabase, searchVec } from "../../src/indexer/db";
import { akmIndex, lookup } from "../../src/indexer/indexer";
import "../../src/sources/providers/index";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-parity-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createMockEmbeddingServer(embedding: number[] = [1, 0, 0, 0]): {
  url: string;
  server: ReturnType<typeof Bun.serve>;
} {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(JSON.stringify({ data: [{ embedding }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { url: `http://localhost:${server.port}/v1/embeddings`, server };
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalStashDir = process.env.AKM_STASH_DIR;
let stashDir = "";

beforeEach(() => {
  process.env.XDG_CACHE_HOME = createTmpDir("akm-parity-cache-");
  process.env.XDG_CONFIG_HOME = createTmpDir("akm-parity-config-");
  stashDir = createTmpDir("akm-parity-stash-");
  for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }
  process.env.AKM_STASH_DIR = stashDir;
  resetConfigCache();
  saveConfig({ semanticSearchMode: "off" });
  resetConfigCache();
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalStashDir;
});

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Phase 4 parity: indexer.lookup ↔ akmShowUnified", () => {
  test("indexed asset: lookup() returns the same file akmShow renders", async () => {
    const skillBody = [
      "---",
      "name: parity-skill",
      "description: A skill used to verify Phase 4 parity",
      "---",
      "# Parity skill",
      "",
      "Body content used by the parity test.",
    ].join("\n");
    // Skills live at skills/<name>/SKILL.md (see asset-spec.ts)
    writeFile(path.join(stashDir, "skills", "parity-skill", "SKILL.md"), skillBody);

    await akmIndex({ stashDir, full: true });

    const ref = "skill:parity-skill";
    const parsed = parseAssetRef(ref);
    const indexed = await lookup(parsed);
    expect(indexed).not.toBeNull();
    if (!indexed) return;

    expect(indexed.type).toBe("skill");
    expect(indexed.name).toBe("parity-skill");

    // Reading the indexer-resolved path should yield the on-disk content.
    const fileBody = fs.readFileSync(indexed.filePath, "utf8");
    expect(fileBody).toBe(skillBody);

    // akmShow returns the same path in its rendered response.
    const shown = await akmShowUnified({ ref });
    expect(shown.path).toBe(indexed.filePath);
  });

  test("origin-prefixed ref: local//skill:foo resolves to primary stash path", async () => {
    const body = ["---", "name: origin-skill", "description: Test", "---", "# origin"].join("\n");
    writeFile(path.join(stashDir, "skills", "origin-skill", "SKILL.md"), body);

    await akmIndex({ stashDir, full: true });

    const bare = await lookup(parseAssetRef("skill:origin-skill"));
    const local = await lookup(parseAssetRef("local//skill:origin-skill"));
    expect(bare).not.toBeNull();
    expect(local).not.toBeNull();
    expect(local?.filePath).toBe(bare?.filePath);

    // Show parity for both ref forms.
    const shownBare = await akmShowUnified({ ref: "skill:origin-skill" });
    const shownLocal = await akmShowUnified({ ref: "local//skill:origin-skill" });
    expect(shownBare.path).toBe(shownLocal.path);
    expect(shownBare.path).toBe(bare?.filePath as string);
  });

  test("lookup and show do not downgrade embedding dimension metadata", async () => {
    const { url, server } = createMockEmbeddingServer();
    const body = ["---", "name: embed-skill", "description: Test", "---", "# embed"].join("\n");
    writeFile(path.join(stashDir, "skills", "embed-skill", "SKILL.md"), body);

    saveConfig({
      semanticSearchMode: "auto",
      embedding: {
        provider: "openai-compatible",
        endpoint: url,
        model: "test-embed",
        dimension: 4,
      },
    });
    resetConfigCache();

    try {
      await akmIndex({ stashDir, full: true });
      await lookup(parseAssetRef("skill:embed-skill"));
      await akmShowUnified({ ref: "skill:embed-skill" });

      const db = openDatabase(path.join(process.env.XDG_CACHE_HOME as string, "akm", "index.db"), { embeddingDim: 4 });
      try {
        expect(getMeta(db, "embeddingDim")).toBe("4");
        expect(getMeta(db, "hasEmbeddings")).toBe("1");
        expect(searchVec(db, [1, 0, 0, 0], 10)).toHaveLength(1);
      } finally {
        closeDatabase(db);
      }
    } finally {
      server.stop();
    }
  });

  test("missing asset: lookup returns null", async () => {
    await akmIndex({ stashDir, full: true });
    const result = await lookup(parseAssetRef("skill:does-not-exist"));
    expect(result).toBeNull();
  });
});
