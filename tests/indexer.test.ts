import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EmbeddingConnectionConfig } from "../src/core/config";
import { saveConfig } from "../src/core/config";
import { getDbPath } from "../src/core/paths";
import { closeDatabase, DB_VERSION, getAllEntries, getEmbeddingCount, getMeta, openDatabase } from "../src/indexer/db";
import { akmIndex, buildFileBasenameMap, matchEntryToFile } from "../src/indexer/indexer";
import { buildSearchText } from "../src/indexer/search-fields";
import * as embedderModule from "../src/llm/embedder";

let testConfigDir = "";
let testCacheDir = "";
let embedBatchImpl:
  | ((texts: string[], embeddingConfig?: EmbeddingConnectionConfig) => Promise<Float32Array[]>)
  | undefined;
const actualEmbedBatch = embedderModule.embedBatch;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

mock.module("../src/llm/embedder.js", () => ({
  ...embedderModule,
  embedBatch: (texts: string[], embeddingConfig?: EmbeddingConnectionConfig) =>
    embedBatchImpl ? embedBatchImpl(texts, embeddingConfig) : actualEmbedBatch(texts, embeddingConfig),
}));

// Each test gets a fresh database and isolated config/cache
beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-idx-config-"));
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-idx-cache-"));
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_CACHE_HOME = testCacheDir;
  embedBatchImpl = undefined;

  const dbPath = getDbPath();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

afterEach(() => {
  embedBatchImpl = undefined;
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
});

function tmpStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-idx-"));
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("akmIndex scans directories and builds index", async () => {
  const stashDir = tmpStash();
  writeFile(
    path.join(stashDir, "scripts", "deploy", "deploy.sh"),
    "#!/usr/bin/env bash\n# Deploy to staging\necho deploy\n",
  );
  writeFile(path.join(stashDir, "scripts", "lint", "lint.ts"), "/**\n * Lint source code\n */\nconsole.log('lint')\n");

  process.env.AKM_STASH_DIR = stashDir;
  const result = await akmIndex({ stashDir });

  expect(result.totalEntries).toBe(2);
  expect(result.generatedMetadata).toBe(2);
  expect(result.stashDir).toBe(stashDir);

  // Verify entries are in the database (not in .stash.json files)
  const deployStash = path.join(stashDir, "scripts", "deploy", ".stash.json");
  expect(fs.existsSync(deployStash)).toBe(false);

  const db = openDatabase();
  const entries = getAllEntries(db);
  expect(entries.length).toBe(2);
  const deployEntry = entries.find((e) => e.entry.name.includes("deploy"));
  expect(deployEntry).toBeDefined();
  expect(deployEntry?.entry.quality).toBe("generated");
  closeDatabase(db);
});

test("akmIndex preserves manually-written .stash.json", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "scripts", "git", "summarize.ts"), "console.log('x')\n");
  writeFile(
    path.join(stashDir, "scripts", "git", ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "git-summarize",
          type: "script",
          description: "Summarize git changes",
          tags: ["git", "summary"],
          filename: "summarize.ts",
        },
      ],
    }),
  );

  const result = await akmIndex({ stashDir });

  expect(result.totalEntries).toBe(1);
  expect(result.generatedMetadata).toBe(1);

  // Verify the manual .stash.json was not overwritten
  const stash = JSON.parse(fs.readFileSync(path.join(stashDir, "scripts", "git", ".stash.json"), "utf8"));
  expect(stash.entries[0].name).toBe("git-summarize");
  expect(stash.entries[0].quality).toBeUndefined();
});

test("akmIndex writes index to SQLite database", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "scripts", "hello", "hello.sh"), "#!/bin/bash\necho hi\n");

  const result = await akmIndex({ stashDir });
  expect(fs.existsSync(result.indexPath)).toBe(true);
  expect(result.indexPath).toEndWith(".db");

  const db = openDatabase();
  const version = getMeta(db, "version");
  expect(version).toBe(String(DB_VERSION));
  const entries = getAllEntries(db);
  expect(entries.length).toBeGreaterThan(0);
  closeDatabase(db);
});

test("akmIndex handles empty stash gracefully", async () => {
  const stashDir = tmpStash();
  const result = await akmIndex({ stashDir });

  expect(result.totalEntries).toBe(0);
  expect(result.generatedMetadata).toBe(0);
  expect(result.verification.ok).toBe(true);
  expect(result.verification.message).toContain("No assets");
});

