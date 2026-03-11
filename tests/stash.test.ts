import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigPath, saveConfig } from "../src/config";
import { agentikitIndex } from "../src/indexer";
import { agentikitInit } from "../src/init";
import { getBinDir } from "../src/paths";
import { agentikitSearch } from "../src/stash-search";
import { agentikitShow } from "../src/stash-show";
import type { LocalSearchHit, SearchHit } from "../src/stash-types";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-stash-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function isLocalHit(hit: SearchHit): hit is LocalSearchHit {
  return hit.type !== "registry";
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Place a dummy rg binary in stashDir/bin so ensureRg skips download */
function _stubRg(stashDir: string): void {
  const binDir = path.join(stashDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const rgPath = path.join(binDir, "rg");
  fs.writeFileSync(rgPath, "#!/bin/sh\necho 'ripgrep 14.1.1'\n");
  fs.chmodSync(rgPath, 0o755);
}

function stubCachedRg(): void {
  const binDir = getBinDir();
  fs.mkdirSync(binDir, { recursive: true });
  const rgPath = path.join(binDir, "rg");
  fs.writeFileSync(rgPath, "#!/bin/sh\necho 'ripgrep 14.1.1'\n");
  fs.chmodSync(rgPath, 0o755);
}

// Isolate each test with its own cache directory so SQLite databases don't leak
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let testCacheDir = "";
let testConfigDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-stash-cache-");
  testConfigDir = createTmpDir("akm-stash-config-");
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
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
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
});

test("agentikitSearch only includes tool files with .sh/.ts/.js and returns run", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
  writeFile(path.join(stashDir, "tools", "script.ts"), "console.log('x')\n");
  writeFile(path.join(stashDir, "tools", "README.md"), "ignore\n");

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitSearch({ query: "", type: "tool" });
  const localHits = result.hits.filter(isLocalHit);

  expect(localHits.length).toBe(2);
  expect(localHits.every((hit) => hit.type === "script")).toBe(true);
  expect(localHits.some((hit) => hit.name === "README.md")).toBe(false);
  expect(localHits.some((hit) => typeof hit.run === "string")).toBe(true);
});

test("agentikitSearch creates bun run from nearest package.json up to tools root", async () => {
  const stashDir = createTmpDir("akm-stash-");
  const nestedTool = path.join(stashDir, "tools", "group", "nested", "job.js");
  writeFile(nestedTool, "console.log('job')\n");
  writeFile(path.join(stashDir, "tools", "group", "package.json"), '{"name":"group"}');
  writeFile(path.join(stashDir, "tools", "package.json"), '{"name":"root"}');

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitSearch({ query: "job", type: "tool" });
  const hit = result.hits.filter(isLocalHit)[0];

  expect(result.hits.length).toBe(1);
  expect(hit.run).toContain("bun");
  expect(hit.run).toContain("job.js");
});

test("agentikitSearch detects setup from package.json in nearby directory", async () => {
  const stashDir = createTmpDir("akm-stash-");
  const nestedTool = path.join(stashDir, "tools", "group", "nested", "job.js");
  writeFile(nestedTool, "console.log('job')\n");
  writeFile(path.join(stashDir, "tools", "group", "nested", "package.json"), '{"name":"group"}');

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitSearch({ query: "job", type: "tool" });
  const hit = result.hits.filter(isLocalHit)[0];
  expect(result.hits.length).toBe(1);
  // Search hits only expose run, not setup/cwd
  expect(hit.run).toContain("bun");
  expect(hit.run).toContain("job.js");
});

test("agentikitSearch resolves tool run correctly for search path directories", async () => {
  const primaryStashDir = createTmpDir("akm-stash-primary-");
  const searchPathDir = createTmpDir("akm-stash-searchpath-");

  writeFile(path.join(primaryStashDir, "tools", "placeholder.sh"), "#!/usr/bin/env bash\necho primary\n");
  writeFile(path.join(searchPathDir, "tools", "group", "nested", "job.js"), "console.log('job')\n");
  writeFile(path.join(searchPathDir, "tools", "group", "package.json"), '{"name":"group"}');

  saveConfig({ semanticSearch: false, searchPaths: [searchPathDir] });

  process.env.AKM_STASH_DIR = primaryStashDir;
  await agentikitIndex({ stashDir: primaryStashDir, full: true });

  const result = await agentikitSearch({ query: "job", type: "tool" });
  const searchPathHit = result.hits.filter(isLocalHit).find((hit) => hit.path.includes(searchPathDir));

  expect(searchPathHit).toBeDefined();
  expect(searchPathHit?.run ?? "").toContain("bun");
  expect(searchPathHit?.run ?? "").toContain("job.js");
});

