import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, saveConfig } from "../src/config"
import { installRegistryRef } from "../src/registry-install"
import { parseRegistryRef } from "../src/registry-resolve"
import { agentikitAdd, agentikitShow } from "../src/stash"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function createEmptyStashDir(prefix: string): string {
  const stashDir = makeTempDir(prefix)
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true })
  }
  saveConfig({ semanticSearch: false, mountedStashDirs: [] })
  return stashDir
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`)
  }
  return result.stdout.trim()
}

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
let testConfigDir = ""

beforeEach(() => {
  testConfigDir = makeTempDir("agentikit-registry-config-")
  process.env.XDG_CONFIG_HOME = testConfigDir
})

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true })
    testConfigDir = ""
  }
})

function initGitRepo(repoDir: string): void {
  runGit(["init"], repoDir)
  runGit(["config", "user.name", "Agentikit Tests"], repoDir)
  runGit(["config", "user.email", "agentikit@example.test"], repoDir)
  runGit(["config", "commit.gpgsign", "false"], repoDir)
  runGit(["add", "."], repoDir)
  runGit(["commit", "-m", "initial"], repoDir)
}

function withEnv<T>(overrides: Partial<NodeJS.ProcessEnv>, run: () => Promise<T>): Promise<T>
function withEnv<T>(overrides: Partial<NodeJS.ProcessEnv>, run: () => T): T
function withEnv<T>(overrides: Partial<NodeJS.ProcessEnv>, run: () => T | Promise<T>): T | Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  const restore = () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }

  try {
    const result = run()
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(restore)
    }
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

function createTarGz(sourceDir: string, archivePath: string): void {
  const result = spawnSync("tar", ["czf", archivePath, "-C", path.dirname(sourceDir), path.basename(sourceDir)], {
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `tar failed for ${archivePath}`)
  }
}

describe("local directory installs", () => {
  test("agentikitAdd installs a subdirectory inside a git repository", async () => {
    const stashDir = createEmptyStashDir("agentikit-git-stash-")
    const cacheHome = makeTempDir("agentikit-git-cache-")
    const repoDir = makeTempDir("agentikit-git-repo-")
    const kitDir = path.join(repoDir, "kits", "sample")
    writeFile(path.join(kitDir, "tools", "hello.sh"), "#!/usr/bin/env bash\necho hello\n")
    writeFile(path.join(repoDir, "README.md"), "# Example repo\n")
    initGitRepo(repoDir)

    try {
      const result = await withEnv(
        { AKM_STASH_DIR: stashDir, XDG_CACHE_HOME: cacheHome },
        () => agentikitAdd({ ref: kitDir }),
      )

      expect(result.installed.source).toBe("local")
      expect(fs.existsSync(path.join(result.installed.stashRoot, "tools", "hello.sh"))).toBe(true)
      expect(fs.existsSync(path.join(result.installed.extractedDir, ".git"))).toBe(false)

      const config = loadConfig()
      const installedRoots = (config.registry?.installed ?? []).map((e: { stashRoot: string }) => e.stashRoot)
      expect(installedRoots).toContain(result.installed.stashRoot)

      const shown = await withEnv(
        { AKM_STASH_DIR: stashDir, XDG_CACHE_HOME: cacheHome },
        () => agentikitShow({ ref: "tool:hello.sh" }),
      )
      expect(shown.type).toBe("tool")
      expect(shown.path).toContain(result.installed.stashRoot)
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true })
      fs.rmSync(cacheHome, { recursive: true, force: true })
      fs.rmSync(repoDir, { recursive: true, force: true })
    }
  })

  test("agentikitAdd honors package.json agentikit.include during install", async () => {
    const stashDir = createEmptyStashDir("agentikit-include-stash-")
    const cacheHome = makeTempDir("agentikit-include-cache-")
    const repoDir = makeTempDir("agentikit-include-repo-")
    writeFile(
      path.join(repoDir, "package.json"),
      JSON.stringify({
        name: "include-kit",
        agentikit: {
          include: ["tools", "README.md"],
        },
      }, null, 2),
    )
    writeFile(path.join(repoDir, "tools", "kept.sh"), "#!/usr/bin/env bash\necho kept\n")
    writeFile(path.join(repoDir, "docs", "ignored.md"), "# ignored\n")
    writeFile(path.join(repoDir, "README.md"), "# Included\n")
    initGitRepo(repoDir)

    try {
      const result = await withEnv(
        { AKM_STASH_DIR: stashDir, XDG_CACHE_HOME: cacheHome },
        () => agentikitAdd({ ref: repoDir }),
      )

      expect(result.installed.source).toBe("local")
      expect(fs.existsSync(path.join(result.installed.stashRoot, "tools", "kept.sh"))).toBe(true)
      expect(fs.existsSync(path.join(result.installed.stashRoot, "README.md"))).toBe(true)
      expect(fs.existsSync(path.join(result.installed.stashRoot, "docs"))).toBe(false)
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true })
      fs.rmSync(cacheHome, { recursive: true, force: true })
      fs.rmSync(repoDir, { recursive: true, force: true })
    }
  })

  test("agentikitAdd installs a plain directory without git", async () => {
    const stashDir = createEmptyStashDir("agentikit-nogit-stash-")
    const cacheHome = makeTempDir("agentikit-nogit-cache-")
    const kitDir = makeTempDir("agentikit-nogit-kit-")
    writeFile(path.join(kitDir, "tools", "hello.sh"), "#!/usr/bin/env bash\necho hello\n")

    try {
      const result = await withEnv(
        { AKM_STASH_DIR: stashDir, XDG_CACHE_HOME: cacheHome },
        () => agentikitAdd({ ref: kitDir }),
      )

      expect(result.installed.source).toBe("local")
      expect(fs.existsSync(path.join(result.installed.stashRoot, "tools", "hello.sh"))).toBe(true)
      expect(fs.existsSync(path.join(result.installed.extractedDir, ".git"))).toBe(false)
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true })
      fs.rmSync(cacheHome, { recursive: true, force: true })
      fs.rmSync(kitDir, { recursive: true, force: true })
    }
  })

  test("parseRegistryRef ignores non-path-like local directory names", () => {
    const tempDir = makeTempDir("agentikit-parse-registry-")
    const previousCwd = process.cwd()
    fs.mkdirSync(path.join(tempDir, "local-kit"))

    try {
      process.chdir(tempDir)
      const parsed = parseRegistryRef("local-kit")
      expect(parsed.source).toBe("npm")
      expect(parsed.id).toBe("npm:local-kit")
    } finally {
      process.chdir(previousCwd)
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("parseRegistryRef rejects missing explicit local paths", () => {
    const tempDir = makeTempDir("agentikit-missing-local-path-")
    const previousCwd = process.cwd()

    try {
      process.chdir(tempDir)
      expect(() => parseRegistryRef("./missing-kit")).toThrow("Local path not found:")
    } finally {
      process.chdir(previousCwd)
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("parseRegistryRef parses git: prefix as git source", () => {
    const parsed = parseRegistryRef("git:https://gitlab.com/org/kit.git")
    expect(parsed.source).toBe("git")
    expect(parsed.id).toBe("git:https://gitlab.com/org/kit")
    if (parsed.source === "git") {
      expect(parsed.url).toBe("https://gitlab.com/org/kit.git")
      expect(parsed.requestedRef).toBeUndefined()
    }
  })

  test("parseRegistryRef parses git: prefix with ref suffix", () => {
    const parsed = parseRegistryRef("git:https://gitlab.com/org/kit#v2.0")
    expect(parsed.source).toBe("git")
    if (parsed.source === "git") {
      expect(parsed.url).toBe("https://gitlab.com/org/kit")
      expect(parsed.requestedRef).toBe("v2.0")
    }
  })

  test("parseRegistryRef routes non-GitHub https URLs to git source", () => {
    const parsed = parseRegistryRef("https://gitlab.com/org/kit.git")
    expect(parsed.source).toBe("git")
  })

  test("parseRegistryRef still routes GitHub https URLs to github source", () => {
    const parsed = parseRegistryRef("https://github.com/owner/repo")
    expect(parsed.source).toBe("github")
  })

  test("applies include from nearest package.json for nested kit roots", async () => {
    const cacheHome = makeTempDir("agentikit-nested-include-cache-")
    const packageDir = makeTempDir("agentikit-nested-include-package-")
    const archivePath = path.join(makeTempDir("agentikit-nested-archive-"), "kit.tgz")
    const tarRoot = path.join(packageDir, "kit")
    fs.mkdirSync(path.join(tarRoot, "opencode", "tools"), { recursive: true })
    fs.mkdirSync(path.join(tarRoot, "opencode", "docs"), { recursive: true })
    writeFile(
      path.join(tarRoot, "opencode", "package.json"),
      JSON.stringify({
        name: "nested-kit",
        agentikit: {
          include: ["tools"],
        },
      }, null, 2),
    )
    writeFile(path.join(tarRoot, "opencode", "tools", "kept.sh"), "#!/usr/bin/env bash\necho kept\n")
    writeFile(path.join(tarRoot, "opencode", "docs", "ignored.md"), "# ignored\n")
    createTarGz(tarRoot, archivePath)

    const tarballBytes = fs.readFileSync(archivePath)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://registry.npmjs.org/nested-kit") {
        return new Response(JSON.stringify({
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              dist: { tarball: "https://example.test/nested-kit.tgz", shasum: "abc123" },
            },
          },
        }), { status: 200 })
      }
      if (url === "https://example.test/nested-kit.tgz") {
        return new Response(tarballBytes, { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    try {
      const result = await withEnv(
        { XDG_CACHE_HOME: cacheHome },
        () => installRegistryRef("nested-kit"),
      )
      expect(fs.existsSync(path.join(result.stashRoot, "tools", "kept.sh"))).toBe(true)
      expect(fs.existsSync(path.join(result.stashRoot, "docs"))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      fs.rmSync(cacheHome, { recursive: true, force: true })
      fs.rmSync(packageDir, { recursive: true, force: true })
      fs.rmSync(path.dirname(archivePath), { recursive: true, force: true })
    }
  })
})