test("akmIndex handles markdown assets", async () => {
  const stashDir = tmpStash();
  writeFile(
    path.join(stashDir, "commands", "release.md"),
    '---\ndescription: "Release the project"\n---\nRun the release\n',
  );
  writeFile(
    path.join(stashDir, "skills", "refactor", "SKILL.md"),
    '---\ndescription: "Refactor code"\n---\n# Refactor skill\n',
  );

  const result = await akmIndex({ stashDir });
  expect(result.totalEntries).toBe(2);
});

test("akmIndex classifies flat markdown files under skills/ as skill assets", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "skills", "deploy.md"), "---\ndescription: Deploy skill\n---\n# Deploy\n");

  await akmIndex({ stashDir, full: true });

  const db = openDatabase();
  const skillEntry = getAllEntries(db).find((row) => row.entry.type === "skill" && row.entry.name === "deploy");
  expect(skillEntry).toBeDefined();
  closeDatabase(db);
});

test("akmIndex includes wiki raw files but excludes infrastructure files from the primary stash index", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "wikis", "research", "schema.md"), "---\ndescription: Schema\n---\n# Schema\n");
  writeFile(path.join(stashDir, "wikis", "research", "index.md"), "---\ndescription: Index\n---\n# Index\n");
  writeFile(path.join(stashDir, "wikis", "research", "log.md"), "---\ndescription: Log\n---\n# Log\n");
  writeFile(
    path.join(stashDir, "wikis", "research", "raw", "paper.md"),
    "---\ndescription: Raw source\n---\n# Paper\n",
  );
  writeFile(path.join(stashDir, "wikis", "research", "page.md"), "---\ndescription: Indexed page\n---\n# Page\n");

  await akmIndex({ stashDir, full: true });

  const db = openDatabase();
  const wikiEntries = getAllEntries(db, "wiki")
    .map((row) => row.entry.name)
    .sort();
  expect(wikiEntries).toEqual(["research/page", "research/raw/paper"]);
  closeDatabase(db);
});

test("akmIndex includes wiki raw files but excludes infrastructure files for wiki-root stash sources", async () => {
  const primaryStash = tmpStash();
  const wikiSource = fs.mkdtempSync(path.join(os.tmpdir(), "akm-idx-wiki-source-"));
  writeFile(path.join(wikiSource, "schema.md"), "---\ndescription: Schema\n---\n# Schema\n");
  writeFile(path.join(wikiSource, "index.md"), "---\ndescription: Index\n---\n# Index\n");
  writeFile(path.join(wikiSource, "log.md"), "---\ndescription: Log\n---\n# Log\n");
  writeFile(path.join(wikiSource, "raw", "paper.md"), "---\ndescription: Raw source\n---\n# Paper\n");
  writeFile(path.join(wikiSource, "page.md"), "---\ndescription: Indexed page\n---\n# Page\n");
  writeFile(path.join(wikiSource, "sub", "page-two.md"), "---\ndescription: Indexed page two\n---\n# Page Two\n");

  const origStash = process.env.AKM_STASH_DIR;
  try {
    const { saveConfig } = await import("../src/core/config");
    process.env.AKM_STASH_DIR = primaryStash;
    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: wikiSource, wikiName: "research" }],
    });

    await akmIndex({ stashDir: primaryStash, full: true });

    const db = openDatabase();
    const wikiEntries = getAllEntries(db, "wiki")
      .map((row) => row.entry.name)
      .sort();
    expect(wikiEntries).toEqual(["research/page", "research/raw/paper", "research/sub/page-two"]);
    closeDatabase(db);
  } finally {
    if (origStash === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = origStash;
    fs.rmSync(wikiSource, { recursive: true, force: true });
  }
});

