import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, saveConfig } from "../src/config"
import { agentikitAdd, agentikitShow } from "../src/stash"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function createEmptyStashDir(prefix: string): string {
  const stashDir = makeTempDir(prefix)
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true })
  }
  saveConfig({ semanticSearch: false, additionalStashDirs: [] }, stashDir)
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

function initGitRepo(repoDir: string): void {
  runGit(["init"], repoDir)
  runGit(["config", "user.name", "Agentikit Tests"], repoDir)
  runGit(["config", "user.email", "agentikit@example.test"], repoDir)
  runGit(["add", "."], repoDir)
  runGit(["commit", "-m", "initial"], repoDir)
}

describe("local git installs", () => {
  test("agentikitAdd installs a subdirectory inside a git repository", async () => {
    const stashDir = createEmptyStashDir("agentikit-git-stash-")
    const cacheHome = makeTempDir("agentikit-git-cache-")
    const repoDir = makeTempDir("agentikit-git-repo-")
    const kitDir = path.join(repoDir, "kits", "sample")
    writeFile(path.join(kitDir, "tools", "hello.sh"), "#!/usr/bin/env bash\necho hello\n")
    writeFile(path.join(repoDir, "README.md"), "# Example repo\n")
    initGitRepo(repoDir)

    process.env.AGENTIKIT_STASH_DIR = stashDir
    process.env.XDG_CACHE_HOME = cacheHome

    try {
      const result = await agentikitAdd({ ref: kitDir })

      expect(result.installed.source).toBe("git")
      expect(fs.existsSync(path.join(result.installed.stashRoot, "tools", "hello.sh"))).toBe(true)
      expect(fs.existsSync(path.join(result.installed.extractedDir, ".git"))).toBe(false)

      const config = loadConfig(stashDir)
      expect(config.additionalStashDirs).toContain(result.installed.stashRoot)

      const shown = agentikitShow({ ref: "tool:hello.sh" })
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

    process.env.AGENTIKIT_STASH_DIR = stashDir
    process.env.XDG_CACHE_HOME = cacheHome

    try {
      const result = await agentikitAdd({ ref: repoDir })

      expect(result.installed.source).toBe("git")
      expect(fs.existsSync(path.join(result.installed.stashRoot, "tools", "kept.sh"))).toBe(true)
      expect(fs.existsSync(path.join(result.installed.stashRoot, "README.md"))).toBe(true)
      expect(fs.existsSync(path.join(result.installed.stashRoot, "docs"))).toBe(false)
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true })
      fs.rmSync(cacheHome, { recursive: true, force: true })
      fs.rmSync(repoDir, { recursive: true, force: true })
    }
  })
})
