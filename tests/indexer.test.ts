import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentikitIndex, getIndexPath, loadSearchIndex, buildSearchText } from "../src/indexer"

function tmpStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-idx-"))
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
  }
  return dir
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

test("agentikitIndex scans directories and builds index", async () => {
  const stashDir = tmpStash()
  writeFile(path.join(stashDir, "tools", "deploy", "deploy.sh"), "#!/usr/bin/env bash\n# Deploy to staging\necho deploy\n")
  writeFile(path.join(stashDir, "tools", "lint", "lint.ts"), "/**\n * Lint source code\n */\nconsole.log('lint')\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = await agentikitIndex({ stashDir })

  expect(result.totalEntries).toBe(2)
  expect(result.generatedMetadata).toBe(2)
  expect(result.stashDir).toBe(stashDir)

  // Verify .stash.json files were created
  const deployStash = path.join(stashDir, "tools", "deploy", ".stash.json")
  expect(fs.existsSync(deployStash)).toBe(true)

  const parsed = JSON.parse(fs.readFileSync(deployStash, "utf8"))
  expect(parsed.entries[0].name).toBe("deploy")
  expect(parsed.entries[0].generated).toBe(true)
})

test("agentikitIndex preserves manually-written .stash.json", async () => {
  const stashDir = tmpStash()
  writeFile(path.join(stashDir, "tools", "git", "summarize.ts"), "console.log('x')\n")
  writeFile(
    path.join(stashDir, "tools", "git", ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "git-summarize",
          type: "tool",
          description: "Summarize git changes",
          tags: ["git", "summary"],
          entry: "summarize.ts",
        },
      ],
    }),
  )

  const result = await agentikitIndex({ stashDir })

  expect(result.totalEntries).toBe(1)
  expect(result.generatedMetadata).toBe(0) // no generation needed

  // Verify the manual .stash.json was not overwritten
  const stash = JSON.parse(
    fs.readFileSync(path.join(stashDir, "tools", "git", ".stash.json"), "utf8"),
  )
  expect(stash.entries[0].name).toBe("git-summarize")
  expect(stash.entries[0].generated).toBeUndefined()
})

test("agentikitIndex migrates generated skill metadata name to canonical directory name", async () => {
  const stashDir = tmpStash()
  writeFile(path.join(stashDir, "skills", "code-review", "SKILL.md"), "# Code Review\n")
  writeFile(
    path.join(stashDir, "skills", "code-review", ".stash.json"),
    JSON.stringify({
      entries: [
        {
          name: "SKILL",
          type: "skill",
          generated: true,
          entry: "SKILL.md",
          description: "legacy generated skill metadata",
        },
      ],
    }),
  )

  const result = await agentikitIndex({ stashDir })
  expect(result.totalEntries).toBe(1)

  const stash = JSON.parse(
    fs.readFileSync(path.join(stashDir, "skills", "code-review", ".stash.json"), "utf8"),
  )
  expect(stash.entries[0].name).toBe("code-review")
  expect(stash.entries[0].generated).toBe(true)

  const index = loadSearchIndex()
  expect(index).not.toBeNull()
  expect(index!.entries[0].entry.name).toBe("code-review")
})

test("agentikitIndex writes index to cache", async () => {
  const stashDir = tmpStash()
  writeFile(path.join(stashDir, "tools", "hello", "hello.sh"), "#!/bin/bash\necho hi\n")

  const result = await agentikitIndex({ stashDir })
  expect(fs.existsSync(result.indexPath)).toBe(true)

  const index = loadSearchIndex()
  expect(index).not.toBeNull()
  expect(index!.version).toBe(4)
  expect(index!.entries.length).toBeGreaterThan(0)
})

test("agentikitIndex handles empty stash gracefully", async () => {
  const stashDir = tmpStash()
  const result = await agentikitIndex({ stashDir })

  expect(result.totalEntries).toBe(0)
  expect(result.generatedMetadata).toBe(0)
})

test("agentikitIndex handles markdown assets", async () => {
  const stashDir = tmpStash()
  writeFile(
    path.join(stashDir, "commands", "release.md"),
    '---\ndescription: "Release the project"\n---\nRun the release\n',
  )
  writeFile(
    path.join(stashDir, "skills", "refactor", "SKILL.md"),
    '---\ndescription: "Refactor code"\n---\n# Refactor skill\n',
  )

  const result = await agentikitIndex({ stashDir })
  expect(result.totalEntries).toBe(2)
})