test("akmIndex applies curated frontmatter metadata for wiki-root stash sources", async () => {
  const primaryStash = tmpStash();
  const wikiSource = fs.mkdtempSync(path.join(os.tmpdir(), "akm-idx-wiki-source-"));
  writeFile(
    path.join(wikiSource, "page.md"),
    [
      "---",
      "description: Indexed page",
      "tags:",
      "  - architecture",
      "aliases:",
      "  - system overview",
      "searchHints:",
      "  - explain system design",
      "usage:",
      "  - Read before changing the indexing pipeline",
      "scope_agent: opencode",
      "wikiRole: page",
      "pageKind: concept",
      "xrefs:",
      "  - knowledge:indexing",
      "sources:",
      "  - raw/design-doc",
      "---",
      "# Page",
    ].join("\n"),
  );

  const origStash = process.env.AKM_STASH_DIR;
  try {
    process.env.AKM_STASH_DIR = primaryStash;
    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: wikiSource, wikiName: "research" }],
    });

    await akmIndex({ stashDir: primaryStash, full: true });

    const db = openDatabase();
    const wikiEntry = getAllEntries(db, "wiki").find((row) => row.entry.name === "research/page")?.entry;
    expect(wikiEntry).toBeDefined();
    expect(wikiEntry).toMatchObject({
      description: "Indexed page",
      tags: ["architecture"],
      searchHints: ["explain system design"],
      usage: ["Read before changing the indexing pipeline"],
      scope: { agent: "opencode" },
      wikiRole: "page",
      pageKind: "concept",
      xrefs: ["knowledge:indexing"],
      sources: ["raw/design-doc"],
      source: "frontmatter",
    });
    expect(wikiEntry?.aliases).toEqual(expect.arrayContaining(["system overview"]));
    closeDatabase(db);
  } finally {
    if (origStash === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = origStash;
    fs.rmSync(wikiSource, { recursive: true, force: true });
  }
});

test("akmIndex skips malformed workflow assets and reports warnings", async () => {
  const stashDir = tmpStash();
  writeFile(
    path.join(stashDir, "workflows", "good.md"),
    [
      "---",
      "description: Good workflow",
      "---",
      "",
      "# Workflow: Good",
      "",
      "## Step: First",
      "Step ID: first",
      "### Instructions",
      "Do it.",
      "",
    ].join("\n"),
  );
  // Truly malformed: no `# Workflow:` heading at all. (Intro prose between
  // the title and the first step is now permitted — see #158.)
  writeFile(
    path.join(stashDir, "workflows", "bad.md"),
    [
      "---",
      "description: Bad workflow",
      "---",
      "",
      "## Step: First",
      "Step ID: first",
      "### Instructions",
      "Do it.",
      "",
    ].join("\n"),
  );

  const result = await akmIndex({ stashDir, full: true });

  expect(result.totalEntries).toBe(1);
  expect(result.warnings).toBeDefined();
  expect(result.warnings?.some((warning) => warning.includes(path.join(stashDir, "workflows", "bad.md")))).toBe(true);

  const db = openDatabase();
  const workflowEntries = getAllEntries(db, "workflow")
    .map((row) => row.entry.name)
    .sort();
  expect(workflowEntries).toEqual(["good"]);
  closeDatabase(db);
});

test("akmIndex generates TOC in database for knowledge entries", async () => {
  const stashDir = tmpStash();
  writeFile(
    path.join(stashDir, "knowledge", "guide.md"),
    '---\ndescription: "A guide"\n---\n# Getting Started\n\nIntro.\n\n## Installation\n\nInstall steps.\n',
  );

  const result = await akmIndex({ stashDir });
  expect(result.totalEntries).toBe(1);

  // TOC is stored in the database, not in .stash.json
  expect(fs.existsSync(path.join(stashDir, "knowledge", ".stash.json"))).toBe(false);
  const db = openDatabase();
  const entries = getAllEntries(db, "knowledge");
  expect(entries.length).toBe(1);
  expect(entries[0].entry.toc).toBeDefined();
  expect(entries[0].entry.toc?.length).toBe(2);
  expect(entries[0].entry.toc?.[0].text).toBe("Getting Started");
  expect(entries[0].entry.toc?.[1].text).toBe("Installation");
  closeDatabase(db);
});

test("isDirStale detects modified source file newer than index", async () => {
  const stashDir = tmpStash();
  const deployFile = path.join(stashDir, "scripts", "deploy", "deploy.sh");
  writeFile(deployFile, "#!/usr/bin/env bash\necho deploy\n");

  // First index
  const result1 = await akmIndex({ stashDir });
  expect(result1.totalEntries).toBe(1);
  expect(result1.mode).toBe("full");

  // Second index (incremental) — nothing changed, so dir should be skipped
  const result2 = await akmIndex({ stashDir });
  expect(result2.mode).toBe("incremental");
  expect(result2.directoriesSkipped).toBeGreaterThanOrEqual(1);

  // Now touch the source file to make it newer than the index
  const futureTime = new Date(Date.now() + 2000);
  fs.utimesSync(deployFile, futureTime, futureTime);

  // Third index (incremental) — should detect stale dir
  const result3 = await akmIndex({ stashDir });
  expect(result3.mode).toBe("incremental");
  expect(result3.directoriesScanned).toBeGreaterThanOrEqual(1);
});

