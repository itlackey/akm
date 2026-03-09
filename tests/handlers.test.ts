import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { toolHandler } from "../src/handlers/tool-handler"
import { scriptHandler } from "../src/handlers/script-handler"
import { skillHandler } from "../src/handlers/skill-handler"
import { knowledgeHandler } from "../src/handlers/knowledge-handler"
import { commandHandler } from "../src/handlers/command-handler"
import { agentHandler } from "../src/handlers/agent-handler"
import { isMarkdownFile, markdownCanonicalName, markdownAssetPath } from "../src/handlers/markdown-helpers"
import type { LocalSearchHit } from "../src/stash-types"

// ── Temp directory helpers ──────────────────────────────────────────────────

const createdTmpDirs: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-handlers-"))
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

// ── Environment variable safety ─────────────────────────────────────────────

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// ── 3.1 Tool handler ───────────────────────────────────────────────────────

describe("toolHandler", () => {
  test("buildShowResponse returns runCmd for .sh file", () => {
    const stashDir = tmpDir()
    const toolPath = path.join(stashDir, "tools", "deploy.sh")
    writeFile(toolPath, "#!/bin/bash\necho deploy\n")

    const res = toolHandler.buildShowResponse({
      name: "deploy.sh",
      path: toolPath,
      content: "#!/bin/bash\necho deploy\n",
      stashDirs: [stashDir],
    })

    expect(res.runCmd).toBeDefined()
    expect(res.runCmd).toContain("bash")
    expect(res.kind).toBe("bash")
  })

  test("buildShowResponse returns runCmd for .ts file", () => {
    const stashDir = tmpDir()
    const toolPath = path.join(stashDir, "tools", "run.ts")
    writeFile(toolPath, "console.log('hi')\n")

    const res = toolHandler.buildShowResponse({
      name: "run.ts",
      path: toolPath,
      content: "console.log('hi')\n",
      stashDirs: [stashDir],
    })

    expect(res.runCmd).toBeDefined()
    expect(res.runCmd).toContain("bun")
    expect(res.kind).toBe("bun")
  })

  test("buildShowResponse without stashDirs returns content", () => {
    const res = toolHandler.buildShowResponse({
      name: "deploy.sh",
      path: "/fake/deploy.sh",
      content: "#!/bin/bash\necho deploy\n",
    })

    expect(res.content).toBe("#!/bin/bash\necho deploy\n")
    expect(res.runCmd).toBeUndefined()
  })

  test("enrichSearchHit sets runCmd and kind on hit", () => {
    const stashDir = tmpDir()
    const toolPath = path.join(stashDir, "tools", "deploy.sh")
    writeFile(toolPath, "#!/bin/bash\necho deploy\n")

    const hit: LocalSearchHit = {
      hitSource: "local",
      type: "tool",
      name: "deploy.sh",
      path: toolPath,
      openRef: "tool:deploy.sh",
      editable: false,
    }

    toolHandler.enrichSearchHit!(hit, stashDir)

    expect(hit.runCmd).toBeDefined()
    expect(hit.runCmd).toContain("bash")
    expect(hit.kind).toBe("bash")
  })

  test("enrichSearchHit ignores ENOENT", () => {
    const stashDir = tmpDir()
    const hit: LocalSearchHit = {
      hitSource: "local",
      type: "tool",
      name: "missing.sh",
      path: path.join(stashDir, "tools", "missing.sh"),
      openRef: "tool:missing.sh",
      editable: false,
    }

    // Should not throw
    expect(() => toolHandler.enrichSearchHit!(hit, stashDir)).not.toThrow()
  })

  test("isRelevantFile accepts .sh .ts .js .ps1 .cmd .bat", () => {
    for (const ext of [".sh", ".ts", ".js", ".ps1", ".cmd", ".bat"]) {
      expect(toolHandler.isRelevantFile(`script${ext}`)).toBe(true)
    }
  })

  test("isRelevantFile rejects .md .py .txt", () => {
    for (const ext of [".md", ".py", ".txt"]) {
      expect(toolHandler.isRelevantFile(`file${ext}`)).toBe(false)
    }
  })
})

// ── 3.2 Script handler ─────────────────────────────────────────────────────