test("agentikitSearch includes explainability reasons for indexed hits", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "tools", "summarize-diff.ts"), "console.log('summarize')\n");

  saveConfig({ semanticSearch: true, searchPaths: [] });
  process.env.AKM_STASH_DIR = stashDir;

  await agentikitIndex({ stashDir, full: true });
  const result = await agentikitSearch({ query: "summarize diff", type: "tool" });

  expect(result.hits.length).toBeGreaterThan(0);
  expect(result.hits[0].whyMatched).toBeDefined();
  // Ranking mode depends on whether semantic search (embeddings) is available.
  // Accept either "semantic similarity" or "fts bm25 relevance".
  expect(
    result.hits[0].whyMatched?.includes("fts bm25 relevance") ||
      result.hits[0].whyMatched?.includes("semantic similarity"),
  ).toBe(true);
  expect(result.hits[0].whyMatched).toContain("matched name tokens");
});

test("agentikitSearch includes ref, action, and size for local hits", async () => {
  const stashDir = createTmpDir("akm-stash-");
  const toolPath = path.join(stashDir, "tools", "deploy.sh");
  writeFile(toolPath, "#!/usr/bin/env bash\necho deploy\n");
  writeFile(
    path.join(stashDir, "tools", ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "deploy",
          type: "tool",
          description: "Deploy app",
          filename: "deploy.sh",
        },
      ],
    }),
  );

  saveConfig({ semanticSearch: false, searchPaths: [] });
  process.env.AKM_STASH_DIR = stashDir;

  await agentikitIndex({ stashDir, full: true });
  const result = await agentikitSearch({ query: "deploy", type: "tool" });
  const hit = result.hits.filter(isLocalHit)[0];

  expect(hit.ref).toContain("script:deploy.sh");
  expect(hit.action).toContain("akm show");
  expect(hit.size).toBe("small");
});

test("agentikitSearch includes origin for installed-source hits", async () => {
  const stashDir = createTmpDir("akm-stash-");
  const installedStash = createTmpDir("akm-installed-");
  writeFile(path.join(stashDir, "tools", "placeholder.sh"), "#!/usr/bin/env bash\necho placeholder\n");
  writeFile(path.join(installedStash, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

  saveConfig({
    semanticSearch: false,
    searchPaths: [],
    registry: {
      installed: [
        {
          id: "npm:@scope/deploy-kit",
          source: "npm",
          ref: "@scope/deploy-kit",
          artifactUrl: "https://example.com/deploy-kit.tgz",
          stashRoot: installedStash,
          cacheDir: installedStash,
          installedAt: new Date().toISOString(),
        },
      ],
    },
  });
  process.env.AKM_STASH_DIR = stashDir;

  await agentikitIndex({ stashDir, full: true });
  const result = await agentikitSearch({ query: "deploy", type: "tool" });

  expect(result.hits.filter(isLocalHit).some((hit) => hit.origin === "npm:@scope/deploy-kit")).toBe(true);
});

test("agentikitShow returns full payloads for skill/command/agent", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "skills", "ops", "SKILL.md"), "# Ops\n");
  writeFile(path.join(stashDir, "commands", "release.md"), '---\ndescription: "Release command"\n---\nrun release\n');
  writeFile(path.join(stashDir, "agents", "coach.md"), '---\ndescription: "Coach"\nmodel: "gpt-5"\n---\nGuide users\n');

  process.env.AKM_STASH_DIR = stashDir;

  const skill = await agentikitShow({ ref: "skill:ops" });
  const command = await agentikitShow({ ref: "command:release.md" });
  const agent = await agentikitShow({ ref: "agent:coach.md" });

  expect(skill.type).toBe("skill");
  expect(skill.action).toContain("Read and follow");
  expect(skill.content ?? "").toMatch(/Ops/);
  expect(command.type).toBe("command");
  expect(command.action).toContain("dispatch");
  expect(command.template ?? "").toMatch(/run release/);
  expect(command.description).toBe("Release command");
  expect(agent.type).toBe("agent");
  expect(agent.action).toContain("verbatim");
  expect(agent.prompt ?? "").toMatch(/Guide users/);
  expect(agent.modelHint).toBe("gpt-5");
});

test("agentikitShow returns clear error when stash type root is missing", async () => {
  const stashDir = createTmpDir("akm-stash-");
  try {
    process.env.AKM_STASH_DIR = stashDir;
    await expect(agentikitShow({ ref: "agent:missing.md" })).rejects.toThrow(
      /Stash type root not found for ref: agent:missing\.md/,
    );
  } finally {
    fs.rmSync(stashDir, { recursive: true, force: true });
  }
});

test("agentikitShow rejects invalid asset type in ref", async () => {
  const stashDir = createTmpDir("akm-stash-");
  process.env.AKM_STASH_DIR = stashDir;
  await expect(agentikitShow({ ref: "widget:foo" })).rejects.toThrow(/Invalid asset type/);
});