test("akmIndex --full mode returns mode full", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "scripts", "hello", "hello.sh"), "#!/bin/bash\necho hi\n");

  // First index to create a previous index
  await akmIndex({ stashDir });

  // Second index with full flag — should force full reindex
  const result = await akmIndex({ stashDir, full: true });
  expect(result.mode).toBe("full");
});

test("akmIndex reports progress events and semantic-search verification details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("TEST_EMBEDDING_ERROR");
  }) as unknown as typeof fetch;
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

  try {
    const stashDir = tmpStash();
    writeFile(path.join(stashDir, "scripts", "hello", "hello.sh"), "#!/bin/bash\necho hi\n");

    const { saveConfig } = await import("../src/core/config");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "https://example.test/v1/embeddings",
        model: "demo-embed",
      },
    });

    const messages: string[] = [];
    const result = await akmIndex({
      stashDir,
      onProgress: ({ message }) => {
        messages.push(message);
      },
    });

    expect(messages[0]).toContain("Starting full index");
    expect(messages[0]).toContain("1 stash source");
    expect(messages[0]).toContain("semantic search: remote embeddings");
    expect(messages.some((message) => message.includes("LLM passes disabled; rerun with --enrich"))).toBe(true);
    expect(messages.some((message) => message.includes("Scanned"))).toBe(true);
    expect(messages.some((message) => message.includes("Embedding generation failed: TEST_EMBEDDING_ERROR"))).toBe(
      true,
    );
    expect(warnSpy).toHaveBeenCalledWith("Embedding generation failed, continuing without:", "TEST_EMBEDDING_ERROR");
    expect(messages.at(-1)).toContain("Semantic search verification failed");
    expect(result.verification.ok).toBe(false);
    expect(result.verification.semanticSearchMode).toBe("auto");
    expect(result.verification.semanticStatus).toBe("blocked");
    expect(result.verification.embeddingProvider).toBe("remote");
    expect(result.verification.guidance).toContain("akm index --full --verbose");
  } finally {
    warnSpy.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("akmIndex scan progress events include processed and total counts", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "scripts", "one", "one.sh"), "echo one\n");

  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });

  const scanEvents: Array<{ processed?: number; total?: number; message: string }> = [];
  await akmIndex({
    stashDir,
    onProgress: (event) => {
      if (event.phase === "scan") {
        scanEvents.push({ processed: event.processed, total: event.total, message: event.message });
      }
    },
  });

  expect(scanEvents.some((event) => event.processed !== undefined && event.total !== undefined)).toBe(true);
  expect(scanEvents.some((event) => event.message.includes("Processed 1/1 source"))).toBe(true);
});

test("akmIndex incremental reruns stabilize for stash-owned wiki indexes", async () => {
  const stashDir = tmpStash();
  const wikiDir = path.join(stashDir, "wikis", "research");
  writeFile(path.join(wikiDir, "alpha.md"), "---\ndescription: Alpha page\npageKind: note\n---\n# Alpha\n");

  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });

  const first = await akmIndex({ stashDir });
  const second = await akmIndex({ stashDir });
  const third = await akmIndex({ stashDir });

  expect(first.totalEntries).toBe(second.totalEntries);
  expect(second.totalEntries).toBe(third.totalEntries);
  expect(second.directoriesSkipped).toBeGreaterThanOrEqual(1);
  expect(third.directoriesSkipped).toBeGreaterThanOrEqual(1);
});

test("akmIndex ignores filename-less .stash.json entries and stabilizes incremental reruns", async () => {
  const stashDir = tmpStash();
  const scriptDir = path.join(stashDir, "scripts", "deploy");
  writeFile(path.join(scriptDir, "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
  writeFile(
    path.join(scriptDir, ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "deploy",
          type: "script",
          description: "Deploy without explicit filename",
        },
      ],
    }),
  );

  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });

  const first = await akmIndex({ stashDir, full: true });
  const second = await akmIndex({ stashDir });
  const third = await akmIndex({ stashDir });

  expect(first.totalEntries).toBe(1);
  expect(second.totalEntries).toBe(first.totalEntries);
  expect(third.totalEntries).toBe(second.totalEntries);
  expect(second.directoriesSkipped).toBeGreaterThanOrEqual(1);
  expect(third.directoriesSkipped).toBeGreaterThanOrEqual(1);

  const db = openDatabase();
  try {
    const entries = getAllEntries(db, "script");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.name).toBe("deploy/deploy.sh");
    expect(entries[0]?.entry.description).not.toBe("Deploy without explicit filename");
  } finally {
    closeDatabase(db);
  }
});

