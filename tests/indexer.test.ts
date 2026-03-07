import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentikitIndex, getIndexPath, loadSearchIndex } from "../src/indexer"

function tmpStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-idx-"))
  for (const sub of ["tools", "skills", "commands", "agents"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
  }
  return dir
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

test("agentikitIndex scans directories and builds index", () => {
  const stashDir = tmpStash()
  writeFile(path.join(stashDir, "tools", "deploy", "deploy.sh"), "#!/usr/bin/env bash\n# Deploy to staging\necho deploy\n")
  writeFile(path.join(stashDir, "tools", "lint", "lint.ts"), "/**\n * Lint source code\n */\nconsole.log('lint')\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitIndex({ stashDir })

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

test("agentikitIndex preserves manually-written .stash.json", () => {
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

  const result = agentikitIndex({ stashDir })

  expect(result.totalEntries).toBe(1)
  expect(result.generatedMetadata).toBe(0) // no generation needed

  // Verify the manual .stash.json was not overwritten
  const stash = JSON.parse(
    fs.readFileSync(path.join(stashDir, "tools", "git", ".stash.json"), "utf8"),
  )
  expect(stash.entries[0].name).toBe("git-summarize")
  expect(stash.entries[0].generated).toBeUndefined()
})

test("agentikitIndex writes index to cache", () => {
  const stashDir = tmpStash()
  writeFile(path.join(stashDir, "tools", "hello", "hello.sh"), "#!/bin/bash\necho hi\n")

  const result = agentikitIndex({ stashDir })
  expect(fs.existsSync(result.indexPath)).toBe(true)

  const index = loadSearchIndex()
  expect(index).not.toBeNull()
  expect(index!.version).toBe(1)
  expect(index!.entries.length).toBeGreaterThan(0)
})

test("agentikitIndex handles empty stash gracefully", () => {
  const stashDir = tmpStash()
  const result = agentikitIndex({ stashDir })

  expect(result.totalEntries).toBe(0)
  expect(result.generatedMetadata).toBe(0)
})

test("agentikitIndex handles markdown assets", () => {
  const stashDir = tmpStash()
  writeFile(
    path.join(stashDir, "commands", "release.md"),
    '---\ndescription: "Release the project"\n---\nRun the release\n',
  )
  writeFile(
    path.join(stashDir, "skills", "refactor", "SKILL.md"),
    '---\ndescription: "Refactor code"\n---\n# Refactor skill\n',
  )

  const result = agentikitIndex({ stashDir })
  expect(result.totalEntries).toBe(2)
})
