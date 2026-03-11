import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRgAvailable, resolveRg } from "../src/ripgrep";

const createdTmpDirs: string[] = [];

function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined || value === null) {
    throw new Error("Expected value to be defined");
  }
  return value;
}

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-rg-"));
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

// ── resolveRg ───────────────────────────────────────────────────────────────

test("resolveRg finds system ripgrep on PATH", () => {
  const originalPath = process.env.PATH;
  const stashDir = tmpDir();
  const binDir = path.join(stashDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  // Create a fake rg binary on PATH so the test does not depend on the host environment
  const rgName = process.platform === "win32" ? "rg.cmd" : "rg";
  const fakeRg = path.join(binDir, rgName);
  const scriptContent = process.platform === "win32" ? "@echo off\r\necho fake rg\r\n" : "#!/bin/sh\necho fake rg\n";
  fs.writeFileSync(fakeRg, scriptContent);
  try {
    // Make sure the fake rg is executable where that concept applies
    if (process.platform !== "win32") {
      fs.chmodSync(fakeRg, 0o755);
    }
  } catch {
    // Ignore chmod errors on platforms/filesystems that do not support it
  }

  // Prepend the fake rg directory to PATH for this test only
  process.env.PATH = binDir + path.delimiter + (originalPath ?? "");
  try {
    const rg = resolveRg();
    expect(expectDefined(rg)).toContain("rg");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("resolveRg finds rg in provided bin directory", () => {
  const binDir = tmpDir();

  // Create a fake rg binary
  const fakeRg = path.join(binDir, "rg");
  fs.writeFileSync(fakeRg, "#!/bin/sh\necho fake rg\n");
  fs.chmodSync(fakeRg, 0o755);

  const rg = resolveRg(binDir);
  expect(rg).toBe(fakeRg);
});

test("resolveRg skips non-executable files in bin dir", () => {
  const binDir = tmpDir();

  // Create a non-executable rg file
  const fakeRg = path.join(binDir, "rg");
  fs.writeFileSync(fakeRg, "not executable");
  fs.chmodSync(fakeRg, 0o644);

  const rg = resolveRg(binDir);
  // Should fall through to system PATH
  expect(rg).not.toBe(fakeRg);
});

// ── isRgAvailable ───────────────────────────────────────────────────────────

test("isRgAvailable returns true when rg is on PATH", () => {
  const originalPath = process.env.PATH;
  const stashDir = tmpDir();
  const binDir = path.join(stashDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const rgName = process.platform === "win32" ? "rg.cmd" : "rg";
  const fakeRg = path.join(binDir, rgName);
  const scriptContent = process.platform === "win32" ? "@echo off\r\necho fake rg\r\n" : "#!/bin/sh\necho fake rg\n";
  fs.writeFileSync(fakeRg, scriptContent);
  if (process.platform !== "win32") {
    fs.chmodSync(fakeRg, 0o755);
  }

  process.env.PATH = binDir + path.delimiter + (originalPath ?? "");
  try {
    expect(isRgAvailable()).toBe(true);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ── Integration: indexed search pipeline ────────────────────────────────────

test("search pipeline returns ranked results when index exists", async () => {
  const stashDir = tmpDir();
  for (const sub of ["tools", "skills", "commands", "agents"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }

  // Create tools with .stash.json metadata
  writeFile(path.join(stashDir, "tools", "docker", "build.sh"), "#!/bin/bash\necho build\n");
  writeFile(
    path.join(stashDir, "tools", "docker", ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "docker-build",
          type: "tool",
          description: "build docker images",
          tags: ["docker", "container"],
          filename: "build.sh",
        },
      ],
    }),
  );
  writeFile(path.join(stashDir, "tools", "git", "diff.sh"), "#!/bin/bash\necho diff\n");
  writeFile(
    path.join(stashDir, "tools", "git", ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "git-diff",
          type: "tool",
          description: "summarize git changes",
          tags: ["git", "diff"],
          filename: "diff.sh",
        },
      ],
    }),
  );

  // Isolation: ensure index cache and config are written to temp directories
  const oldXdgCacheHome = process.env.XDG_CACHE_HOME;
  const oldXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const oldAkmStashDir = process.env.AKM_STASH_DIR;
  const tempCacheDir = tmpDir();
  const tempConfigDir = tmpDir();
  process.env.XDG_CACHE_HOME = tempCacheDir;
  process.env.XDG_CONFIG_HOME = tempConfigDir;

  try {
    // Build index
    process.env.AKM_STASH_DIR = stashDir;
    const { agentikitIndex } = await import("../src/indexer");
    await agentikitIndex({ stashDir });

    // Search — TF-IDF should rank docker-related results first
    const { agentikitSearch } = await import("../src/stash-search");
    const result = await agentikitSearch({ query: "docker", type: "any" });

    expect(result.hits.length).toBeGreaterThan(0);
    // Docker-related result should be ranked first
    expect(result.hits[0].name).toContain("docker");
  } finally {
    if (oldXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldXdgCacheHome;
    if (oldXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdgConfigHome;
    if (oldAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = oldAkmStashDir;
  }
});
