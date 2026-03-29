import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config";
import { buildDbHit } from "../src/local-search";
import type { StashEntry } from "../src/metadata";
import { akmShowUnified as akmShow } from "../src/stash-show";

// Trigger stash-provider self-registration
import "../src/stash-providers/index";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-prog-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeStashJson(dirPath: string, entries: StashEntry[]) {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, ".stash.json"), JSON.stringify({ entries }));
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";
let stashDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-prog-cache-");
  testConfigDir = createTmpDir("akm-prog-config-");
  stashDir = createTmpDir("akm-prog-stash-");
  for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.AKM_STASH_DIR = stashDir;
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
  if (originalStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalStashDir;
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

// ── Test 1: Summary show returns compact output ─────────────────────────────

describe("summary show", () => {
  test("returns name, type, description and omits full content for skills", async () => {
    const longContent = "This is a detailed skill document.\n".repeat(100);
    // Skills use the directory/SKILL.md convention
    writeFile(
      path.join(stashDir, "skills", "code-review", "SKILL.md"),
      `---\ndescription: Reviews code for quality issues\n---\n${longContent}`,
    );
    // Provide .stash.json with tags for the skill
    writeStashJson(path.join(stashDir, "skills", "code-review"), [
      {
        name: "code-review",
        type: "skill",
        description: "Reviews code for quality issues",
        tags: ["code", "review", "quality"],
        filename: "SKILL.md",
      },
    ]);

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "skill:code-review", detail: "summary" });

    expect(result.type).toBe("skill");
    expect(result.name).toBe("code-review");
    expect(result.description).toBe("Reviews code for quality issues");
    expect(result.tags).toEqual(["code", "review", "quality"]);
    // Summary should NOT include the full content
    expect(result.content).toBeUndefined();
    expect(result.template).toBeUndefined();
    expect(result.prompt).toBeUndefined();
  });

  test("returns parameters for command assets in summary mode", async () => {
    writeFile(
      path.join(stashDir, "commands", "release.md"),
      "---\ndescription: Release a new version\n---\nRelease $ARGUMENTS to production with {{env}}.",
    );
    writeStashJson(path.join(stashDir, "commands"), [
      {
        name: "release",
        type: "command",
        description: "Release a new version",
        tags: ["release", "deploy"],
        filename: "release.md",
      },
    ]);

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "command:release", detail: "summary" });

    expect(result.type).toBe("command");
    expect(result.name).toBe("release");
    expect(result.description).toBe("Release a new version");
    expect(result.tags).toEqual(["release", "deploy"]);
    expect(result.parameters).toEqual(["ARGUMENTS", "env"]);
    // No template content in summary
    expect(result.template).toBeUndefined();
    expect(result.content).toBeUndefined();
  });
});

// ── Test 2: Summary output is under 200 tokens ─────────────────────────────

describe("summary token budget", () => {
  test("summary response is under 200 tokens (roughly estimated)", async () => {
    const longContent = "A ".repeat(2000); // 4000+ chars of content
    writeFile(
      path.join(stashDir, "skills", "big-skill", "SKILL.md"),
      `---\ndescription: A moderately described skill for testing\n---\n${longContent}`,
    );

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "skill:big-skill", detail: "summary" });

    // Rough token estimate: JSON.stringify length / 4
    const serialized = JSON.stringify(result);
    const estimatedTokens = serialized.length / 4;
    expect(estimatedTokens).toBeLessThan(200);
  });
});

// ── Test 3: Full show is unchanged ──────────────────────────────────────────

describe("full show unchanged", () => {
  test("show without detail param returns complete content (default behavior)", async () => {
    const content = "# Full Skill\n\nDo all the things in detail.";
    writeFile(path.join(stashDir, "skills", "full-skill", "SKILL.md"), content);

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "skill:full-skill" });

    expect(result.type).toBe("skill");
    expect(result.content).toBe(content);
  });

  test("show with detail=full returns complete content", async () => {
    const content = "# Full Skill\n\nDo all the things in detail.";
    writeFile(path.join(stashDir, "skills", "full-skill", "SKILL.md"), content);

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "skill:full-skill", detail: "full" });

    expect(result.type).toBe("skill");
    expect(result.content).toBe(content);
  });
});

// ── Test 4: estimatedTokens is populated in search hits ─────────────────────

