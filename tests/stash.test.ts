import { test, expect, beforeEach, afterEach, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  agentikitSearch,
  agentikitShow,
  agentikitInit,
  type SearchHit,
} from "../src/stash"
import { agentikitIndex } from "../src/indexer"
import { getConfigPath, saveConfig } from "../src/config"

const createdTmpDirs: string[] = []

function createTmpDir(prefix = "agentikit-stash-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdTmpDirs.push(dir)
  return dir
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** Place a dummy rg binary in stashDir/bin so ensureRg skips download */
function stubRg(stashDir: string): void {
  const binDir = path.join(stashDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  const rgPath = path.join(binDir, "rg")
  fs.writeFileSync(rgPath, "#!/bin/sh\necho 'ripgrep 14.1.1'\n")
  fs.chmodSync(rgPath, 0o755)
}

// Isolate each test with its own cache directory so SQLite databases don't leak
const originalXdgCacheHome = process.env.XDG_CACHE_HOME
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
let testCacheDir = ""
let testConfigDir = ""

beforeEach(() => {
  testCacheDir = createTmpDir("agentikit-stash-cache-")
  testConfigDir = createTmpDir("agentikit-stash-config-")
  process.env.XDG_CACHE_HOME = testCacheDir
  process.env.XDG_CONFIG_HOME = testConfigDir
})

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true })
    testCacheDir = ""
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true })
    testConfigDir = ""
  }
})

test("agentikitSearch only includes tool files with .sh/.ts/.js and returns runCmd", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")
  writeFile(path.join(stashDir, "tools", "script.ts"), "console.log('x')\n")
  writeFile(path.join(stashDir, "tools", "README.md"), "ignore\n")

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitSearch({ query: "", type: "tool" })

  expect(result.hits.length).toBe(2)
  expect(result.hits.every((hit: SearchHit) => hit.type === "tool")).toBe(true)
  expect(result.hits.some((hit: SearchHit) => hit.name === "README.md")).toBe(false)
  expect(result.hits.some((hit: SearchHit) => typeof hit.runCmd === "string")).toBe(true)
})

test("agentikitSearch creates bun runCmd from nearest package.json up to tools root", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  const nestedTool = path.join(stashDir, "tools", "group", "nested", "job.js")
  writeFile(nestedTool, "console.log('job')\n")
  writeFile(path.join(stashDir, "tools", "group", "package.json"), '{"name":"group"}')
  writeFile(path.join(stashDir, "tools", "package.json"), '{"name":"root"}')

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitSearch({ query: "job", type: "tool" })

  expect(result.hits.length).toBe(1)
  expect(result.hits[0].runCmd ?? "").toMatch(/^cd ".+\/tools\/group" && bun ".+\/job\.js"$/)
  expect(result.hits[0].kind).toBe("bun")
})

test("agentikitSearch only includes bun install in runCmd when AKM_BUN_INSTALL is enabled", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  const nestedTool = path.join(stashDir, "tools", "group", "nested", "job.js")
  writeFile(nestedTool, "console.log('job')\n")
  writeFile(path.join(stashDir, "tools", "group", "package.json"), '{"name":"group"}')

  process.env.AKM_STASH_DIR = stashDir
  process.env.AKM_BUN_INSTALL = "true"
  try {
    const result = await agentikitSearch({ query: "job", type: "tool" })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0].runCmd ?? "").toMatch(/^cd ".+\/tools\/group" && bun install && bun ".+\/job\.js"$/)
    expect(result.hits[0].kind).toBe("bun")
  } finally {
    delete process.env.AKM_BUN_INSTALL
  }
})