test("agentikitShow rejects traversal and absolute path refs", async () => {
  const stashDir = createTmpDir("akm-stash-");
  process.env.AKM_STASH_DIR = stashDir;

  await expect(agentikitShow({ ref: "tool:../outside.sh" })).rejects.toThrow(/Path traversal/);
  await expect(agentikitShow({ ref: "tool:/etc/passwd" })).rejects.toThrow(/Absolute path/);
});

test("agentikitShow blocks symlink escapes outside stash type root", async () => {
  const stashDir = createTmpDir("akm-stash-");
  const outsideDir = createTmpDir("akm-outside-");
  const outsideFile = path.join(outsideDir, "outside.sh");
  const symlinkFile = path.join(stashDir, "tools", "link.sh");
  writeFile(outsideFile, "echo outside\n");
  fs.mkdirSync(path.join(stashDir, "tools"), { recursive: true });

  try {
    fs.symlinkSync(outsideFile, symlinkFile);
  } catch {
    // Symlinks not supported in this environment — skip
    return;
  }

  process.env.AKM_STASH_DIR = stashDir;
  await expect(agentikitShow({ ref: "tool:link.sh" })).rejects.toThrow(/Ref resolves outside the stash root/);
});

// ── Knowledge tests ─────────────────────────────────────────────────────────

const KNOWLEDGE_DOC = `---
title: API Guide
description: "API documentation"
---
# Overview

This is the API guide.

## Authentication

Use bearer tokens.

## Endpoints

### GET /users

Returns all users.

### POST /users

Creates a user.
`;

test("agentikitSearch finds knowledge assets", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitSearch({ query: "", type: "knowledge" });

  expect(result.hits.length).toBe(1);
  expect(result.hits[0].type).toBe("knowledge");
  expect(result.hits[0].name).toBe("api-guide");
});

test("agentikitShow returns full content for knowledge by default", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitShow({ ref: "knowledge:api-guide.md" });

  expect(result.type).toBe("knowledge");
  expect(result.content).toContain("# Overview");
  expect(result.content).toContain("## Authentication");
});

test("agentikitShow returns TOC for knowledge with view toc", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "toc" } });

  expect(result.type).toBe("knowledge");
  expect(result.content).toContain("# Overview");
  expect(result.content).toContain("## Authentication");
  expect(result.content).toContain("## Endpoints");
  expect(result.content).toContain("lines total");
});

test("agentikitShow extracts section for knowledge", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitShow({
    ref: "knowledge:api-guide.md",
    view: { mode: "section", heading: "Authentication" },
  });

  expect(result.type).toBe("knowledge");
  expect(result.content).toContain("bearer tokens");
  expect(result.content).not.toContain("Endpoints");
});

test("agentikitShow extracts line range for knowledge", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "lines", start: 5, end: 7 } });

  expect(result.type).toBe("knowledge");
  expect(result.content).toContain("# Overview");
});

test("agentikitShow extracts frontmatter for knowledge", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "frontmatter" } });

  expect(result.type).toBe("knowledge");
  expect(result.content).toContain("title: API Guide");
  expect(result.content).not.toContain("# Overview");
});

test("agentikitShow returns no-frontmatter message when missing", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "knowledge", "plain.md"), "# Just a heading\nSome text.\n");

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitShow({ ref: "knowledge:plain.md", view: { mode: "frontmatter" } });

  expect(result.content).toBe("(no frontmatter)");
});

test("agentikitShow returns helpful message for missing section in knowledge", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitShow({
    ref: "knowledge:api-guide.md",
    view: { mode: "section", heading: "Nonexistent" },
  });
  expect(result.type).toBe("knowledge");
  expect(result.content).toContain('Section "Nonexistent" not found');
  expect(result.content).toContain("akm show");
  expect(result.content).toContain("toc");
  expect(result.content).toContain("discover available headings");
});

test("agentikitShow for tool type returns run", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitShow({ ref: "tool:deploy.sh" });

  expect(result.type).toBe("script");
  expect(result.run).toBeTruthy();
  expect(typeof result.run).toBe("string");
  expect(result.run).toContain("bash");
});

