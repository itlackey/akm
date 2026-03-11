import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, getAllEntries, getMeta, openDatabase } from "../src/db";
import { agentikitIndex, buildSearchText } from "../src/indexer";
import { getDbPath } from "../src/paths";

let testConfigDir = "";
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

// Each test gets a fresh database and isolated config
beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-idx-config-"));
  process.env.XDG_CONFIG_HOME = testConfigDir;

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
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
});

function tmpStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-idx-"));
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("agentikitIndex scans directories and builds index", async () => {
  const stashDir = tmpStash();
  writeFile(
    path.join(stashDir, "tools", "deploy", "deploy.sh"),
    "#!/usr/bin/env bash\n# Deploy to staging\necho deploy\n",
  );
  writeFile(path.join(stashDir, "tools", "lint", "lint.ts"), "/**\n * Lint source code\n */\nconsole.log('lint')\n");

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitIndex({ stashDir });

  expect(result.totalEntries).toBe(2);
  expect(result.generatedMetadata).toBe(2);
  expect(result.stashDir).toBe(stashDir);

  // Verify entries are in the database (not in .stash.json files)
  const deployStash = path.join(stashDir, "tools", "deploy", ".stash.json");
  expect(fs.existsSync(deployStash)).toBe(false);

  const db = openDatabase();
  const entries = getAllEntries(db);
  expect(entries.length).toBe(2);
  const deployEntry = entries.find((e) => e.entry.name.includes("deploy"));
  expect(deployEntry).toBeDefined();
  expect(deployEntry?.entry.quality).toBe("generated");
  closeDatabase(db);
});

test("agentikitIndex preserves manually-written .stash.json", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "tools", "git", "summarize.ts"), "console.log('x')\n");
  writeFile(
    path.join(stashDir, "tools", "git", ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "git-summarize",
          type: "tool",
          description: "Summarize git changes",
          tags: ["git", "summary"],
          filename: "summarize.ts",
        },
      ],
    }),
  );

  const result = await agentikitIndex({ stashDir });

  expect(result.totalEntries).toBe(1);
  expect(result.generatedMetadata).toBe(0); // no generation needed

  // Verify the manual .stash.json was not overwritten
  const stash = JSON.parse(fs.readFileSync(path.join(stashDir, "tools", "git", ".stash.json"), "utf8"));
  expect(stash.entries[0].name).toBe("git-summarize");
  expect(stash.entries[0].quality).toBeUndefined();
});

test("agentikitIndex migrates generated skill metadata name to canonical directory name", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "skills", "code-review", "SKILL.md"), "# Code Review\n");
  writeFile(
    path.join(stashDir, "skills", "code-review", ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "SKILL",
          type: "skill",
          quality: "generated",
          filename: "SKILL.md",
          description: "legacy generated skill metadata",
        },
      ],
    }),
  );

  const result = await agentikitIndex({ stashDir });
  expect(result.totalEntries).toBe(1);

  // Migration happens in-memory, .stash.json is not rewritten
  // Check the database for the migrated name
  const db = openDatabase();
  const entries = getAllEntries(db);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries[0].entry.name).toBe("code-review");
  closeDatabase(db);
});

test("agentikitIndex writes index to SQLite database", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "tools", "hello", "hello.sh"), "#!/bin/bash\necho hi\n");

  const result = await agentikitIndex({ stashDir });
  expect(fs.existsSync(result.indexPath)).toBe(true);
  expect(result.indexPath).toEndWith(".db");

  const db = openDatabase();
  const version = getMeta(db, "version");
  expect(version).toBe("6");
  const entries = getAllEntries(db);
  expect(entries.length).toBeGreaterThan(0);
  closeDatabase(db);
});

test("agentikitIndex handles empty stash gracefully", async () => {
  const stashDir = tmpStash();
  const result = await agentikitIndex({ stashDir });

  expect(result.totalEntries).toBe(0);
  expect(result.generatedMetadata).toBe(0);
});

test("agentikitIndex handles markdown assets", async () => {
  const stashDir = tmpStash();
  writeFile(
    path.join(stashDir, "commands", "release.md"),
    '---\ndescription: "Release the project"\n---\nRun the release\n',
  );
  writeFile(
    path.join(stashDir, "skills", "refactor", "SKILL.md"),
    '---\ndescription: "Refactor code"\n---\n# Refactor skill\n',
  );

  const result = await agentikitIndex({ stashDir });
  expect(result.totalEntries).toBe(2);
});

test("agentikitIndex generates TOC in database for knowledge entries", async () => {
  const stashDir = tmpStash();
  writeFile(
    path.join(stashDir, "knowledge", "guide.md"),
    '---\ndescription: "A guide"\n---\n# Getting Started\n\nIntro.\n\n## Installation\n\nInstall steps.\n',
  );

  const result = await agentikitIndex({ stashDir });
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
  const deployFile = path.join(stashDir, "tools", "deploy", "deploy.sh");
  writeFile(deployFile, "#!/usr/bin/env bash\necho deploy\n");

  // First index
  const result1 = await agentikitIndex({ stashDir });
  expect(result1.totalEntries).toBe(1);
  expect(result1.mode).toBe("full");

  // Second index (incremental) — nothing changed, so dir should be skipped
  const result2 = await agentikitIndex({ stashDir });
  expect(result2.mode).toBe("incremental");
  expect(result2.directoriesSkipped).toBeGreaterThanOrEqual(1);

  // Now touch the source file to make it newer than the index
  const futureTime = new Date(Date.now() + 2000);
  fs.utimesSync(deployFile, futureTime, futureTime);

  // Third index (incremental) — should detect stale dir
  const result3 = await agentikitIndex({ stashDir });
  expect(result3.mode).toBe("incremental");
  expect(result3.directoriesScanned).toBeGreaterThanOrEqual(1);
});

test("agentikitIndex --full mode returns mode full", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "tools", "hello", "hello.sh"), "#!/bin/bash\necho hi\n");

  // First index to create a previous index
  await agentikitIndex({ stashDir });

  // Second index with full flag — should force full reindex
  const result = await agentikitIndex({ stashDir, full: true });
  expect(result.mode).toBe("full");
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
    type: "tool" as const,
    description: "summarize git changes",
    searchHints: ["explain what changed in a repository", "show commit summary"],
  };

  const text = buildSearchText(entry);
  expect(text).toContain("explain what changed in a repository");
  expect(text).toContain("show commit summary");
});

test("buildSearchText handles entries with both searchHints and intent fields", () => {
  const entry = {
    name: "deploy",
    type: "tool" as const,
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

test("agentikitIndex does not generate heuristic searchHints (LLM-only)", async () => {
  const stashDir = tmpStash();
  writeFile(
    path.join(stashDir, "tools", "deploy", "deploy.sh"),
    "#!/usr/bin/env bash\n# Deploy services to production\necho deploy\n",
  );

  await agentikitIndex({ stashDir });

  // Search hints are only generated when LLM is configured
  const db = openDatabase();
  const entries = getAllEntries(db, "tool");
  expect(entries.length).toBe(1);
  expect(entries[0].entry.searchHints).toBeUndefined();
  closeDatabase(db);
});
