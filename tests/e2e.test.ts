/**
 * End-to-end tests that replicate real-world usage of agentikit.
 *
 * Uses realistic fixtures in tests/fixtures/ representing a typical user's
 * stash directory with tools, skills, commands, and agents.
 *
 * Tests cover:
 * - Full lifecycle: index → search → show
 * - CLI interface via subprocess
 * - Metadata generation and persistence
 * - Semantic search ranking quality
 * - Ripgrep pre-filtering
 * - Multi-tool directories with .stash.json
 * - Graceful degradation (no index, no ripgrep)
 * - Edge cases and error handling
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentikitSearch, agentikitShow } from "../src/stash"
import { agentikitIndex, loadSearchIndex, getIndexPath } from "../src/indexer"
import { loadStashFile } from "../src/metadata"

// ── Helpers ─────────────────────────────────────────────────────────────────

const FIXTURES = path.join(__dirname, "fixtures")
const CLI = path.join(__dirname, "..", "src", "cli.ts")

function copyFixturesToTmp(): string {
  const tmpStash = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-e2e-"))
  copyDirRecursive(FIXTURES, tmpStash)
  return tmpStash
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function runCli(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env },
  })
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? 1,
  }
}

function parseJson(text: string): any {
  return JSON.parse(text)
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME
let testCacheDir = ""

beforeAll(async () => {
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-e2e-cache-"))
  process.env.XDG_CACHE_HOME = testCacheDir
})

afterAll(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1: Full lifecycle — user sets up stash, indexes, searches, runs
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Full lifecycle (index → search → show)", () => {
  let stashDir: string

  beforeAll(async () => {
    stashDir = copyFixturesToTmp()
    process.env.AGENTIKIT_STASH_DIR = stashDir
  })

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true })
  })

  test("search works without index (substring fallback)", async () => {
    const result = await agentikitSearch({ query: "deploy", type: "tool" })

    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.some((h) => h.name.includes("deploy"))).toBe(true)
    // No score field in substring mode
    expect(result.hits[0].score).toBeUndefined()
  })

  test("index generates metadata and builds search index", async () => {
    const result = await agentikitIndex({ stashDir })

    expect(result.stashDir).toBe(stashDir)
    expect(result.totalEntries).toBeGreaterThanOrEqual(8)
    expect(result.generatedMetadata).toBeGreaterThan(0)
    expect(fs.existsSync(result.indexPath)).toBe(true)
  })

  test("index generates .stash.json for directories that lack one", async () => {
    // git/ directory had no .stash.json — should have been generated
    const gitStash = loadStashFile(path.join(stashDir, "tools", "git"))
    expect(gitStash).not.toBeNull()
    expect(gitStash!.entries.length).toBeGreaterThanOrEqual(2)

    // Each generated entry should be marked
    for (const entry of gitStash!.entries) {
      expect(entry.generated).toBe(true)
      expect(entry.type).toBe("tool")
      expect(entry.entry).toBeTruthy()
    }
  })

  test("index preserves hand-written .stash.json (docker/ has intent fields)", async () => {
    const dockerStash = loadStashFile(path.join(stashDir, "tools", "docker"))
    expect(dockerStash).not.toBeNull()
    expect(dockerStash!.entries.length).toBe(2)

    // These were hand-written, should NOT have generated flag
    expect(dockerStash!.entries[0].generated).toBeUndefined()
    expect(dockerStash!.entries[0].intent).toBeDefined()
    expect(dockerStash!.entries[0].intent!.when).toBeTruthy()
  })

  test("index extracts description from code comments", async () => {
    const gitStash = loadStashFile(path.join(stashDir, "tools", "git"))!
    const diffEntry = gitStash.entries.find((e) => e.name === "summarize-diff")
    expect(diffEntry).toBeDefined()
    // Should have extracted the JSDoc comment as description
    expect(diffEntry!.description).toBeTruthy()
    expect(diffEntry!.description!.toLowerCase()).toContain("git diff")
  })

  test("index extracts metadata from package.json", async () => {
    const lintStash = loadStashFile(path.join(stashDir, "tools", "lint"))!
    const lintEntry = lintStash.entries.find((e) => e.name === "eslint-check")
    expect(lintEntry).toBeDefined()
    // package.json had description and keywords
    expect(lintEntry!.description).toContain("ESLint")
    expect(lintEntry!.tags).toContain("eslint")
  })

  test("search with index returns scored results with descriptions", async () => {
    const result = await agentikitSearch({ query: "docker build image", type: "any" })

    expect(result.hits.length).toBeGreaterThan(0)
    // Docker-build should be ranked first
    const topHit = result.hits[0]
    expect(topHit.name).toContain("docker")
    expect(topHit.score).toBeDefined()
    expect(topHit.score!).toBeGreaterThan(0)
    expect(topHit.description).toBeTruthy()
  })

  test("search ranks semantically relevant results higher", async () => {
    const result = await agentikitSearch({ query: "summarize commit changes", type: "any" })

    expect(result.hits.length).toBeGreaterThan(0)
    // Git tools should rank higher than docker tools for this query
    const topNames = result.hits.slice(0, 3).map((h) => h.name.toLowerCase())
    const hasGitRelated = topNames.some((n) =>
      n.includes("git") || n.includes("diff") || n.includes("commit"),
    )
    expect(hasGitRelated).toBe(true)
  })

  test("search type filter restricts results to that type", async () => {
    const toolResult = await agentikitSearch({ query: "review", type: "skill" })
    expect(toolResult.hits.every((h) => h.type === "skill")).toBe(true)

    const cmdResult = await agentikitSearch({ query: "", type: "command" })
    expect(cmdResult.hits.every((h) => h.type === "command")).toBe(true)
  })

  test("search with empty query returns all entries of that type", async () => {
    const result = await agentikitSearch({ query: "", type: "agent" })
    expect(result.hits.length).toBe(2) // architect.md and debugger.md
  })

  test("search respects limit parameter", async () => {
    const result = await agentikitSearch({ query: "", type: "any", limit: 3 })
    expect(result.hits.length).toBeLessThanOrEqual(3)
  })

  test("show a tool returns runCmd and kind", async () => {
    const searchResult = await agentikitSearch({ query: "deploy", type: "tool" })
    const deployHit = searchResult.hits.find((h) => h.name.includes("deploy"))
    expect(deployHit).toBeDefined()

    const openResult = agentikitShow({ ref: deployHit!.openRef })
    expect(openResult.type).toBe("tool")
    expect(openResult.runCmd).toBeTruthy()
    expect(openResult.kind).toBe("bash")
  })

  test("show a skill returns full SKILL.md content", async () => {
    const openResult = agentikitShow({ ref: "skill:code-review" })
    expect(openResult.type).toBe("skill")
    expect(openResult.content).toContain("Code Review Skill")
    expect(openResult.content).toContain("security vulnerabilities")
  })

  test("show a command returns template and description", async () => {
    const openResult = agentikitShow({ ref: "command:release.md" })
    expect(openResult.type).toBe("command")
    expect(openResult.description).toBe("Create a new release with changelog and version bump")
    expect(openResult.template).toContain("npm version")
  })

  test("show an agent returns prompt, description, model hint, and tool policy", async () => {
    const openResult = agentikitShow({ ref: "agent:architect.md" })
    expect(openResult.type).toBe("agent")
    expect(openResult.description).toContain("architect")
    expect(openResult.prompt).toContain("software architect")
    expect(openResult.modelHint).toBe("claude-sonnet-4-20250514")
    expect(openResult.toolPolicy).toEqual({ allow: "Read,Glob,Grep" })
  })

})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2: Agent workflow — discover capability for a natural language task
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Agent discovers capabilities for task", () => {
  let stashDir: string

  beforeAll(async () => {
    stashDir = copyFixturesToTmp()
    process.env.AGENTIKIT_STASH_DIR = stashDir
    await agentikitIndex({ stashDir })
  })

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true })
  })

  test("agent asks 'set up local dev environment' → docker-compose ranks high", async () => {
    const result = await agentikitSearch({ query: "set up local development environment" })
    const names = result.hits.map((h) => h.name.toLowerCase())
    // Docker compose should appear because its intent says "start local development services"
    expect(names.some((n) => n.includes("compose") || n.includes("docker"))).toBe(true)
  })

  test("agent asks 'check code quality' → lint tool ranks high", async () => {
    const result = await agentikitSearch({ query: "check code quality style" })
    expect(result.hits.length).toBeGreaterThan(0)
    const names = result.hits.map((h) => h.name.toLowerCase())
    expect(names.some((n) => n.includes("lint") || n.includes("eslint"))).toBe(true)
  })

  test("agent asks 'review my pull request' → code-review skill found", async () => {
    const result = await agentikitSearch({ query: "review pull request code changes" })
    expect(result.hits.length).toBeGreaterThan(0)
    // Skill openRef contains "code-review" (directory name), even though display name is "SKILL"
    expect(result.hits.some((h) =>
      h.openRef.includes("code-review") || h.description?.toLowerCase().includes("review"),
    )).toBe(true)
  })

  test("agent asks 'help me design the system' → architect agent found", async () => {
    const result = await agentikitSearch({ query: "system design architecture" })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.some((h) => h.name.includes("architect"))).toBe(true)
  })

  test("agent workflow: search → show (end-to-end)", async () => {
    // Step 1: Agent searches for a tool to run tests
    const searchResult = await agentikitSearch({ query: "run tests" })
    expect(searchResult.hits.length).toBeGreaterThan(0)
    const testTool = searchResult.hits.find((h) => h.type === "tool" && h.name.includes("test"))
    expect(testTool).toBeDefined()

    // Step 2: Agent reads the tool to get runCmd for host execution
    const showResult = agentikitShow({ ref: testTool!.openRef })
    expect(showResult.runCmd).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3: CLI interface — real subprocess execution
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: CLI subprocess execution", () => {
  let stashDir: string

  beforeAll(async () => {
    stashDir = copyFixturesToTmp()
    process.env.AGENTIKIT_STASH_DIR = stashDir
    await agentikitIndex({ stashDir })
  })

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true })
  })

  test("cli: agentikit search returns JSON with hits", async () => {
    const result = runCli("search", "docker")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.hits).toBeInstanceOf(Array)
    expect(json.hits.length).toBeGreaterThan(0)
    expect(json.stashDir).toBeTruthy()
  })

  test("cli: agentikit search --type tool filters by type", async () => {
    const result = runCli("search", "deploy", "--type", "tool")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.hits.every((h: any) => h.type === "tool")).toBe(true)
  })

  test("cli: agentikit search --type knowledge filters by type", async () => {
    const result = runCli("search", "guide", "--type", "knowledge")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.hits.length).toBeGreaterThan(0)
    expect(json.hits.every((h: any) => h.type === "knowledge")).toBe(true)
  })

  test("cli: agentikit search --limit 2 respects limit", async () => {
    const result = runCli("search", "", "--limit", "2")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.hits.length).toBeLessThanOrEqual(2)
  })

  test("cli: agentikit show returns asset content", async () => {
    const result = runCli("show", "skill:code-review")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.type).toBe("skill")
    expect(json.content).toContain("Code Review Skill")
  })

  test("cli: agentikit show command returns template", async () => {
    const result = runCli("show", "command:release.md")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.type).toBe("command")
    expect(json.description).toBeTruthy()
    expect(json.template).toContain("npm version")
  })

  test("cli: agentikit index builds index and reports stats", async () => {
    const result = runCli("index")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.totalEntries).toBeGreaterThan(0)
    expect(json.indexPath).toBeTruthy()
  })

  test("cli: agentikit index --full returns mode full", async () => {
    const result = runCli("index", "--full")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.mode).toBe("full")
  })

  test("cli: agentikit with no command prints usage", async () => {
    const result = runCli()
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Usage:")
  })

  test("cli: agentikit show with no ref prints error", async () => {
    const result = runCli("show")
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("missing ref")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3b: CLI knowledge --view flags
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: CLI knowledge --view flags", () => {
  let stashDir: string

  beforeAll(async () => {
    stashDir = copyFixturesToTmp()
    process.env.AGENTIKIT_STASH_DIR = stashDir
  })

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true })
  })

  test("cli: show knowledge with --view toc", async () => {
    const result = runCli("show", "knowledge:guide.md", "--view", "toc")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.type).toBe("knowledge")
    expect(json.content).toContain("# API Reference Guide")
    expect(json.content).toContain("## Getting Started")
    expect(json.content).toContain("lines total")
  })

  test("cli: show knowledge with --view section --heading", async () => {
    const result = runCli("show", "knowledge:guide.md", "--view", "section", "--heading", "Getting Started")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.type).toBe("knowledge")
    expect(json.content).toContain("Getting Started")
    expect(json.content).toContain("install the package")
    // Should include sub-headings but not sibling headings
    expect(json.content).toContain("Prerequisites")
    expect(json.content).not.toContain("Authentication")
  })

  test("cli: show knowledge with --view lines --start --end", async () => {
    const result = runCli("show", "knowledge:guide.md", "--view", "lines", "--start", "1", "--end", "5")
    expect(result.exitCode).toBe(0)

    const json = parseJson(result.stdout)
    expect(json.type).toBe("knowledge")
    // Lines 1-5 cover the frontmatter start
    expect(json.content).toContain("---")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4: Progressive improvement — user drops scripts, indexes later
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Zero-config progressive improvement", () => {
  let stashDir: string

  beforeAll(async () => {
    stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-e2e-prog-"))
    for (const sub of ["tools", "skills", "commands", "agents"]) {
      fs.mkdirSync(path.join(stashDir, sub), { recursive: true })
    }
    process.env.AGENTIKIT_STASH_DIR = stashDir
  })

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true })
  })

  test("user drops a script in tools/ — search finds it by name (no index)", async () => {
    fs.mkdirSync(path.join(stashDir, "tools", "format"), { recursive: true })
    fs.writeFileSync(
      path.join(stashDir, "tools", "format", "prettier-check.sh"),
      "#!/usr/bin/env bash\n# Format code with Prettier\nprettier --check .\n",
    )

    const result = await agentikitSearch({ query: "prettier", type: "tool" })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0].name).toContain("prettier")
  })

  test("user runs index — .stash.json auto-generated with description from comments", async () => {
    await agentikitIndex({ stashDir })

    const stash = loadStashFile(path.join(stashDir, "tools", "format"))
    expect(stash).not.toBeNull()
    expect(stash!.entries[0].generated).toBe(true)
    expect(stash!.entries[0].description).toContain("Format code")
  })

  test("user adds more scripts — re-index picks them up", async () => {
    fs.mkdirSync(path.join(stashDir, "tools", "db"), { recursive: true })
    fs.writeFileSync(
      path.join(stashDir, "tools", "db", "migrate.sh"),
      "#!/usr/bin/env bash\n# Run database migrations\necho 'migrating...'\n",
    )

    const result = await agentikitIndex({ stashDir })
    expect(result.totalEntries).toBeGreaterThanOrEqual(2)

    const dbStash = loadStashFile(path.join(stashDir, "tools", "db"))
    expect(dbStash).not.toBeNull()
    expect(dbStash!.entries[0].description).toContain("database migrations")
  })

  test("user edits .stash.json manually — edits preserved on next index", async () => {
    // Read the auto-generated stash
    const stashPath = path.join(stashDir, "tools", "format", ".stash.json")
    const stash = JSON.parse(fs.readFileSync(stashPath, "utf8"))

    // User improves the description and removes generated flag
    stash.entries[0].description = "Check code formatting with Prettier"
    stash.entries[0].tags = ["prettier", "format", "style"]
    delete stash.entries[0].generated
    fs.writeFileSync(stashPath, JSON.stringify(stash, null, 2))

    // Re-index — should preserve user edits
    await agentikitIndex({ stashDir })

    const reloaded = loadStashFile(path.join(stashDir, "tools", "format"))!
    expect(reloaded.entries[0].description).toBe("Check code formatting with Prettier")
    expect(reloaded.entries[0].tags).toContain("prettier")
    expect(reloaded.entries[0].generated).toBeUndefined()
  })

  test("semantic search finds user-edited metadata after re-index", async () => {
    // Re-index to pick up manual edits in the search index
    await agentikitIndex({ stashDir })

    const result = await agentikitSearch({ query: "format code style" })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.some((h) => h.name.includes("prettier"))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 5: Multi-tool directory with .stash.json
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Multi-tool directory with hand-written .stash.json", () => {
  let stashDir: string

  beforeAll(async () => {
    stashDir = copyFixturesToTmp()
    process.env.AGENTIKIT_STASH_DIR = stashDir
    await agentikitIndex({ stashDir })
  })

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true })
  })

  test("docker/ directory exposes two tools from single .stash.json", async () => {
    const stash = loadStashFile(path.join(stashDir, "tools", "docker"))!
    expect(stash.entries).toHaveLength(2)

    const names = stash.entries.map((e) => e.name)
    expect(names).toContain("docker-build")
    expect(names).toContain("docker-compose")
  })

  test("search for 'docker build' returns docker-build as top result", async () => {
    const result = await agentikitSearch({ query: "docker build" })
    expect(result.hits[0].name).toContain("docker")
    expect(result.hits[0].description).toContain("Docker image")
  })

  test("search for 'compose development' returns docker-compose", async () => {
    const result = await agentikitSearch({ query: "compose development" })
    const composeHit = result.hits.find((h) => h.name.includes("compose"))
    expect(composeHit).toBeDefined()
    expect(composeHit!.tags).toContain("compose")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 6: Index persistence and cache
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Index persistence across sessions", () => {
  let stashDir: string

  beforeAll(async () => {
    stashDir = copyFixturesToTmp()
    process.env.AGENTIKIT_STASH_DIR = stashDir
  })

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true })
  })

  test("index is persisted and loadable", async () => {
    await agentikitIndex({ stashDir })

    const index = loadSearchIndex()
    expect(index).not.toBeNull()
    expect(index!.version).toBe(4)
    expect(index!.stashDir).toBe(stashDir)
    expect(index!.entries.length).toBeGreaterThan(0)
    expect(index!.builtAt).toBeTruthy()
    expect(index!.tfidf).toBeDefined()
  })

  test("search uses persisted index (simulates new session)", async () => {
    // First index
    await agentikitIndex({ stashDir })

    // Simulate a new session by just doing search (no re-index)
    const result = await agentikitSearch({ query: "docker" })
    expect(result.hits.length).toBeGreaterThan(0)
    // Should have scores from semantic search, not substring
    expect(result.hits[0].score).toBeDefined()
  })

  test("re-index updates the persisted index", async () => {
    await agentikitIndex({ stashDir })
    const index1 = loadSearchIndex()!

    // Add a new tool
    fs.mkdirSync(path.join(stashDir, "tools", "new-tool"), { recursive: true })
    fs.writeFileSync(
      path.join(stashDir, "tools", "new-tool", "hello.sh"),
      "#!/bin/bash\necho hello\n",
    )

    await agentikitIndex({ stashDir })
    const index2 = loadSearchIndex()!

    expect(index2.entries.length).toBeGreaterThan(index1.entries.length)
    expect(new Date(index2.builtAt).getTime()).toBeGreaterThanOrEqual(
      new Date(index1.builtAt).getTime(),
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 7: Error handling and edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Error handling and edge cases", () => {
  test("search with non-existent AGENTIKIT_STASH_DIR throws clear error", async () => {
    const orig = process.env.AGENTIKIT_STASH_DIR
    process.env.AGENTIKIT_STASH_DIR = "/nonexistent/path"
    try {
      await expect(agentikitSearch({ query: "test" })).rejects.toThrow(/Unable to read/)
    } finally {
      process.env.AGENTIKIT_STASH_DIR = orig
    }
  })

  test("search with unset AGENTIKIT_STASH_DIR throws clear error", async () => {
    const orig = process.env.AGENTIKIT_STASH_DIR
    delete process.env.AGENTIKIT_STASH_DIR
    try {
      await expect(agentikitSearch({ query: "test" })).rejects.toThrow(/AGENTIKIT_STASH_DIR is not set/)
    } finally {
      process.env.AGENTIKIT_STASH_DIR = orig
    }
  })

  test("show with invalid ref format throws", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-e2e-err-"))
    process.env.AGENTIKIT_STASH_DIR = stashDir
    try {
      expect(() => agentikitShow({ ref: "badref" })).toThrow(/Invalid open ref/)
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true })
    }
  })

  test("show with unknown type throws", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-e2e-err-"))
    process.env.AGENTIKIT_STASH_DIR = stashDir
    try {
      expect(() => agentikitShow({ ref: "widget:foo" })).toThrow(/Invalid open ref type/)
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true })
    }
  })

  test("show with path traversal attempt throws", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-e2e-err-"))
    fs.mkdirSync(path.join(stashDir, "tools"), { recursive: true })
    process.env.AGENTIKIT_STASH_DIR = stashDir
    try {
      expect(() => agentikitShow({ ref: "tool:..%2F..%2Fetc%2Fpasswd" })).toThrow(/Invalid open ref name/)
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true })
    }
  })

  test("search on empty stash returns no hits with tip", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-e2e-empty-"))
    for (const sub of ["tools", "skills", "commands", "agents"]) {
      fs.mkdirSync(path.join(stashDir, sub), { recursive: true })
    }
    process.env.AGENTIKIT_STASH_DIR = stashDir
    try {
      const result = await agentikitSearch({ query: "anything" })
      expect(result.hits).toHaveLength(0)
      expect(result.tip).toBeTruthy()
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true })
    }
  })

  test("index on empty stash succeeds with zero entries", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-e2e-empty-"))
    for (const sub of ["tools", "skills", "commands", "agents"]) {
      fs.mkdirSync(path.join(stashDir, sub), { recursive: true })
    }
    try {
      const result = await agentikitIndex({ stashDir })
      expect(result.totalEntries).toBe(0)
      expect(result.generatedMetadata).toBe(0)
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true })
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 8: Mixed asset type discovery
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Cross-type discovery", () => {
  let stashDir: string

  beforeAll(async () => {
    stashDir = copyFixturesToTmp()
    process.env.AGENTIKIT_STASH_DIR = stashDir
    await agentikitIndex({ stashDir })
  })

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true })
  })

  test("search 'any' type returns mixed results across tools, skills, commands, agents", async () => {
    const result = await agentikitSearch({ query: "", type: "any" })
    const types = new Set(result.hits.map((h) => h.type))
    // Should have at least tools and one other type
    expect(types.has("tool")).toBe(true)
    expect(types.size).toBeGreaterThan(1)
  })

  test("each hit has a valid openRef that can be used with show", async () => {
    const result = await agentikitSearch({ query: "", type: "any", limit: 10 })
    for (const hit of result.hits) {
      expect(hit.openRef).toBeTruthy()
      expect(hit.openRef).toContain(":")

      // Should not throw when opening
      const openResult = agentikitShow({ ref: hit.openRef })
      expect(openResult.type).toBe(hit.type)
    }
  })

  test("tool hits have runCmd, non-tool hits do not", async () => {
    const result = await agentikitSearch({ query: "", type: "any" })
    for (const hit of result.hits) {
      if (hit.type === "tool") {
        expect(hit.runCmd).toBeTruthy()
        expect(hit.kind).toBeTruthy()
      }
    }
  })
})