describe("scriptHandler", () => {
  test("buildShowResponse returns runCmd for runnable extensions", () => {
    for (const ext of [".sh", ".ts", ".js"]) {
      const stashDir = tmpDir()
      const scriptPath = path.join(stashDir, "scripts", `run${ext}`)
      writeFile(scriptPath, "echo hello\n")

      const res = scriptHandler.buildShowResponse({
        name: `run${ext}`,
        path: scriptPath,
        content: "echo hello\n",
        stashDirs: [stashDir],
      })

      expect(res.runCmd).toBeDefined()
      expect(res.type).toBe("script")
      if (ext === ".sh") {
        expect(res.kind).toBe("bash")
      } else {
        expect(res.kind).toBe("bun")
      }
    }
  })

  test("buildShowResponse returns content for non-runnable extensions", () => {
    for (const ext of [".py", ".rb"]) {
      const stashDir = tmpDir()
      const scriptPath = path.join(stashDir, "scripts", `run${ext}`)
      writeFile(scriptPath, "print('hi')\n")

      const res = scriptHandler.buildShowResponse({
        name: `run${ext}`,
        path: scriptPath,
        content: "print('hi')\n",
        stashDirs: [stashDir],
      })

      expect(res.content).toBe("print('hi')\n")
      expect(res.runCmd).toBeUndefined()
      expect(res.type).toBe("script")
    }
  })

  test("isRelevantFile accepts broad script extensions", () => {
    for (const ext of [".py", ".rb", ".go", ".lua", ".pl", ".php", ".sh", ".ts", ".js"]) {
      expect(scriptHandler.isRelevantFile(`script${ext}`)).toBe(true)
    }
  })

  test("isRelevantFile rejects non-script extensions", () => {
    for (const ext of [".md", ".txt", ".json"]) {
      expect(scriptHandler.isRelevantFile(`file${ext}`)).toBe(false)
    }
  })
})

// ── 3.3 Skill handler ──────────────────────────────────────────────────────

describe("skillHandler", () => {
  test("buildShowResponse returns type skill with content", () => {
    const res = skillHandler.buildShowResponse({
      name: "ops",
      path: "/stash/skills/ops/SKILL.md",
      content: "# Ops Skill\nDo ops stuff.",
    })

    expect(res.type).toBe("skill")
    expect(res.name).toBe("ops")
    expect(res.content).toBe("# Ops Skill\nDo ops stuff.")
  })

  test("toCanonicalName returns directory name", () => {
    const result = skillHandler.toCanonicalName("/stash/skills", "/stash/skills/ops/SKILL.md")
    expect(result).toBe("ops")
  })

  test("toCanonicalName returns undefined for root SKILL.md", () => {
    const result = skillHandler.toCanonicalName("/stash/skills", "/stash/skills/SKILL.md")
    expect(result).toBeUndefined()
  })

  test("toAssetPath appends SKILL.md", () => {
    const result = skillHandler.toAssetPath("root", "ops")
    expect(result).toBe(path.join("root", "ops", "SKILL.md"))
  })

  test("isRelevantFile only accepts SKILL.md", () => {
    expect(skillHandler.isRelevantFile("SKILL.md")).toBe(true)
    expect(skillHandler.isRelevantFile("skill.md")).toBe(false)
    expect(skillHandler.isRelevantFile("README.md")).toBe(false)
    expect(skillHandler.isRelevantFile("SKILL.txt")).toBe(false)
  })
})

// ── 3.4 Knowledge handler ──────────────────────────────────────────────────

describe("knowledgeHandler", () => {
  const sampleMarkdown = [
    "---",
    "title: Guide",
    "---",
    "# Introduction",
    "Welcome to the guide.",
    "",
    "## Setup",
    "Install things.",
    "",
    "## Usage",
    "Use things.",
  ].join("\n")

  test("buildShowResponse with mode full returns entire content", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "full" },
    })

    expect(res.type).toBe("knowledge")
    expect(res.content).toBe(sampleMarkdown)
  })

  test("buildShowResponse with default mode returns entire content", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
    })

    expect(res.content).toBe(sampleMarkdown)
  })

  test("buildShowResponse with mode toc returns formatted TOC", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "toc" },
    })

    expect(res.content).toBeDefined()
    expect(res.content).toContain("Introduction")
    expect(res.content).toContain("Setup")
    expect(res.content).toContain("Usage")
  })

  test("buildShowResponse with mode section extracts heading", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "section", heading: "Setup" },
    })

    expect(res.content).toBeDefined()
    expect(res.content).toContain("## Setup")
    expect(res.content).toContain("Install things.")
  })

  test("buildShowResponse with mode section returns error for missing heading", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "section", heading: "Nonexistent" },
    })

    expect(res.content).toContain('Section "Nonexistent" not found')
    expect(res.content).toContain("Try --view toc")
  })

  test("buildShowResponse with mode lines returns line range", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "lines", start: 4, end: 5 },
    })

    expect(res.content).toBeDefined()
    expect(res.content).toContain("Introduction")
    // Verify bounds: lines 4-5 should NOT include content from line 7+
    expect(res.content).not.toContain("Setup")
    expect(res.content).not.toContain("Install things.")
  })

  test("buildShowResponse with mode frontmatter returns YAML", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "frontmatter" },
    })

    expect(res.content).toBeDefined()
    expect(res.content).toContain("title")
  })

  test("buildShowResponse with mode frontmatter returns no-frontmatter message", () => {
    const noFrontmatter = "# Just a heading\nSome content."
    const res = knowledgeHandler.buildShowResponse({
      name: "plain.md",
      path: "/stash/knowledge/plain.md",
      content: noFrontmatter,
      view: { mode: "frontmatter" },
    })

    expect(res.content).toBe("(no frontmatter)")
  })
})

