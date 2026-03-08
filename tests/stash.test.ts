import { test, expect, beforeEach, afterEach } from "bun:test"
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
import { saveConfig } from "../src/config"

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

// Isolate each test with its own cache directory so SQLite databases don't leak
const originalXdgCacheHome = process.env.XDG_CACHE_HOME
let testCacheDir = ""

beforeEach(() => {
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-cache-"))
  process.env.XDG_CACHE_HOME = testCacheDir
})

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true })
    testCacheDir = ""
  }
})

test("agentikitSearch only includes tool files with .sh/.ts/.js and returns runCmd", async () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")
  writeFile(path.join(stashDir, "tools", "script.ts"), "console.log('x')\n")
  writeFile(path.join(stashDir, "tools", "README.md"), "ignore\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = await agentikitSearch({ query: "", type: "tool" })

  expect(result.hits.length).toBe(2)
  expect(result.hits.every((hit: SearchHit) => hit.type === "tool")).toBe(true)
  expect(result.hits.some((hit: SearchHit) => hit.name === "README.md")).toBe(false)
  expect(result.hits.some((hit: SearchHit) => typeof hit.runCmd === "string")).toBe(true)
})

test("agentikitSearch creates bun runCmd from nearest package.json up to tools root", async () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  const nestedTool = path.join(stashDir, "tools", "group", "nested", "job.js")
  writeFile(nestedTool, "console.log('job')\n")
  writeFile(path.join(stashDir, "tools", "group", "package.json"), '{"name":"group"}')
  writeFile(path.join(stashDir, "tools", "package.json"), '{"name":"root"}')

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = await agentikitSearch({ query: "job", type: "tool" })

  expect(result.hits.length).toBe(1)
  expect(result.hits[0].runCmd ?? "").toMatch(/^cd ".+\/tools\/group" && bun ".+\/job\.js"$/)
  expect(result.hits[0].kind).toBe("bun")
})

test("agentikitSearch only includes bun install in runCmd when AGENTIKIT_BUN_INSTALL is enabled", async () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  const nestedTool = path.join(stashDir, "tools", "group", "nested", "job.js")
  writeFile(nestedTool, "console.log('job')\n")
  writeFile(path.join(stashDir, "tools", "group", "package.json"), '{"name":"group"}')

  process.env.AGENTIKIT_STASH_DIR = stashDir
  process.env.AGENTIKIT_BUN_INSTALL = "true"
  try {
    const result = await agentikitSearch({ query: "job", type: "tool" })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0].runCmd ?? "").toMatch(/^cd ".+\/tools\/group" && bun install && bun ".+\/job\.js"$/)
    expect(result.hits[0].kind).toBe("bun")
  } finally {
    delete process.env.AGENTIKIT_BUN_INSTALL
  }
})

test("agentikitSearch resolves tool runCmd correctly for additional stash directories", async () => {
  const primaryStashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-primary-"))
  const additionalStashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-additional-"))

  writeFile(path.join(primaryStashDir, "tools", "placeholder.sh"), "#!/usr/bin/env bash\necho primary\n")
  writeFile(path.join(additionalStashDir, "tools", "group", "nested", "job.js"), "console.log('job')\n")
  writeFile(path.join(additionalStashDir, "tools", "group", "package.json"), '{"name":"group"}')

  saveConfig({ semanticSearch: false, additionalStashDirs: [additionalStashDir] }, primaryStashDir)

  process.env.AGENTIKIT_STASH_DIR = primaryStashDir
  await agentikitIndex({ stashDir: primaryStashDir, full: true })

  const result = await agentikitSearch({ query: "job", type: "tool" })
  const additionalHit = result.hits.find((hit) => hit.path.includes(additionalStashDir))

  expect(additionalHit).toBeDefined()
  expect(additionalHit?.runCmd ?? "").toMatch(/^cd ".+agentikit-stash-additional-.+\/tools\/group" && bun ".+\/job\.js"$/)
})

test("agentikitSearch includes explainability reasons for indexed hits", async () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "summarize-diff.ts"), "console.log('summarize')\n")

  saveConfig({ semanticSearch: true, additionalStashDirs: [] }, stashDir)
  process.env.AGENTIKIT_STASH_DIR = stashDir

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
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
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

  saveConfig({ semanticSearch: false, additionalStashDirs: [] }, stashDir)
  process.env.AGENTIKIT_STASH_DIR = stashDir

  await agentikitIndex({ stashDir, full: true })
  const result = await agentikitSearch({ query: "deploy", type: "tool", usage: "both" })

  expect(result.usageGuide?.tool).toBeDefined()
  expect(result.hits[0].usage).toEqual(["Confirm staging health first", "Run with release tag"])
})

