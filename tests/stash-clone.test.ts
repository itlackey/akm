import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentikitClone } from "../src/stash-clone"
import { saveConfig } from "../src/config"

const originalStashDir = process.env.AKM_STASH_DIR
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalXdgCacheHome = process.env.XDG_CACHE_HOME
let testConfigDir = ""
let testCacheDir = ""
let stashDir = ""
let mountedDir = ""

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function createStashDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
  }
  return dir
}

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-clone-config-"))
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-clone-cache-"))
  stashDir = createStashDir("agentikit-clone-working-")
  mountedDir = createStashDir("agentikit-clone-mounted-")
  process.env.XDG_CONFIG_HOME = testConfigDir
  process.env.XDG_CACHE_HOME = testCacheDir
  process.env.AKM_STASH_DIR = stashDir

  saveConfig({
    semanticSearch: false,
    mountedStashDirs: [mountedDir],
  })
})

afterEach(() => {
  process.env.AKM_STASH_DIR = originalStashDir ?? undefined
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome
  for (const dir of [testConfigDir, testCacheDir, stashDir, mountedDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("agentikitClone", () => {
  test("clones a tool from mounted stash to working stash", async () => {
    writeFile(path.join(mountedDir, "tools", "deploy.sh"), "#!/bin/bash\necho deploy\n")

    const result = await agentikitClone({ sourceRef: "tool:deploy.sh" })

    expect(result.source.sourceKind).toBe("mounted")
    expect(result.destination.ref).toContain("tool:deploy.sh")
    expect(result.overwritten).toBe(false)
    expect(fs.existsSync(path.join(stashDir, "tools", "deploy.sh"))).toBe(true)
    expect(fs.readFileSync(path.join(stashDir, "tools", "deploy.sh"), "utf8")).toBe("#!/bin/bash\necho deploy\n")
  })

  test("clones a skill directory", async () => {
    writeFile(path.join(mountedDir, "skills", "review", "SKILL.md"), "# Review Skill\n")
    writeFile(path.join(mountedDir, "skills", "review", "helper.md"), "# Helper\n")

    const result = await agentikitClone({ sourceRef: "skill:review" })

    expect(result.source.sourceKind).toBe("mounted")
    expect(result.overwritten).toBe(false)
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "helper.md"))).toBe(true)
  })

  test("clones with a new name", async () => {
    writeFile(path.join(mountedDir, "tools", "deploy.sh"), "echo deploy\n")

    const result = await agentikitClone({ sourceRef: "tool:deploy.sh", newName: "my-deploy.sh" })

    expect(fs.existsSync(path.join(stashDir, "tools", "my-deploy.sh"))).toBe(true)
    expect(result.destination.ref).toContain("my-deploy.sh")
  })

  test("throws when asset already exists without --force", async () => {
    writeFile(path.join(mountedDir, "tools", "deploy.sh"), "echo mounted\n")
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "echo existing\n")

    await expect(agentikitClone({ sourceRef: `${mountedDir}//tool:deploy.sh` })).rejects.toThrow("already exists")
  })

  test("overwrites with --force", async () => {
    writeFile(path.join(mountedDir, "tools", "deploy.sh"), "echo updated\n")
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "echo old\n")

    const result = await agentikitClone({ sourceRef: `${mountedDir}//tool:deploy.sh`, force: true })

    expect(result.overwritten).toBe(true)
    expect(fs.readFileSync(path.join(stashDir, "tools", "deploy.sh"), "utf8")).toBe("echo updated\n")
  })

  test("force overwrite removes stale files from skill directory", async () => {
    // Source skill has only SKILL.md
    writeFile(path.join(mountedDir, "skills", "review", "SKILL.md"), "# Updated\n")
    // Existing working skill has an extra file
    writeFile(path.join(stashDir, "skills", "review", "SKILL.md"), "# Old\n")
    writeFile(path.join(stashDir, "skills", "review", "stale.md"), "# Stale\n")

    await agentikitClone({ sourceRef: `${mountedDir}//skill:review`, force: true })

    expect(fs.existsSync(path.join(stashDir, "skills", "review", "SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "stale.md"))).toBe(false)
  })

  test("throws when source asset not found", async () => {
    await expect(agentikitClone({ sourceRef: "tool:nonexistent.sh" })).rejects.toThrow()
  })

  test("clones from working stash to itself with new name", async () => {
    writeFile(path.join(stashDir, "tools", "original.sh"), "echo original\n")

    const result = await agentikitClone({ sourceRef: "tool:original.sh", newName: "copy.sh" })

    expect(result.source.sourceKind).toBe("working")
    expect(fs.existsSync(path.join(stashDir, "tools", "copy.sh"))).toBe(true)
  })

  test("throws when self-cloning a tool without rename", async () => {
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "echo deploy\n")

    await expect(agentikitClone({ sourceRef: "tool:deploy.sh" })).rejects.toThrow("same path")
    // Verify the file was not destroyed
    expect(fs.readFileSync(path.join(stashDir, "tools", "deploy.sh"), "utf8")).toBe("echo deploy\n")
  })

  test("throws when self-cloning a skill without rename", async () => {
    writeFile(path.join(stashDir, "skills", "review", "SKILL.md"), "# Review\n")

    await expect(agentikitClone({ sourceRef: "skill:review" })).rejects.toThrow("same path")
    // Verify the skill was not destroyed
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "SKILL.md"))).toBe(true)
  })
})