test("akmIndex incrementally skips unchanged wiki-root source directories", async () => {
  const primaryStash = tmpStash();
  const wikiSource = fs.mkdtempSync(path.join(os.tmpdir(), "akm-idx-wiki-source-"));
  writeFile(path.join(wikiSource, "page.md"), "---\ndescription: Indexed page\n---\n# Page\n");
  writeFile(path.join(wikiSource, "sub", "page-two.md"), "---\ndescription: Indexed page two\n---\n# Page Two\n");

  const origStash = process.env.AKM_STASH_DIR;
  try {
    process.env.AKM_STASH_DIR = primaryStash;
    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: wikiSource, wikiName: "research" }],
    });

    const first = await akmIndex({ stashDir: primaryStash, full: true });
    const second = await akmIndex({ stashDir: primaryStash });
    const third = await akmIndex({ stashDir: primaryStash });

    expect(first.totalEntries).toBe(2);
    expect(second.mode).toBe("incremental");
    expect(third.mode).toBe("incremental");
    expect(second.totalEntries).toBe(first.totalEntries);
    expect(third.totalEntries).toBe(second.totalEntries);
    expect(second.directoriesSkipped).toBeGreaterThanOrEqual(2);
    expect(third.directoriesSkipped).toBeGreaterThanOrEqual(2);
    expect(second.directoriesScanned).toBe(0);
    expect(third.directoriesScanned).toBe(0);
  } finally {
    if (origStash === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = origStash;
    fs.rmSync(wikiSource, { recursive: true, force: true });
  }
});

test("akmIndex does not re-embed unchanged wiki-root source entries across consecutive incremental runs", async () => {
  const primaryStash = tmpStash();
  const wikiSource = fs.mkdtempSync(path.join(os.tmpdir(), "akm-idx-wiki-source-"));
  writeFile(path.join(wikiSource, "page.md"), "---\ndescription: Indexed page\n---\n# Page\n");
  writeFile(path.join(wikiSource, "sub", "page-two.md"), "---\ndescription: Indexed page two\n---\n# Page Two\n");

  const origStash = process.env.AKM_STASH_DIR;
  try {
    process.env.AKM_STASH_DIR = primaryStash;
    saveConfig({
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "https://example.test/v1/embeddings",
        model: "demo-embed",
        dimension: 4,
      },
      sources: [{ type: "filesystem", path: wikiSource, wikiName: "research" }],
    });

    const embedCalls: number[] = [];
    embedBatchImpl = async (texts) => {
      embedCalls.push(texts.length);
      return texts.map((_text, index) => {
        const embedding = new Float32Array(4);
        embedding[index % 4] = 1;
        return embedding;
      });
    };

    const first = await akmIndex({ stashDir: primaryStash, full: true });
    const callsAfterFirst = embedCalls.length;
    const second = await akmIndex({ stashDir: primaryStash });
    const callsAfterSecond = embedCalls.length;
    const third = await akmIndex({ stashDir: primaryStash });

    expect(first.totalEntries).toBe(2);
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(second.mode).toBe("incremental");
    expect(third.mode).toBe("incremental");
    expect(second.directoriesSkipped).toBeGreaterThanOrEqual(2);
    expect(third.directoriesSkipped).toBeGreaterThanOrEqual(2);
    expect(second.directoriesScanned).toBe(0);
    expect(third.directoriesScanned).toBe(0);
    expect(callsAfterSecond).toBe(callsAfterFirst);
    expect(embedCalls.length).toBe(callsAfterFirst);

    const db = openDatabase(getDbPath(), { embeddingDim: 4 });
    try {
      expect(getEmbeddingCount(db)).toBe(first.totalEntries);
    } finally {
      closeDatabase(db);
    }
  } finally {
    if (origStash === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = origStash;
    fs.rmSync(wikiSource, { recursive: true, force: true });
  }
});