test("agentikitIndex generates TOC in stash.json for knowledge entries", async () => {
  const stashDir = tmpStash()
  writeFile(
    path.join(stashDir, "knowledge", "guide.md"),
    "---\ndescription: \"A guide\"\n---\n# Getting Started\n\nIntro.\n\n## Installation\n\nInstall steps.\n",
  )

  const result = await agentikitIndex({ stashDir })
  expect(result.totalEntries).toBe(1)

  const stashJson = JSON.parse(
    fs.readFileSync(path.join(stashDir, "knowledge", ".stash.json"), "utf8"),
  )
  expect(stashJson.entries[0].toc).toBeDefined()
  expect(stashJson.entries[0].toc.length).toBe(2)
  expect(stashJson.entries[0].toc[0].text).toBe("Getting Started")
  expect(stashJson.entries[0].toc[1].text).toBe("Installation")
})

test("isDirStale detects stash.json newer than index", async () => {
  const stashDir = tmpStash()
  writeFile(path.join(stashDir, "tools", "deploy", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")

  // First index
  const result1 = await agentikitIndex({ stashDir })
  expect(result1.totalEntries).toBe(1)
  expect(result1.mode).toBe("full")

  // Second index (incremental) — nothing changed, so dir should be skipped
  const result2 = await agentikitIndex({ stashDir })
  expect(result2.mode).toBe("incremental")
  expect(result2.directoriesSkipped).toBeGreaterThanOrEqual(1)

  // Now touch the .stash.json to make it newer than the index
  // We need a small delay to ensure the mtime is strictly newer
  const stashJsonPath = path.join(stashDir, "tools", "deploy", ".stash.json")
  const futureTime = new Date(Date.now() + 2000)
  fs.utimesSync(stashJsonPath, futureTime, futureTime)

  // Third index (incremental) — should detect stale dir
  const result3 = await agentikitIndex({ stashDir })
  expect(result3.mode).toBe("incremental")
  expect(result3.directoriesScanned).toBeGreaterThanOrEqual(1)
})

test("agentikitIndex --full mode returns mode full", async () => {
  const stashDir = tmpStash()
  writeFile(path.join(stashDir, "tools", "hello", "hello.sh"), "#!/bin/bash\necho hi\n")

  // First index to create a previous index
  await agentikitIndex({ stashDir })

  // Second index with full flag — should force full reindex
  const result = await agentikitIndex({ stashDir, full: true })
  expect(result.mode).toBe("full")
})

test("buildSearchText includes TOC heading text for knowledge entries", async () => {
  const entry = {
    name: "guide",
    type: "knowledge" as const,
    description: "A guide",
    toc: [
      { level: 1, text: "Getting Started", line: 4 },
      { level: 2, text: "Installation", line: 8 },
    ],
  }

  const text = buildSearchText(entry)
  expect(text).toContain("getting started")
  expect(text).toContain("installation")
})

test("buildSearchText includes intents array content", () => {
  const entry = {
    name: "git-diff",
    type: "tool" as const,
    description: "summarize git changes",
    intents: ["explain what changed in a repository", "show commit summary"],
  }

  const text = buildSearchText(entry)
  expect(text).toContain("explain what changed in a repository")
  expect(text).toContain("show commit summary")
})

test("buildSearchText handles entries with both intents and intent fields", () => {
  const entry = {
    name: "deploy",
    type: "tool" as const,
    description: "deploy services",
    intents: ["deploy to production", "push services live"],
    intent: { when: "user needs to deploy", input: "service name", output: "status" },
  }

  const text = buildSearchText(entry)
  expect(text).toContain("deploy to production")
  expect(text).toContain("push services live")
  expect(text).toContain("user needs to deploy")
  expect(text).toContain("service name")
})

test("agentikitIndex does not generate heuristic intents (LLM-only)", async () => {
  const stashDir = tmpStash()
  writeFile(path.join(stashDir, "tools", "deploy", "deploy.sh"), "#!/usr/bin/env bash\n# Deploy services to production\necho deploy\n")

  await agentikitIndex({ stashDir })

  const stashJson = JSON.parse(
    fs.readFileSync(path.join(stashDir, "tools", "deploy", ".stash.json"), "utf8"),
  )
  // Intents are only generated when LLM is configured
  expect(stashJson.entries[0].intents).toBeUndefined()
})