test("agentikitSearch resolves tool runCmd correctly for mounted stash directories", async () => {
  const primaryStashDir = createTmpDir("agentikit-stash-primary-")
  const mountedStashDir = createTmpDir("agentikit-stash-mounted-")

  writeFile(path.join(primaryStashDir, "tools", "placeholder.sh"), "#!/usr/bin/env bash\necho primary\n")
  writeFile(path.join(mountedStashDir, "tools", "group", "nested", "job.js"), "console.log('job')\n")
  writeFile(path.join(mountedStashDir, "tools", "group", "package.json"), '{"name":"group"}')

  saveConfig({ semanticSearch: false, mountedStashDirs: [mountedStashDir] })

  process.env.AKM_STASH_DIR = primaryStashDir
  await agentikitIndex({ stashDir: primaryStashDir, full: true })

  const result = await agentikitSearch({ query: "job", type: "tool" })
  const mountedHit = result.hits.find((hit) => hit.path.includes(mountedStashDir))

  expect(mountedHit).toBeDefined()
  expect(mountedHit?.runCmd ?? "").toMatch(/^cd ".+agentikit-stash-mounted-.+\/tools\/group" && bun ".+\/job\.js"$/)
})

test("agentikitSearch includes explainability reasons for indexed hits", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "tools", "summarize-diff.ts"), "console.log('summarize')\n")

  saveConfig({ semanticSearch: true, mountedStashDirs: [] })
  process.env.AKM_STASH_DIR = stashDir

  await agentikitIndex({ stashDir, full: true })
  const result = await agentikitSearch({ query: "summarize diff", type: "tool" })

  expect(result.hits.length).toBeGreaterThan(0)
  expect(result.hits[0].whyMatched).toBeDefined()
  // Ranking mode depends on whether semantic search (embeddings) is available.
  // Accept either "semantic similarity" or "fts bm25 relevance".
  expect(
    result.hits[0].whyMatched!.includes("fts bm25 relevance")
    || result.hits[0].whyMatched!.includes("semantic similarity"),
  ).toBe(true)
  expect(result.hits[0].whyMatched).toContain("matched name tokens")
})

test("agentikitSearch usage mode both includes guide and per-hit metadata usage", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  const toolPath = path.join(stashDir, "tools", "deploy.sh")
  writeFile(toolPath, "#!/usr/bin/env bash\necho deploy\n")
  writeFile(path.join(stashDir, "tools", ".stash.json"), JSON.stringify({
    entries: [
      {
        name: "deploy",
        type: "tool",
        description: "Deploy app",
        usage: ["Confirm staging health first", "Run with release tag"],
        entry: "deploy.sh",
      },
    ],
  }))

  saveConfig({ semanticSearch: false, mountedStashDirs: [] })
  process.env.AKM_STASH_DIR = stashDir

  await agentikitIndex({ stashDir, full: true })
  const result = await agentikitSearch({ query: "deploy", type: "tool", usage: "both" })

  expect(result.usageGuide?.tool).toBeDefined()
  expect(result.hits[0].usage).toEqual(["Confirm staging health first", "Run with release tag"])
})

test("agentikitSearch usage mode guide omits per-hit usage", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")
  writeFile(path.join(stashDir, "tools", ".stash.json"), JSON.stringify({
    entries: [
      {
        name: "deploy",
        type: "tool",
        usage: ["metadata only"],
        entry: "deploy.sh",
      },
    ],
  }))

  saveConfig({ semanticSearch: false, mountedStashDirs: [] })
  process.env.AKM_STASH_DIR = stashDir

  await agentikitIndex({ stashDir, full: true })
  const result = await agentikitSearch({ query: "deploy", type: "tool", usage: "guide" })

  expect(result.usageGuide?.tool).toBeDefined()
  expect(result.hits[0].usage).toBeUndefined()
})

test("agentikitSearch usage mode item omits usage guide", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")
  writeFile(path.join(stashDir, "tools", ".stash.json"), JSON.stringify({
    entries: [
      {
        name: "deploy",
        type: "tool",
        usage: ["metadata only"],
        entry: "deploy.sh",
      },
    ],
  }))

  saveConfig({ semanticSearch: false, mountedStashDirs: [] })
  process.env.AKM_STASH_DIR = stashDir

  await agentikitIndex({ stashDir, full: true })
  const result = await agentikitSearch({ query: "deploy", type: "tool", usage: "item" })

  expect(result.usageGuide).toBeUndefined()
  expect(result.hits[0].usage).toEqual(["metadata only"])
})