test("akmIndex does not re-embed generated entries when filename-less .stash.json is ignored", async () => {
  const stashDir = tmpStash();
  const scriptDir = path.join(stashDir, "scripts", "deploy");
  writeFile(path.join(scriptDir, "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
  writeFile(
    path.join(scriptDir, ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "deploy",
          type: "script",
          description: "Deploy without explicit filename",
        },
      ],
    }),
  );

  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({
    semanticSearchMode: "auto",
    embedding: {
      endpoint: "https://example.test/v1/embeddings",
      model: "demo-embed",
      dimension: 4,
    },
  });

  const embedCalls: number[] = [];
  embedBatchImpl = async (texts) => {
    embedCalls.push(texts.length);
    return texts.map((_text, index) => {
      const embedding = new Float32Array(4);
      embedding[index % 4] = 1;
      return embedding;
    });
  };

  const first = await akmIndex({ stashDir, full: true });
  const callsAfterFirst = embedCalls.length;
  const second = await akmIndex({ stashDir });
  const callsAfterSecond = embedCalls.length;
  const third = await akmIndex({ stashDir });

  expect(first.totalEntries).toBeGreaterThanOrEqual(1);
  expect(callsAfterFirst).toBeGreaterThan(0);
  expect(callsAfterSecond).toBe(callsAfterFirst);
  expect(embedCalls.length).toBe(callsAfterFirst);
  expect(second.directoriesSkipped).toBeGreaterThanOrEqual(1);
  expect(third.directoriesSkipped).toBeGreaterThanOrEqual(1);

  const db = openDatabase(getDbPath(), { embeddingDim: 4 });
  try {
    expect(getEmbeddingCount(db)).toBe(first.totalEntries);
  } finally {
    closeDatabase(db);
  }
});

test("akmIndex incremental reruns ignore non-indexed companion files in stale detection", async () => {
  const stashDir = tmpStash();
  const projectDir = path.join(stashDir, "knowledge", "project-docs");
  writeFile(path.join(projectDir, "guide.md"), "---\ndescription: Guide\n---\n# Guide\n");
  writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "project-docs" }, null, 2));
  writeFile(path.join(projectDir, "manifest.json"), JSON.stringify({ version: 1 }, null, 2));
  writeFile(path.join(projectDir, "plugin.config.json"), JSON.stringify({ plugin: true }, null, 2));
  writeFile(path.join(projectDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }, null, 2));

  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });

  const first = await akmIndex({ stashDir, full: true });
  const second = await akmIndex({ stashDir });
  const third = await akmIndex({ stashDir });

  expect(first.totalEntries).toBe(1);
  expect(second.totalEntries).toBe(1);
  expect(third.totalEntries).toBe(1);
  expect(second.directoriesSkipped).toBeGreaterThanOrEqual(1);
  expect(third.directoriesSkipped).toBeGreaterThanOrEqual(1);
});

test("akmIndex verifies semantic search when remote embeddings succeed", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "scripts", "hello", "hello.sh"), "#!/bin/bash\necho hi\n");

  const { saveConfig } = await import("../src/core/config");
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({
    semanticSearchMode: "auto",
    embedding: {
      endpoint: "https://example.test/v1/embeddings",
      model: "demo-embed",
      dimension: 3,
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      }),
      { status: 200 },
    )) as typeof globalThis.fetch;

  try {
    const result = await akmIndex({ stashDir });
    expect(result.verification.ok).toBe(true);
    expect(result.verification.semanticSearchMode).toBe("auto");
    expect(["ready-js", "ready-vec"]).toContain(result.verification.semanticStatus);
    expect(result.verification.embeddingCount).toBe(result.totalEntries);
    expect(result.verification.message).toContain("Semantic search ready");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildSearchText includes TOC heading text for knowledge entries", async () => {
  const entry = {
    name: "guide",
    type: "knowledge" as const,
    description: "A guide",
    toc: [
      { level: 1, text: "Getting Started", line: 4 },
      { level: 2, text: "Installation", line: 8 },
    ],
  };

  const text = buildSearchText(entry);
  expect(text).toContain("getting started");
  expect(text).toContain("installation");
});

test("buildSearchText includes searchHints array content", () => {
  const entry = {
    name: "git-diff",
    type: "script" as const,
    description: "summarize git changes",
    searchHints: ["explain what changed in a repository", "show commit summary"],
  };

  const text = buildSearchText(entry);
  expect(text).toContain("explain what changed in a repository");
  expect(text).toContain("show commit summary");
});

test("buildSearchText includes usage array content", () => {
  const entry = {
    name: "ci-runner",
    type: "script" as const,
    description: "run CI pipeline",
    usage: ["run in CI", "deploy to production"],
  };

  const text = buildSearchText(entry);
  expect(text).toContain("run in ci");
  expect(text).toContain("deploy to production");
});

test("buildSearchText handles entries with both searchHints and intent fields", () => {
  const entry = {
    name: "deploy",
    type: "script" as const,
    description: "deploy services",
    searchHints: ["deploy to production", "push services live"],
    intent: { when: "user needs to deploy", input: "service name", output: "status" },
  };

  const text = buildSearchText(entry);
  expect(text).toContain("deploy to production");
  expect(text).toContain("push services live");
  expect(text).toContain("user needs to deploy");
  expect(text).toContain("service name");
});