describe("estimatedTokens in search hits", () => {
  test("buildDbHit includes estimatedTokens derived from fileSize", async () => {
    const entry: StashEntry = {
      name: "test-script",
      type: "script",
      description: "A test script",
      tags: ["test"],
      fileSize: 1000,
    };

    const tmpDir = createTmpDir("akm-prog-hit-");
    const filePath = path.join(tmpDir, "scripts", "test-script.sh");
    writeFile(filePath, "#!/bin/bash\necho hello");
    saveConfig({ semanticSearchMode: "off" });

    const hit = await buildDbHit({
      entry,
      path: filePath,
      score: 0.5,
      query: "test",
      rankingMode: "fts",
      defaultStashDir: tmpDir,
      allStashDirs: [tmpDir],
      sources: [{ path: tmpDir }],
      config: { semanticSearchMode: "off" },
    });

    expect(hit.estimatedTokens).toBeDefined();
    expect(typeof hit.estimatedTokens).toBe("number");
  });
});

// ── Test 5: estimatedTokens approximation is reasonable ─────────────────────

describe("estimatedTokens approximation", () => {
  test("a 1000-byte file should have estimatedTokens around 250 (1000/4)", async () => {
    const entry: StashEntry = {
      name: "sized-script",
      type: "script",
      description: "A sized script",
      fileSize: 1000,
    };

    const tmpDir = createTmpDir("akm-prog-tokens-");
    const filePath = path.join(tmpDir, "scripts", "sized-script.sh");
    writeFile(filePath, "x".repeat(1000));
    saveConfig({ semanticSearchMode: "off" });

    const hit = await buildDbHit({
      entry,
      path: filePath,
      score: 0.5,
      query: "sized",
      rankingMode: "fts",
      defaultStashDir: tmpDir,
      allStashDirs: [tmpDir],
      sources: [{ path: tmpDir }],
      config: { semanticSearchMode: "off" },
    });

    expect(hit.estimatedTokens).toBe(250);
  });

  test("estimatedTokens is undefined when fileSize is not set", async () => {
    const entry: StashEntry = {
      name: "no-size",
      type: "script",
      description: "No file size",
    };

    const tmpDir = createTmpDir("akm-prog-nosize-");
    const filePath = path.join(tmpDir, "scripts", "no-size.sh");
    writeFile(filePath, "echo hi");
    saveConfig({ semanticSearchMode: "off" });

    const hit = await buildDbHit({
      entry,
      path: filePath,
      score: 0.5,
      query: "no",
      rankingMode: "fts",
      defaultStashDir: tmpDir,
      allStashDirs: [tmpDir],
      sources: [{ path: tmpDir }],
      config: { semanticSearchMode: "off" },
    });

    expect(hit.estimatedTokens).toBeUndefined();
  });
});

// ── Test 6: Summary show works for different asset types ────────────────────

describe("summary show for different asset types", () => {
  test("skill summary omits content", async () => {
    writeFile(
      path.join(stashDir, "skills", "analyze", "SKILL.md"),
      "---\ndescription: Analyze code patterns\n---\n# Analysis Skill\n\nDetailed instructions here.",
    );
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "skill:analyze", detail: "summary" });
    expect(result.type).toBe("skill");
    expect(result.description).toBe("Analyze code patterns");
    expect(result.content).toBeUndefined();
  });

  test("command summary omits template but keeps parameters", async () => {
    writeFile(
      path.join(stashDir, "commands", "deploy.md"),
      "---\ndescription: Deploy to env\n---\nDeploy $ARGUMENTS to {{env}}.",
    );
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "command:deploy", detail: "summary" });
    expect(result.type).toBe("command");
    expect(result.description).toBe("Deploy to env");
    expect(result.parameters).toBeDefined();
    expect(result.template).toBeUndefined();
  });

  test("agent summary omits prompt", async () => {
    writeFile(
      path.join(stashDir, "agents", "architect.md"),
      "---\ndescription: Architecture advisor\ntools:\n  read: allow\n---\nYou are an architecture advisor. Provide detailed guidance.",
    );
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "agent:architect", detail: "summary" });
    expect(result.type).toBe("agent");
    expect(result.description).toBe("Architecture advisor");
    expect(result.prompt).toBeUndefined();
    expect(result.content).toBeUndefined();
  });

  test("script summary omits content", async () => {
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy");
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "script:deploy.sh", detail: "summary" });
    expect(result.type).toBe("script");
    expect(result.content).toBeUndefined();
    // Summary preserves run (action metadata) but omits content body
    expect(result.run).toBeDefined();
  });

  test("knowledge summary omits content", async () => {
    writeFile(
      path.join(stashDir, "knowledge", "api-guide.md"),
      "---\ndescription: API reference guide\n---\n# API Guide\n\nLots of detailed API documentation here.",
    );
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "knowledge:api-guide", detail: "summary" });
    expect(result.type).toBe("knowledge");
    expect(result.description).toBe("API reference guide");
    expect(result.content).toBeUndefined();
  });
});