test("agentikitSearch usage mode guide omits per-hit usage", async () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
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

  saveConfig({ semanticSearch: false, additionalStashDirs: [] }, stashDir)
  process.env.AGENTIKIT_STASH_DIR = stashDir

  await agentikitIndex({ stashDir, full: true })
  const result = await agentikitSearch({ query: "deploy", type: "tool", usage: "guide" })

  expect(result.usageGuide?.tool).toBeDefined()
  expect(result.hits[0].usage).toBeUndefined()
})

test("agentikitSearch usage mode item omits usage guide", async () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
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

  saveConfig({ semanticSearch: false, additionalStashDirs: [] }, stashDir)
  process.env.AGENTIKIT_STASH_DIR = stashDir

  await agentikitIndex({ stashDir, full: true })
  const result = await agentikitSearch({ query: "deploy", type: "tool", usage: "item" })

  expect(result.usageGuide).toBeUndefined()
  expect(result.hits[0].usage).toEqual(["metadata only"])
})

test("agentikitSearch usage mode none omits guide and per-hit usage", async () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
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

  saveConfig({ semanticSearch: false, additionalStashDirs: [] }, stashDir)
  process.env.AGENTIKIT_STASH_DIR = stashDir

  await agentikitIndex({ stashDir, full: true })
  const result = await agentikitSearch({ query: "deploy", type: "tool", usage: "none" })

  expect(result.usageGuide).toBeUndefined()
  expect(result.hits[0].usage).toBeUndefined()
})

test("agentikitSearch fallback includes usageGuide for guide mode", async () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = await agentikitSearch({ query: "deploy", type: "tool", usage: "guide" })

  expect(result.hits.length).toBe(1)
  expect(result.usageGuide?.tool).toBeDefined()
  expect(result.hits[0].usage).toBeUndefined()
})

test("agentikitShow returns full payloads for skill/command/agent", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "skills", "ops", "SKILL.md"), "# Ops\n")
  writeFile(path.join(stashDir, "commands", "release.md"), '---\ndescription: "Release command"\n---\nrun release\n')
  writeFile(path.join(stashDir, "agents", "coach.md"), '---\ndescription: "Coach"\nmodel: "gpt-5"\n---\nGuide users\n')

  process.env.AGENTIKIT_STASH_DIR = stashDir

  const skill = agentikitShow({ ref: "skill:ops" })
  const command = agentikitShow({ ref: "command:release.md" })
  const agent = agentikitShow({ ref: "agent:coach.md" })

  expect(skill.type).toBe("skill")
  expect(skill.content ?? "").toMatch(/Ops/)
  expect(command.type).toBe("command")
  expect(command.template ?? "").toMatch(/run release/)
  expect(command.description).toBe("Release command")
  expect(agent.type).toBe("agent")
  expect(agent.prompt ?? "").toMatch(/Guide users/)
  expect(agent.modelHint).toBe("gpt-5")
})

test("agentikitShow returns clear error when stash type root is missing", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  try {
    process.env.AGENTIKIT_STASH_DIR = stashDir
    expect(() => agentikitShow({ ref: "agent:missing.md" })).toThrow(
      /Stash type root not found for ref: agent:missing\.md/,
    )
  } finally {
    fs.rmSync(stashDir, { recursive: true, force: true })
  }
})

test("agentikitShow rejects malformed open ref encoding", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  process.env.AGENTIKIT_STASH_DIR = stashDir
  expect(() => agentikitShow({ ref: "tool:%E0%A4%A" })).toThrow(/Invalid open ref encoding/)
})

test("agentikitShow rejects traversal and absolute path refs", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  process.env.AGENTIKIT_STASH_DIR = stashDir

  expect(() => agentikitShow({ ref: "tool:..%2Foutside.sh" })).toThrow(/Invalid open ref name/)
  expect(() => agentikitShow({ ref: "tool:%2Fetc%2Fpasswd" })).toThrow(/Invalid open ref name/)
})