test("agentikitSearch usage mode none omits guide and per-hit usage", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")
  writeFile(path.join(stashDir, "tools", ".stash.json"), JSON.stringify({
    entries: [
      {
        name: "deploy",
        type: "tool",
        usage: ["metadata only"],
        entry: "deploy.sh",
      },
    ],
  }))

  saveConfig({ semanticSearch: false, mountedStashDirs: [] })
  process.env.AKM_STASH_DIR = stashDir

  await agentikitIndex({ stashDir, full: true })
  const result = await agentikitSearch({ query: "deploy", type: "tool", usage: "none" })

  expect(result.usageGuide).toBeUndefined()
  expect(result.hits[0].usage).toBeUndefined()
})

test("agentikitSearch fallback includes usageGuide for guide mode", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitSearch({ query: "deploy", type: "tool", usage: "guide" })

  expect(result.hits.length).toBe(1)
  expect(result.usageGuide?.tool).toBeDefined()
  expect(result.hits[0].usage).toBeUndefined()
})

test("agentikitShow returns full payloads for skill/command/agent", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "skills", "ops", "SKILL.md"), "# Ops\n")
  writeFile(path.join(stashDir, "commands", "release.md"), '---\ndescription: "Release command"\n---\nrun release\n')
  writeFile(path.join(stashDir, "agents", "coach.md"), '---\ndescription: "Coach"\nmodel: "gpt-5"\n---\nGuide users\n')

  process.env.AKM_STASH_DIR = stashDir

  const skill = await agentikitShow({ ref: "skill:ops" })
  const command = await agentikitShow({ ref: "command:release.md" })
  const agent = await agentikitShow({ ref: "agent:coach.md" })

  expect(skill.type).toBe("skill")
  expect(skill.content ?? "").toMatch(/Ops/)
  expect(command.type).toBe("command")
  expect(command.template ?? "").toMatch(/run release/)
  expect(command.description).toBe("Release command")
  expect(agent.type).toBe("agent")
  expect(agent.prompt ?? "").toMatch(/Guide users/)
  expect(agent.modelHint).toBe("gpt-5")
})

test("agentikitShow returns clear error when stash type root is missing", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  try {
    process.env.AKM_STASH_DIR = stashDir
    await expect(agentikitShow({ ref: "agent:missing.md" })).rejects.toThrow(
      /Stash type root not found for ref: agent:missing\.md/,
    )
  } finally {
    fs.rmSync(stashDir, { recursive: true, force: true })
  }
})

test("agentikitShow rejects invalid asset type in ref", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  process.env.AKM_STASH_DIR = stashDir
  await expect(agentikitShow({ ref: "widget:foo" })).rejects.toThrow(/Invalid asset type/)
})

test("agentikitShow rejects traversal and absolute path refs", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  process.env.AKM_STASH_DIR = stashDir

  await expect(agentikitShow({ ref: "tool:../outside.sh" })).rejects.toThrow(/Path traversal/)
  await expect(agentikitShow({ ref: "tool:/etc/passwd" })).rejects.toThrow(/Absolute path/)
})