test("akmIndex does not generate heuristic searchHints (LLM-only)", async () => {
  const stashDir = tmpStash();
  writeFile(
    path.join(stashDir, "scripts", "deploy", "deploy.sh"),
    "#!/usr/bin/env bash\n# Deploy services to production\necho deploy\n",
  );

  await akmIndex({ stashDir });

  // Search hints are only generated when LLM is configured
  const db = openDatabase();
  const entries = getAllEntries(db, "script");
  expect(entries.length).toBe(1);
  expect(entries[0].entry.searchHints).toBeUndefined();
  closeDatabase(db);
});

// ── T2: Incremental indexing with multi-stash-dir deduplication ─────────────
//
// When multiple stash directories contain overlapping paths (e.g. a shared
// directory or symlinked directory appears in two stash sources), the indexer
// should deduplicate using the `seenPaths` set so each directory is only
// indexed once and entries are not duplicated.

test("akmIndex deduplicates overlapping directories across multiple stash dirs", async () => {
  // Create a primary stash dir with a script
  const primaryStash = tmpStash();
  writeFile(path.join(primaryStash, "scripts", "shared", "shared.sh"), "#!/bin/bash\necho shared\n");

  // Create a second stash dir that is actually the SAME directory
  // (simulates overlapping stashes pointing to the same location)
  const secondStash = primaryStash;

  // Write a config that includes the same directory twice via stashes
  const { saveConfig } = await import("../src/core/config");
  process.env.AKM_STASH_DIR = primaryStash;
  saveConfig({ semanticSearchMode: "off", sources: [{ type: "filesystem", path: secondStash }] });

  const result = await akmIndex({ stashDir: primaryStash });

  // The shared script should appear exactly once, not duplicated
  const db = openDatabase();
  const entries = getAllEntries(db, "script");
  const sharedEntries = entries.filter((e) => e.entry.name.includes("shared"));
  expect(sharedEntries).toHaveLength(1);
  closeDatabase(db);

  expect(result.totalEntries).toBeGreaterThanOrEqual(1);
});

test("akmIndex deduplicates when two stash dirs share a common subdirectory", async () => {
  // Create a shared directory with content
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-idx-shared-"));
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(sharedDir, sub), { recursive: true });
  }
  writeFile(path.join(sharedDir, "scripts", "utility", "util.sh"), "#!/bin/bash\necho utility\n");

  // Create two stash dirs, both pointing to the same shared dir
  const stash1 = sharedDir;
  const stash2 = sharedDir;

  const { saveConfig } = await import("../src/core/config");
  process.env.AKM_STASH_DIR = stash1;
  saveConfig({ semanticSearchMode: "off", sources: [{ type: "filesystem", path: stash2 }] });

  await akmIndex({ stashDir: stash1, full: true });

  const db = openDatabase();
  const entries = getAllEntries(db);
  // Count entries with the utility name — should be exactly 1
  const utilEntries = entries.filter((e) => e.entry.name.includes("util"));
  expect(utilEntries).toHaveLength(1);
  closeDatabase(db);

  // Clean up
  fs.rmSync(sharedDir, { recursive: true, force: true });
});

// ── Issue #13: matchEntryToFile returns null for empty files ─────────────

test("matchEntryToFile returns null when files array is empty", () => {
  const fileMap = buildFileBasenameMap([]);
  const result = matchEntryToFile("nonexistent-entry", fileMap, []);
  expect(result).toBeNull();
});

test("matchEntryToFile returns null when no name match exists", () => {
  const files = ["/stash/scripts/deploy/deploy.sh"];
  const fileMap = buildFileBasenameMap(files);
  const result = matchEntryToFile("no-match", fileMap, files);
  expect(result).toBeNull();
});

test("matchEntryToFile returns exact match when entry name matches basename", () => {
  const files = ["/stash/scripts/deploy/deploy.sh", "/stash/scripts/deploy/util.sh"];
  const fileMap = buildFileBasenameMap(files);
  const result = matchEntryToFile("deploy", fileMap, files);
  expect(result).toBe("/stash/scripts/deploy/deploy.sh");
});

test("matchEntryToFile matches last path segment for hierarchical names", () => {
  const files = ["/stash/scripts/deploy/deploy.sh"];
  const fileMap = buildFileBasenameMap(files);
  const result = matchEntryToFile("corpus/deploy", fileMap, files);
  expect(result).toBe("/stash/scripts/deploy/deploy.sh");
});