// ── 3.5 Command handler ────────────────────────────────────────────────────

describe("commandHandler", () => {
  test("buildShowResponse extracts description from frontmatter", () => {
    const content = [
      "---",
      "description: Deploy to production",
      "---",
      "Run the deploy script with {{env}}.",
    ].join("\n")

    const res = commandHandler.buildShowResponse({
      name: "deploy.md",
      path: "/stash/commands/deploy.md",
      content,
    })

    expect(res.type).toBe("command")
    expect(res.description).toBe("Deploy to production")
  })

  test("buildShowResponse extracts template from content", () => {
    const content = [
      "---",
      "description: Deploy to production",
      "---",
      "Run the deploy script with {{env}}.",
    ].join("\n")

    const res = commandHandler.buildShowResponse({
      name: "deploy.md",
      path: "/stash/commands/deploy.md",
      content,
    })

    expect(res.template).toBe("Run the deploy script with {{env}}.")
  })

  test("buildShowResponse handles missing frontmatter", () => {
    const content = "Just a plain command template."

    const res = commandHandler.buildShowResponse({
      name: "plain.md",
      path: "/stash/commands/plain.md",
      content,
    })

    expect(res.type).toBe("command")
    expect(res.description).toBeUndefined()
    expect(res.template).toBe("Just a plain command template.")
  })
})

// ── 3.6 Agent handler ──────────────────────────────────────────────────────

describe("agentHandler", () => {
  test("buildShowResponse extracts prompt with prefix", () => {
    const content = [
      "---",
      "description: Code reviewer",
      "---",
      "You are a code reviewer.",
    ].join("\n")

    const res = agentHandler.buildShowResponse({
      name: "reviewer.md",
      path: "/stash/agents/reviewer.md",
      content,
    })

    expect(res.type).toBe("agent")
    expect(res.prompt).toBeDefined()
    expect(res.prompt).toContain("Dispatching prompt")
    expect(res.prompt).toContain("verbatim")
    expect(res.prompt).toContain("non-compliant")
    expect(res.prompt).toContain("You are a code reviewer.")
  })

  test("buildShowResponse extracts modelHint from frontmatter", () => {
    const content = [
      "---",
      "model: gpt-4",
      "---",
      "You are an assistant.",
    ].join("\n")

    const res = agentHandler.buildShowResponse({
      name: "assistant.md",
      path: "/stash/agents/assistant.md",
      content,
    })

    expect(res.modelHint).toBe("gpt-4")
  })

  test("buildShowResponse extracts toolPolicy from frontmatter", () => {
    const content = [
      "---",
      "tools:",
      "  read: allow",
      "  write: deny",
      "---",
      "You are an assistant.",
    ].join("\n")

    const res = agentHandler.buildShowResponse({
      name: "assistant.md",
      path: "/stash/agents/assistant.md",
      content,
    })

    expect(res.toolPolicy).toBeDefined()
    expect(res.toolPolicy).toEqual({ read: "allow", write: "deny" })
  })

  test("buildShowResponse handles missing frontmatter fields", () => {
    const content = "You are a simple agent."

    const res = agentHandler.buildShowResponse({
      name: "simple.md",
      path: "/stash/agents/simple.md",
      content,
    })

    expect(res.type).toBe("agent")
    expect(res.description).toBeUndefined()
    expect(res.modelHint).toBeUndefined()
    expect(res.toolPolicy).toBeUndefined()
    expect(res.prompt).toContain("You are a simple agent.")
  })
})

// ── 3.7 Markdown helpers ───────────────────────────────────────────────────

describe("markdown helpers", () => {
  test("isMarkdownFile returns true for .md", () => {
    expect(isMarkdownFile("guide.md")).toBe(true)
    expect(isMarkdownFile("README.MD")).toBe(true)
  })

  test("isMarkdownFile returns false for .txt", () => {
    expect(isMarkdownFile("notes.txt")).toBe(false)
  })

  test("isMarkdownFile returns false for non-markdown extensions", () => {
    expect(isMarkdownFile("script.sh")).toBe(false)
    expect(isMarkdownFile("data.json")).toBe(false)
  })

  test("markdownCanonicalName returns POSIX relative path", () => {
    const result = markdownCanonicalName("/stash/knowledge", "/stash/knowledge/guides/setup.md")
    expect(result).toBe("guides/setup.md")
  })

  test("markdownCanonicalName returns filename for flat structure", () => {
    const result = markdownCanonicalName("/stash/knowledge", "/stash/knowledge/intro.md")
    expect(result).toBe("intro.md")
  })

  test("markdownAssetPath joins typeRoot and name", () => {
    const result = markdownAssetPath("/stash/knowledge", "guides/setup.md")
    expect(result).toBe(path.join("/stash/knowledge", "guides/setup.md"))
  })
})