test("agentikitShow blocks symlink escapes outside stash type root", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  const outsideDir = createTmpDir("agentikit-outside-")
  const outsideFile = path.join(outsideDir, "outside.sh")
  const symlinkFile = path.join(stashDir, "tools", "link.sh")
  writeFile(outsideFile, "echo outside\n")
  fs.mkdirSync(path.join(stashDir, "tools"), { recursive: true })

  try {
    fs.symlinkSync(outsideFile, symlinkFile)
  } catch {
    // Symlinks not supported in this environment — skip
    return
  }

  process.env.AKM_STASH_DIR = stashDir
  await expect(agentikitShow({ ref: "tool:link.sh" })).rejects.toThrow(/Ref resolves outside the stash root/)
})

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
`

test("agentikitSearch finds knowledge assets", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitSearch({ query: "", type: "knowledge" })

  expect(result.hits.length).toBe(1)
  expect(result.hits[0].type).toBe("knowledge")
  expect(result.hits[0].name).toBe("api-guide.md")
})

test("agentikitShow returns full content for knowledge by default", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitShow({ ref: "knowledge:api-guide.md" })

  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("# Overview")
  expect(result.content).toContain("## Authentication")
})

test("agentikitShow returns TOC for knowledge with view toc", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "toc" } })

  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("# Overview")
  expect(result.content).toContain("## Authentication")
  expect(result.content).toContain("## Endpoints")
  expect(result.content).toContain("lines total")
})

test("agentikitShow extracts section for knowledge", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "section", heading: "Authentication" } })

  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("bearer tokens")
  expect(result.content).not.toContain("Endpoints")
})

test("agentikitShow extracts line range for knowledge", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "lines", start: 5, end: 7 } })

  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("# Overview")
})

test("agentikitShow extracts frontmatter for knowledge", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "frontmatter" } })

  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("title: API Guide")
  expect(result.content).not.toContain("# Overview")
})

test("agentikitShow returns no-frontmatter message when missing", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "knowledge", "plain.md"), "# Just a heading\nSome text.\n")

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitShow({ ref: "knowledge:plain.md", view: { mode: "frontmatter" } })

  expect(result.content).toBe("(no frontmatter)")
})

test("agentikitShow returns helpful message for missing section in knowledge", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "section", heading: "Nonexistent" } })
  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("Section \"Nonexistent\" not found")
  expect(result.content).toContain("Try --view toc")
})

test("agentikitShow for tool type returns runCmd and kind", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitShow({ ref: "tool:deploy.sh" })

  expect(result.type).toBe("script")
  expect(result.runCmd).toBeTruthy()
  expect(typeof result.runCmd).toBe("string")
  expect(result.kind).toBe("bash")
})

test("agentikitInit returns created false when stash dir already exists", async () => {
  const origHome = process.env.HOME
  const origStashDir = process.env.AKM_STASH_DIR
  const tmpHome = createTmpDir("agentikit-home-")
  // Pre-create the agentikit directory at the new default location (~/agentikit)
  const stashPath = path.join(tmpHome, "agentikit")
  fs.mkdirSync(stashPath, { recursive: true })

  process.env.HOME = tmpHome
  delete process.env.AKM_STASH_DIR

  try {
    const result = await agentikitInit()
    expect(result.created).toBe(false)
    expect(result.stashDir).toBe(stashPath)
  } finally {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    if (origStashDir === undefined) delete process.env.AKM_STASH_DIR
    else process.env.AKM_STASH_DIR = origStashDir
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }
})

test("agentikitShow throws unsupported tool extension for .txt file", async () => {
  const origStashDir = process.env.AKM_STASH_DIR
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "tools", "readme.txt"), "not a tool\n")

  process.env.AKM_STASH_DIR = stashDir
  try {
    await expect(agentikitShow({ ref: "tool:readme.txt" })).rejects.toThrow(
      /Tool ref must resolve to a \.sh/,
    )
  } finally {
    if (origStashDir === undefined) delete process.env.AKM_STASH_DIR
    else process.env.AKM_STASH_DIR = origStashDir
    fs.rmSync(stashDir, { recursive: true, force: true })
  }
})

test("agentikitInit creates knowledge directory", async () => {
  const origHome = process.env.HOME
  const origStashDir = process.env.AKM_STASH_DIR
  const tmpHome = createTmpDir("agentikit-home-")
  process.env.HOME = tmpHome
  delete process.env.AKM_STASH_DIR

  try {
    const result = await agentikitInit()
    expect(fs.existsSync(path.join(result.stashDir, "knowledge"))).toBe(true)
  } finally {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    if (origStashDir === undefined) delete process.env.AKM_STASH_DIR
    else process.env.AKM_STASH_DIR = origStashDir
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }
})

// ── Script tests ────────────────────────────────────────────────────────────

test("agentikitSearch finds script assets with broad extensions", async () => {
  const origStashDir = process.env.AKM_STASH_DIR
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "scripts", "cleanup.sh"), "#!/usr/bin/env bash\necho cleanup\n")
  writeFile(path.join(stashDir, "scripts", "process.py"), "print('hello')\n")
  writeFile(path.join(stashDir, "scripts", "README.md"), "ignore\n")

  try {
    process.env.AKM_STASH_DIR = stashDir
    const result = await agentikitSearch({ query: "", type: "script" })

    expect(result.hits.length).toBe(2)
    expect(result.hits.every((hit: SearchHit) => hit.type === "script")).toBe(true)
    expect(result.hits.some((hit: SearchHit) => hit.name === "README.md")).toBe(false)
  } finally {
    if (origStashDir === undefined) {
      delete process.env.AKM_STASH_DIR
    } else {
      process.env.AKM_STASH_DIR = origStashDir
    }
    fs.rmSync(stashDir, { recursive: true, force: true })
  }
})

test("agentikitSearch returns runCmd for runnable script extensions", async () => {
  const origStashDir = process.env.AKM_STASH_DIR
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")

  try {
    process.env.AKM_STASH_DIR = stashDir
    const result = await agentikitSearch({ query: "", type: "script" })

    expect(result.hits.length).toBe(1)
    expect(result.hits[0].runCmd).toBeTruthy()
    expect(result.hits[0].kind).toBe("bash")
  } finally {
    if (origStashDir === undefined) {
      delete process.env.AKM_STASH_DIR
    } else {
      process.env.AKM_STASH_DIR = origStashDir
    }
    fs.rmSync(stashDir, { recursive: true, force: true })
  }
})

test("agentikitShow returns content for non-runnable script extensions", async () => {
  const origStashDir = process.env.AKM_STASH_DIR
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "scripts", "process.py"), "# A python script\nprint('hello')\n")

  try {
    process.env.AKM_STASH_DIR = stashDir
    const result = await agentikitShow({ ref: "script:process.py" })

    expect(result.type).toBe("script")
    expect(result.content).toContain("print('hello')")
  } finally {
    if (origStashDir === undefined) {
      delete process.env.AKM_STASH_DIR
    } else {
      process.env.AKM_STASH_DIR = origStashDir
    }
    fs.rmSync(stashDir, { recursive: true, force: true })
  }
})

test("agentikitShow returns runCmd for runnable script", async () => {
  const stashDir = createTmpDir("agentikit-stash-")
  writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")

  process.env.AKM_STASH_DIR = stashDir
  const result = await agentikitShow({ ref: "script:deploy.sh" })

  expect(result.type).toBe("script")
  expect(result.runCmd).toBeTruthy()
  expect(result.kind).toBe("bash")
})

test("agentikitInit writes config outside the stash directory", async () => {
  const origHome = process.env.HOME
  const origStashDir = process.env.AKM_STASH_DIR
  const tmpHome = createTmpDir("agentikit-home-")
  process.env.HOME = tmpHome
  delete process.env.AKM_STASH_DIR

  try {
    const result = await agentikitInit()
    expect(result.configPath).toBe(getConfigPath())
    expect(result.configPath.startsWith(result.stashDir)).toBe(false)
    expect(fs.existsSync(result.configPath)).toBe(true)
    expect(fs.existsSync(path.join(result.stashDir, "config.json"))).toBe(false)
  } finally {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    if (origStashDir === undefined) delete process.env.AKM_STASH_DIR
    else process.env.AKM_STASH_DIR = origStashDir
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }
})