test("agentikitShow blocks symlink escapes outside stash type root", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-outside-"))
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

  process.env.AGENTIKIT_STASH_DIR = stashDir
  expect(() => agentikitShow({ ref: "tool:link.sh" })).toThrow(/Ref resolves outside the stash root/)
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
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = await agentikitSearch({ query: "", type: "knowledge" })

  expect(result.hits.length).toBe(1)
  expect(result.hits[0].type).toBe("knowledge")
  expect(result.hits[0].name).toBe("api-guide.md")
})

test("agentikitShow returns full content for knowledge by default", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitShow({ ref: "knowledge:api-guide.md" })

  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("# Overview")
  expect(result.content).toContain("## Authentication")
})

test("agentikitShow returns TOC for knowledge with view toc", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "toc" } })

  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("# Overview")
  expect(result.content).toContain("## Authentication")
  expect(result.content).toContain("## Endpoints")
  expect(result.content).toContain("lines total")
})

test("agentikitShow extracts section for knowledge", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "section", heading: "Authentication" } })

  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("bearer tokens")
  expect(result.content).not.toContain("Endpoints")
})

test("agentikitShow extracts line range for knowledge", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "lines", start: 5, end: 7 } })

  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("# Overview")
})

test("agentikitShow extracts frontmatter for knowledge", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "frontmatter" } })

  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("title: API Guide")
  expect(result.content).not.toContain("# Overview")
})

test("agentikitShow returns no-frontmatter message when missing", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "knowledge", "plain.md"), "# Just a heading\nSome text.\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitShow({ ref: "knowledge:plain.md", view: { mode: "frontmatter" } })

  expect(result.content).toBe("(no frontmatter)")
})

test("agentikitShow returns helpful message for missing section in knowledge", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC)

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitShow({ ref: "knowledge:api-guide.md", view: { mode: "section", heading: "Nonexistent" } })
  expect(result.type).toBe("knowledge")
  expect(result.content).toContain("Section \"Nonexistent\" not found")
  expect(result.content).toContain("Try --view toc")
})

test("agentikitShow for tool type returns runCmd and kind", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitShow({ ref: "tool:deploy.sh" })

  expect(result.type).toBe("tool")
  expect(result.runCmd).toBeTruthy()
  expect(typeof result.runCmd).toBe("string")
  expect(result.kind).toBe("bash")
})

test("agentikitInit returns created false when stash dir already exists", () => {
  const origHome = process.env.HOME
  const origStashDir = process.env.AGENTIKIT_STASH_DIR
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-home-"))
  // Pre-create the agentikit directory so init finds it existing
  const stashPath = path.join(tmpHome, "agentikit")
  fs.mkdirSync(stashPath, { recursive: true })

  process.env.HOME = tmpHome
  delete process.env.AGENTIKIT_STASH_DIR

  try {
    const result = agentikitInit()
    expect(result.created).toBe(false)
    expect(result.stashDir).toBe(stashPath)
  } finally {
    process.env.HOME = origHome
    if (origStashDir === undefined) delete process.env.AGENTIKIT_STASH_DIR
    else process.env.AGENTIKIT_STASH_DIR = origStashDir
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }
})

test("agentikitShow throws unsupported tool extension for .txt file", () => {
  const origStashDir = process.env.AGENTIKIT_STASH_DIR
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "readme.txt"), "not a tool\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  try {
    expect(() => agentikitShow({ ref: "tool:readme.txt" })).toThrow(
      /Tool ref must resolve to a \.sh/,
    )
  } finally {
    if (origStashDir === undefined) delete process.env.AGENTIKIT_STASH_DIR
    else process.env.AGENTIKIT_STASH_DIR = origStashDir
    fs.rmSync(stashDir, { recursive: true, force: true })
  }
})

test("agentikitInit creates knowledge directory", () => {
  const origHome = process.env.HOME
  const origStashDir = process.env.AGENTIKIT_STASH_DIR
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-home-"))
  process.env.HOME = tmpHome
  delete process.env.AGENTIKIT_STASH_DIR

  try {
    const result = agentikitInit()
    expect(fs.existsSync(path.join(result.stashDir, "knowledge"))).toBe(true)
  } finally {
    process.env.HOME = origHome
    if (origStashDir === undefined) delete process.env.AGENTIKIT_STASH_DIR
    else process.env.AGENTIKIT_STASH_DIR = origStashDir
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }
})