test("agentikitInit returns created false when stash dir already exists", async () => {
  const origHome = process.env.HOME;
  const origStashDir = process.env.AKM_STASH_DIR;
  const tmpHome = createTmpDir("akm-home-");
  // Pre-create the akm directory at the new default location (~/akm)
  const stashPath = path.join(tmpHome, "akm");
  fs.mkdirSync(stashPath, { recursive: true });

  process.env.HOME = tmpHome;
  delete process.env.AKM_STASH_DIR;

  try {
    stubCachedRg();
    const result = await agentikitInit();
    expect(result.created).toBe(false);
    expect(result.stashDir).toBe(stashPath);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origStashDir === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = origStashDir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("agentikitShow throws unsupported tool extension for .txt file", async () => {
  const origStashDir = process.env.AKM_STASH_DIR;
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "tools", "readme.txt"), "not a tool\n");

  process.env.AKM_STASH_DIR = stashDir;
  try {
    await expect(agentikitShow({ ref: "tool:readme.txt" })).rejects.toThrow(
      /Script ref must resolve to a file with a supported script extension/,
    );
  } finally {
    if (origStashDir === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = origStashDir;
    fs.rmSync(stashDir, { recursive: true, force: true });
  }
});

test("agentikitInit creates knowledge directory", async () => {
  const origHome = process.env.HOME;
  const origStashDir = process.env.AKM_STASH_DIR;
  const tmpHome = createTmpDir("akm-home-");
  process.env.HOME = tmpHome;
  delete process.env.AKM_STASH_DIR;

  try {
    stubCachedRg();
    const result = await agentikitInit();
    expect(fs.existsSync(path.join(result.stashDir, "knowledge"))).toBe(true);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origStashDir === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = origStashDir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ── Script tests ────────────────────────────────────────────────────────────

test("agentikitSearch finds script assets with broad extensions", async () => {
  const origStashDir = process.env.AKM_STASH_DIR;
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "scripts", "cleanup.sh"), "#!/usr/bin/env bash\necho cleanup\n");
  writeFile(path.join(stashDir, "scripts", "process.py"), "print('hello')\n");
  writeFile(path.join(stashDir, "scripts", "README.md"), "ignore\n");

  try {
    process.env.AKM_STASH_DIR = stashDir;
    const result = await agentikitSearch({ query: "", type: "script" });

    expect(result.hits.length).toBe(2);
    expect(result.hits.every((hit: SearchHit) => hit.type === "script")).toBe(true);
    expect(result.hits.some((hit: SearchHit) => hit.name === "README.md")).toBe(false);
  } finally {
    if (origStashDir === undefined) {
      delete process.env.AKM_STASH_DIR;
    } else {
      process.env.AKM_STASH_DIR = origStashDir;
    }
    fs.rmSync(stashDir, { recursive: true, force: true });
  }
});

test("agentikitSearch returns run for runnable script extensions", async () => {
  const origStashDir = process.env.AKM_STASH_DIR;
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

  try {
    process.env.AKM_STASH_DIR = stashDir;
    const result = await agentikitSearch({ query: "", type: "script" });
    const hit = result.hits.filter(isLocalHit)[0];

    expect(result.hits.length).toBe(1);
    expect(hit.run).toBeTruthy();
    expect(hit.run).toContain("bash");
  } finally {
    if (origStashDir === undefined) {
      delete process.env.AKM_STASH_DIR;
    } else {
      process.env.AKM_STASH_DIR = origStashDir;
    }
    fs.rmSync(stashDir, { recursive: true, force: true });
  }
});

test("agentikitShow returns run for python script (auto-detected interpreter)", async () => {
  const origStashDir = process.env.AKM_STASH_DIR;
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "scripts", "process.py"), "# A python script\nprint('hello')\n");

  try {
    process.env.AKM_STASH_DIR = stashDir;
    const result = await agentikitShow({ ref: "script:process.py" });

    expect(result.type).toBe("script");
    expect(result.run).toBeDefined();
    expect(result.run).toContain("python");
  } finally {
    if (origStashDir === undefined) {
      delete process.env.AKM_STASH_DIR;
    } else {
      process.env.AKM_STASH_DIR = origStashDir;
    }
    fs.rmSync(stashDir, { recursive: true, force: true });
  }
});

test("agentikitShow returns run for runnable script", async () => {
  const stashDir = createTmpDir("akm-stash-");
  writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

  process.env.AKM_STASH_DIR = stashDir;
  const result = await agentikitShow({ ref: "script:deploy.sh" });

  expect(result.type).toBe("script");
  expect(result.run).toBeTruthy();
  expect(result.run).toContain("bash");
});

test("agentikitInit writes config outside the stash directory", async () => {
  const origHome = process.env.HOME;
  const origStashDir = process.env.AKM_STASH_DIR;
  const tmpHome = createTmpDir("akm-home-");
  process.env.HOME = tmpHome;
  delete process.env.AKM_STASH_DIR;

  try {
    stubCachedRg();
    const result = await agentikitInit();
    expect(result.configPath).toBe(getConfigPath());
    expect(result.configPath.startsWith(result.stashDir)).toBe(false);
    expect(fs.existsSync(result.configPath)).toBe(true);
    expect(fs.existsSync(path.join(result.stashDir, "config.json"))).toBe(false);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origStashDir === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = origStashDir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
