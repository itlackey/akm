import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { installRegistryRef, validateTarEntries } from "../src/registry-install";
import { parseRegistryRef } from "../src/registry-resolve";
import { agentikitAdd } from "../src/stash-add";
import { agentikitShowUnified as agentikitShow } from "../src/stash-show";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createEmptyStashDir(prefix: string): string {
  const stashDir = makeTempDir(prefix);
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }
  saveConfig({ semanticSearch: false, searchPaths: [] });
  return stashDir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let testConfigDir = "";

beforeEach(() => {
  testConfigDir = makeTempDir("akm-registry-config-");
  process.env.XDG_CONFIG_HOME = testConfigDir;
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

function initGitRepo(repoDir: string): void {
  runGit(["init"], repoDir);
  runGit(["config", "user.name", "AKM Tests"], repoDir);
  runGit(["config", "user.email", "akm@example.test"], repoDir);
  runGit(["config", "commit.gpgsign", "false"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);
}

function withEnv<T>(overrides: Partial<NodeJS.ProcessEnv>, run: () => Promise<T>): Promise<T>;
function withEnv<T>(overrides: Partial<NodeJS.ProcessEnv>, run: () => T): T;
function withEnv<T>(overrides: Partial<NodeJS.ProcessEnv>, run: () => T | Promise<T>): T | Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const restore = () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = run();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function createTarGz(sourceDir: string, archivePath: string): void {
  const result = spawnSync("tar", ["czf", archivePath, "-C", path.dirname(sourceDir), path.basename(sourceDir)], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `tar failed for ${archivePath}`);
  }
}

describe("local directory installs", () => {
  test("agentikitAdd adds a local directory as a stash source", async () => {
    const stashDir = createEmptyStashDir("akm-git-stash-");
    const cacheHome = makeTempDir("akm-git-cache-");
    const repoDir = makeTempDir("akm-git-repo-");
    const kitDir = path.join(repoDir, "kits", "sample");
    writeFile(path.join(kitDir, "scripts", "hello.sh"), "#!/usr/bin/env bash\necho hello\n");
    writeFile(path.join(repoDir, "README.md"), "# Example repo\n");
    initGitRepo(repoDir);

    try {
      const result = await withEnv({ AKM_STASH_DIR: stashDir, XDG_CACHE_HOME: cacheHome }, () =>
        agentikitAdd({ ref: kitDir }),
      );

      // Local adds now create stash sources, not installed entries
      expect(result.stashSource).toBeDefined();
      expect(result.stashSource?.type).toBe("filesystem");
      expect(result.stashSource?.stashRoot).toBe(kitDir);
      expect(result.installed).toBeUndefined();
      expect(fs.existsSync(path.join(result.stashSource?.stashRoot, "scripts", "hello.sh"))).toBe(true);

      const config = loadConfig();
      const stashPaths = (config.stashes ?? []).map((s) => s.path);
      expect(stashPaths).toContain(result.stashSource?.stashRoot);

      const shown = await withEnv({ AKM_STASH_DIR: stashDir, XDG_CACHE_HOME: cacheHome }, () =>
        agentikitShow({ ref: "script:hello.sh" }),
      );
      expect(shown.type).toBe("script");
      expect(shown.path).toContain(result.stashSource?.stashRoot);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
      fs.rmSync(cacheHome, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("agentikitAdd references local directory directly (no include config)", async () => {
    const stashDir = createEmptyStashDir("akm-nogit-stash-");
    const cacheHome = makeTempDir("akm-nogit-cache-");
    const kitDir = makeTempDir("akm-nogit-kit-");
    writeFile(path.join(kitDir, "scripts", "hello.sh"), "#!/usr/bin/env bash\necho hello\n");

    try {
      const result = await withEnv({ AKM_STASH_DIR: stashDir, XDG_CACHE_HOME: cacheHome }, () =>
        agentikitAdd({ ref: kitDir }),
      );

      expect(result.stashSource).toBeDefined();
      expect(result.stashSource?.type).toBe("filesystem");
      // stashRoot points directly at the source, no cache directory
      expect(result.stashSource?.stashRoot).toBe(kitDir);
      expect(fs.existsSync(path.join(result.stashSource?.stashRoot, "scripts", "hello.sh"))).toBe(true);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
      fs.rmSync(cacheHome, { recursive: true, force: true });
      fs.rmSync(kitDir, { recursive: true, force: true });
    }
  });

  test("agentikitAdd discovers stash dirs nested inside a subdirectory", async () => {
    const stashDir = createEmptyStashDir("akm-nested-stash-");
    const cacheHome = makeTempDir("akm-nested-cache-");
    const projectDir = makeTempDir("akm-nested-project-");
    // Assets are nested: project/my-kit/scripts/hello.sh
    writeFile(path.join(projectDir, "my-kit", "scripts", "hello.sh"), "#!/usr/bin/env bash\necho hello\n");
    writeFile(path.join(projectDir, "my-kit", "skills", "review", "SKILL.md"), "---\nname: review\n---\n# Review\n");
    writeFile(path.join(projectDir, "README.md"), "# My project\n");

    try {
      const result = await withEnv({ AKM_STASH_DIR: stashDir, XDG_CACHE_HOME: cacheHome }, () =>
        agentikitAdd({ ref: projectDir }),
      );

      expect(result.stashSource).toBeDefined();
      // stashRoot should point to the nested my-kit dir, not the project root
      expect(result.stashSource?.stashRoot).toBe(path.join(projectDir, "my-kit"));
      expect(fs.existsSync(path.join(result.stashSource?.stashRoot, "scripts", "hello.sh"))).toBe(true);
      expect(fs.existsSync(path.join(result.stashSource?.stashRoot, "skills", "review", "SKILL.md"))).toBe(true);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
      fs.rmSync(cacheHome, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("agentikitAdd indexes type-dir source directly when basename matches type", async () => {
    const stashDir = createEmptyStashDir("akm-typedir-stash-");
    const cacheHome = makeTempDir("akm-typedir-cache-");
    // Create a directory named "knowledge" with nested files
    const parentDir = makeTempDir("akm-typedir-src-");
    const srcDir = path.join(parentDir, "knowledge");
    writeFile(path.join(srcDir, "guide.md"), "# Guide\n");
    writeFile(path.join(srcDir, "policies", "general.md"), "# General\n");
    writeFile(path.join(srcDir, "policies", "security", "main.md"), "# Security\n");

    try {
      const result = await withEnv({ AKM_STASH_DIR: stashDir, XDG_CACHE_HOME: cacheHome }, () =>
        agentikitAdd({ ref: srcDir }),
      );

      expect(result.stashSource).toBeDefined();
      // stashRoot is the source dir itself — indexer detects basename "knowledge" matches a type dir
      expect(result.stashSource?.stashRoot).toBe(srcDir);
      expect(result.index.totalEntries).toBeGreaterThanOrEqual(3);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
      fs.rmSync(cacheHome, { recursive: true, force: true });
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  test("parseRegistryRef resolves bare name to local when directory exists", () => {
    const tempDir = makeTempDir("akm-parse-registry-");
    const previousCwd = process.cwd();
    fs.mkdirSync(path.join(tempDir, "local-kit"));

    try {
      process.chdir(tempDir);
      const parsed = parseRegistryRef("local-kit");
      expect(parsed.source).toBe("local");
      if (parsed.source === "local") {
        expect(parsed.sourcePath).toBe(path.resolve("local-kit"));
      }
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parseRegistryRef falls through to npm when bare name is not a local directory", () => {
    const parsed = parseRegistryRef("nonexistent-kit");
    expect(parsed.source).toBe("npm");
    expect(parsed.id).toBe("npm:nonexistent-kit");
  });

  test("parseRegistryRef resolves '.' as the current directory", () => {
    const tempDir = makeTempDir("akm-parse-dot-");
    const previousCwd = process.cwd();

    try {
      process.chdir(tempDir);
      const parsed = parseRegistryRef(".");
      expect(parsed.source).toBe("local");
      if (parsed.source === "local") {
        expect(parsed.sourcePath).toBe(path.resolve("."));
      }
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parseRegistryRef rejects missing explicit local paths", () => {
    const tempDir = makeTempDir("akm-missing-local-path-");
    const previousCwd = process.cwd();

    try {
      process.chdir(tempDir);
      expect(() => parseRegistryRef("./missing-kit")).toThrow("Local path not found:");
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parseRegistryRef parses git+https:// prefix as git source", () => {
    const parsed = parseRegistryRef("git+https://gitlab.com/org/kit.git");
    expect(parsed.source).toBe("git");
    expect(parsed.id).toBe("git:https://gitlab.com/org/kit");
    if (parsed.source === "git") {
      expect(parsed.url).toBe("https://gitlab.com/org/kit.git");
      expect(parsed.requestedRef).toBeUndefined();
    }
  });

  test("parseRegistryRef parses git+https:// with ref suffix", () => {
    const parsed = parseRegistryRef("git+https://gitlab.com/org/kit#v2.0");
    expect(parsed.source).toBe("git");
    if (parsed.source === "git") {
      expect(parsed.url).toBe("https://gitlab.com/org/kit");
      expect(parsed.requestedRef).toBe("v2.0");
    }
  });

  test("parseRegistryRef parses git+ssh:// as git source", () => {
    const parsed = parseRegistryRef("git+ssh://git@gitlab.com/org/kit.git");
    expect(parsed.source).toBe("git");
    if (parsed.source === "git") {
      expect(parsed.url).toBe("ssh://git@gitlab.com/org/kit.git");
    }
  });

  test("parseRegistryRef routes non-GitHub https URLs to git source", () => {
    const parsed = parseRegistryRef("https://gitlab.com/org/kit.git");
    expect(parsed.source).toBe("git");
  });

  test("parseRegistryRef still routes GitHub https URLs to github source", () => {
    const parsed = parseRegistryRef("https://github.com/owner/repo");
    expect(parsed.source).toBe("github");
  });

  test("parseRegistryRef parses file: prefix as local source", () => {
    const tempDir = makeTempDir("akm-file-uri-");
    try {
      const parsed = parseRegistryRef(`file:${tempDir}`);
      expect(parsed.source).toBe("local");
      if (parsed.source === "local") {
        expect(parsed.sourcePath).toBe(path.resolve(tempDir));
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parseRegistryRef parses file:/// absolute URI as local source", () => {
    const tempDir = makeTempDir("akm-file-abs-uri-");
    try {
      const parsed = parseRegistryRef(`file://${tempDir}`);
      expect(parsed.source).toBe("local");
      if (parsed.source === "local") {
        expect(parsed.sourcePath).toBe(path.resolve(tempDir));
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parseRegistryRef rejects registry search IDs like skills-sh:...", () => {
    expect(() => parseRegistryRef("skills-sh:anthropics/skills/frontend-design")).toThrow(
      "looks like a registry search result ID",
    );
  });

  test("parseRegistryRef rejects static-index registry IDs", () => {
    expect(() => parseRegistryRef("static-index:npm:some-kit")).toThrow("looks like a registry search result ID");
  });

  test("parseRegistryRef still allows npm: prefix", () => {
    const parsed = parseRegistryRef("npm:some-kit");
    expect(parsed.source).toBe("npm");
  });

  test("parseRegistryRef still allows github: prefix", () => {
    const parsed = parseRegistryRef("github:owner/repo");
    expect(parsed.source).toBe("github");
  });

  test("applies include from nearest package.json for nested kit roots", async () => {
    const cacheHome = makeTempDir("akm-nested-include-cache-");
    const packageDir = makeTempDir("akm-nested-include-package-");
    const archivePath = path.join(makeTempDir("akm-nested-archive-"), "kit.tgz");
    const tarRoot = path.join(packageDir, "kit");
    fs.mkdirSync(path.join(tarRoot, "opencode", "scripts"), { recursive: true });
    fs.mkdirSync(path.join(tarRoot, "opencode", "docs"), { recursive: true });
    writeFile(
      path.join(tarRoot, "opencode", "package.json"),
      JSON.stringify(
        {
          name: "nested-kit",
          akm: {
            include: ["scripts"],
          },
        },
        null,
        2,
      ),
    );
    writeFile(path.join(tarRoot, "opencode", "scripts", "kept.sh"), "#!/usr/bin/env bash\necho kept\n");
    writeFile(path.join(tarRoot, "opencode", "docs", "ignored.md"), "# ignored\n");
    createTarGz(tarRoot, archivePath);

    const tarballBytes = fs.readFileSync(archivePath);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://registry.npmjs.org/nested-kit") {
        return new Response(
          JSON.stringify({
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                dist: { tarball: "https://example.test/nested-kit.tgz", shasum: "abc123" },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url === "https://example.test/nested-kit.tgz") {
        return new Response(tarballBytes, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await withEnv({ XDG_CACHE_HOME: cacheHome }, () => installRegistryRef("nested-kit"));
      expect(fs.existsSync(path.join(result.stashRoot, "scripts", "kept.sh"))).toBe(true);
      expect(fs.existsSync(path.join(result.stashRoot, "docs"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(cacheHome, { recursive: true, force: true });
      fs.rmSync(packageDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(archivePath), { recursive: true, force: true });
    }
  });
});

// ── Security: validateTarEntries adversarial cases ───────────────────────────

describe("validateTarEntries", () => {
  test("accepts normal relative entries", () => {
    const output = ["kit-v1.0.0/README.md", "kit-v1.0.0/agents/deploy.md", "kit-v1.0.0/scripts/run.sh"].join("\n");
    expect(() => validateTarEntries(output)).not.toThrow();
  });

  test("rejects entry with absolute path", () => {
    const output = "kit-v1.0.0/README.md\n/etc/passwd";
    expect(() => validateTarEntries(output)).toThrow(/absolute path/);
  });

  test("rejects entry with ../ traversal at root level", () => {
    const output = "kit-v1.0.0/README.md\n../../evil";
    expect(() => validateTarEntries(output)).toThrow(/path traversal/);
  });

  test("rejects entry that escapes after strip-components (a/../../../evil)", () => {
    // After normalization, kit-v1.0.0/../../../evil becomes ../../evil which
    // starts with ".." — caught by the path traversal check before strip.
    const output = "kit-v1.0.0/../../../evil";
    expect(() => validateTarEntries(output)).toThrow(/path traversal|unsafe entry/);
  });

  test("rejects entry that escapes after strip-components (clean first part)", () => {
    // "a/b/../../../../evil" normalizes to "../../evil" which starts with ".."
    // and is caught by the path traversal check (same as other traversal cases).
    const output = "a/b/../../../../evil";
    expect(() => validateTarEntries(output)).toThrow(/path traversal|unsafe entry/);
  });

  test("rejects entry with null byte in name", () => {
    const output = "kit-v1.0.0/README\0.md";
    expect(() => validateTarEntries(output)).toThrow(/invalid entry/);
  });

  test("accepts entries with dots in filenames", () => {
    const output = ["kit-v1.0.0/.env.example", "kit-v1.0.0/v2.1.0/notes.md"].join("\n");
    expect(() => validateTarEntries(output)).not.toThrow();
  });

  test("accepts empty output without throwing", () => {
    expect(() => validateTarEntries("")).not.toThrow();
    expect(() => validateTarEntries("\n\n")).not.toThrow();
  });
});