test("usage_events are re-linked after full reindex", async () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-relink-"));
  process.env.AKM_STASH_DIR = stashDir;

  // Create a test asset
  const scriptDir = path.join(stashDir, "scripts", "deploy");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, "deploy.sh"), "#!/bin/bash\necho deploy\n");

  // First index to populate entries
  await akmIndex({ stashDir, full: true });

  // Insert a usage event referencing an entry
  const dbPath = getDbPath();
  const db = openDatabase(dbPath);
  const entry = db.prepare("SELECT id, entry_key FROM entries LIMIT 1").get() as { id: number; entry_key: string };
  expect(entry).toBeTruthy();

  // entry_key is "stashDir:type:name", entry_ref is "type:name"
  const parts = entry.entry_key.split(":");
  const entryRef = parts.slice(1).join(":");

  db.prepare(
    "INSERT INTO usage_events (event_type, entry_id, entry_ref, created_at) VALUES (?, ?, ?, datetime('now'))",
  ).run("show", entry.id, entryRef);

  // Verify event exists with entry_id set
  const before = db.prepare("SELECT entry_id, entry_ref FROM usage_events WHERE entry_ref = ?").get(entryRef) as {
    entry_id: number | null;
    entry_ref: string;
  };
  expect(before.entry_id).toBe(entry.id);
  closeDatabase(db);

  // Full reindex — detaches then re-links usage_events
  await akmIndex({ stashDir, full: true });

  // Verify event was re-linked to the new entry_id
  const db2 = openDatabase(dbPath);
  const after = db2.prepare("SELECT entry_id, entry_ref FROM usage_events WHERE entry_ref = ?").get(entryRef) as {
    entry_id: number | null;
    entry_ref: string;
  };
  expect(after.entry_ref).toBe(entryRef);
  expect(after.entry_id).not.toBeNull();
  closeDatabase(db2);

  fs.rmSync(stashDir, { recursive: true, force: true });
});

test("incremental reindex clears embeddings when provider fingerprint changes", async () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-fp-"));
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "auto" });
  embedBatchImpl = async (texts) =>
    texts.map((_text, index) => {
      const embedding = new Float32Array(384);
      embedding[0] = index + 1;
      return embedding;
    });

  const scriptDir = path.join(stashDir, "scripts", "test");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, "test.sh"), "#!/bin/bash\necho test\n");

  // First index — generates embeddings with default local fingerprint
  await akmIndex({ stashDir, full: true });

  const dbPath = getDbPath();
  const db = openDatabase(dbPath);
  const fp1 = getMeta(db, "embeddingFingerprint");
  expect(fp1).toContain("local:");

  // Verify embeddings were generated during first index
  const embeddingsAfterFirst = getEmbeddingCount(db);
  expect(embeddingsAfterFirst).toBeGreaterThan(0);

  const entryCount = db.prepare("SELECT COUNT(*) as c FROM entries").get() as { c: number };
  expect(entryCount.c).toBeGreaterThan(0);
  closeDatabase(db);

  // Change embedding config to a different provider (simulated via env/config change)
  // Re-index with a different embedding fingerprint by passing a config override
  // Since we can't easily change the config mid-test, verify the meta key exists
  // and that a fingerprint change would trigger a purge by checking the code path.
  const db2 = openDatabase(dbPath);
  // Manually set a different fingerprint to simulate a provider change
  db2
    .prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)")
    .run("embeddingFingerprint", "remote:http://localhost:11434/v1/embeddings|nomic-embed-text|768");
  closeDatabase(db2);

  // Run incremental index — should detect fingerprint mismatch and purge old embeddings
  await akmIndex({ stashDir });

  const db3 = openDatabase(dbPath);
  const fp2 = getMeta(db3, "embeddingFingerprint");
  // Fingerprint should be back to local (since we used default config)
  expect(fp2).toContain("local:");
  expect(fp2).not.toBe("remote:http://localhost:11434/v1/embeddings|nomic-embed-text|768");

  // After reindex, embeddings should still exist (purged then regenerated)
  const embeddingsAfterReindex = getEmbeddingCount(db3);
  expect(embeddingsAfterReindex).toBeGreaterThan(0);

  // hasEmbeddings meta should be "1" after reindex
  const hasEmbeddings = getMeta(db3, "hasEmbeddings");
  expect(hasEmbeddings).toBe("1");

  closeDatabase(db3);

  fs.rmSync(stashDir, { recursive: true, force: true });
});
