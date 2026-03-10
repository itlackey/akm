import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseRegistryRef } from "../src/registry-resolve"
import {
  agentikitSubmit,
  buildSubmitBranchName,
  buildSubmitEntry,
  slugifySubmitValue,
} from "../src/submit"

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf8")
  fs.chmodSync(filePath, 0o755)
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
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
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
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

async function withMockedFetch<T>(
  handler: (url: string) => Response,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    return handler(url)
  }) as typeof fetch

  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

function createMockBinDir(): {
  binDir: string
  ghLog: string
  gitLog: string
  snapshotPath: string
  ghBin: string
  gitBin: string
} {
  const binDir = makeTempDir("agentikit-submit-bin-")
  const ghLog = path.join(binDir, "gh.log")
  const gitLog = path.join(binDir, "git.log")
  const snapshotPath = path.join(binDir, "manual-entries.snapshot.json")

  const ghBin = writeMockCommand(binDir, "gh", `
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(ghLog)}, \`\${args.join("\\t")}\\n\`)
const [cmd1 = "", cmd2 = ""] = args
if (cmd1 === "--version") {
  process.stdout.write("gh version 2.55.0\\n")
  process.exit(0)
}
if (cmd1 === "auth" && cmd2 === "status") {
  process.exit(0)
}
if (cmd1 === "api" && cmd2 === "user") {
  process.stdout.write("mock-user\\n")
  process.exit(0)
}
if (cmd1 === "repo" && cmd2 === "fork") {
  const cloneDir = path.join(process.cwd(), "agentikit-registry")
  fs.mkdirSync(cloneDir, { recursive: true })
  fs.writeFileSync(path.join(cloneDir, "manual-entries.json"), "[]\\n")
  process.exit(0)
}
if (cmd1 === "pr" && cmd2 === "create") {
  process.stdout.write("https://github.com/itlackey/agentikit-registry/pull/123\\n")
  process.exit(0)
}
if (cmd1 === "repo" && cmd2 === "delete") {
  process.exit(0)
}
process.stderr.write(\`unexpected gh command: \${args.join(" ")}\\n\`)
process.exit(1)
`)

  const gitBin = writeMockCommand(binDir, "git", `
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(gitLog)}, \`\${args.join("\\t")}\\n\`)
const manualEntries = path.join(process.cwd(), "manual-entries.json")
if (fs.existsSync(manualEntries)) {
  fs.copyFileSync(manualEntries, ${JSON.stringify(snapshotPath)})
}
process.exit(0)
`)

  return { binDir, ghLog, gitLog, snapshotPath, ghBin, gitBin }
}

function writeMockCommand(binDir: string, name: string, scriptBody: string): string {
  const scriptPath = path.join(binDir, `${name}.js`)
  writeExecutable(scriptPath, `#!/usr/bin/env node\n${scriptBody.trim()}\n`)

  if (process.platform !== "win32") {
    return scriptPath
  }

  const launcherPath = path.join(binDir, `${name}.cmd`)
  fs.writeFileSync(
    launcherPath,
    [
      "@echo off",
      "setlocal",
      `set "AKM_MOCK_EXEC=${escapeBatchValue(process.execPath)}"`,
      `set "AKM_MOCK_SCRIPT=${escapeBatchValue(scriptPath)}"`,
      "\"%AKM_MOCK_EXEC%\" \"%AKM_MOCK_SCRIPT%\" %*",
      "",
    ].join("\r\n"),
    "utf8",
  )
  return launcherPath
}

function prependToPath(binDir: string): string {
  return `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
}

function escapeBatchValue(value: string): string {
  // Batch files treat % as variable expansion, so it must be doubled. Other
  // cmd metacharacters are escaped with ^ before storing them in SET values.
  return value.replace(/[%^&|<>"]/g, (char) => {
    if (char === "%") return "%%"
    return `^${char}`
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("submit helpers", () => {
  test("buildSubmitEntry prefers CLI overrides and canonicalizes npm refs", async () => {
    const parsed = parseRegistryRef("npm:@scope/my-kit@latest")
    if (parsed.source !== "npm") throw new Error("expected npm ref")

    const entry = await buildSubmitEntry({
      parsed,
      interactive: false,
      name: "CLI Name",
      description: "CLI description",
      tags: "agentikit,skill,tool,skill",
      assetTypes: "tool,skill",
      author: "CLI Author",
      license: "Apache-2.0",
      homepage: "https://example.test/kit",
      packageJson: {
        name: "@scope/from-package",
        description: "package description",
        keywords: ["agentikit", "ignored"],
        author: "Package Author",
        license: "MIT",
        agentikitAssetTypes: ["command"],
      },
    })

    expect(entry.id).toBe("npm:@scope/my-kit")
    expect(entry.ref).toBe("@scope/my-kit")
    expect(entry.name).toBe("CLI Name")
    expect(entry.description).toBe("CLI description")
    expect(entry.tags).toEqual(["skill", "tool"])
    expect(entry.assetTypes).toEqual(["tool", "skill"])
    expect(entry.author).toBe("CLI Author")
    expect(entry.license).toBe("Apache-2.0")
    expect(entry.homepage).toBe("https://example.test/kit")
  })

  test("buildSubmitBranchName slugifies ids predictably", () => {
    const now = new Date("2026-03-09T14:30:00Z")
    expect(slugifySubmitValue("github:@Owner/Repo")).toBe("github-owner-repo")
    expect(buildSubmitBranchName("github:@Owner/Repo", now)).toBe("submit/github-owner-repo-20260309-1430")
  })

  test("buildSubmitEntry falls back to package.json when no CLI overrides are given", async () => {
    const parsed = parseRegistryRef("npm:@scope/pkg-kit")
    if (parsed.source !== "npm") throw new Error("expected npm ref")

    const entry = await buildSubmitEntry({
      parsed,
      interactive: false,
      packageJson: {
        name: "@scope/pkg-kit",
        description: "From package",
        keywords: ["agentikit", "deploy", "ci"],
        author: "Pkg Author",
        license: "ISC",
        homepage: "https://example.test/pkg",
        agentikitAssetTypes: ["tool", "command"],
      },
    })

    expect(entry.name).toBe("@scope/pkg-kit")
    expect(entry.description).toBe("From package")
    expect(entry.tags).toEqual(["deploy", "ci"])
    expect(entry.assetTypes).toEqual(["tool", "command"])
    expect(entry.author).toBe("Pkg Author")
    expect(entry.license).toBe("ISC")
    expect(entry.homepage).toBe("https://example.test/pkg")
  })

  test("buildSubmitEntry infers homepage for npm and github refs", async () => {
    const npm = parseRegistryRef("npm:@scope/my-kit")
    if (npm.source !== "npm") throw new Error("expected npm ref")
    const npmEntry = await buildSubmitEntry({ parsed: npm, interactive: false })
    expect(npmEntry.homepage).toBe("https://www.npmjs.com/package/@scope/my-kit")

    const gh = parseRegistryRef("github:owner/repo")
    if (gh.source !== "github") throw new Error("expected github ref")
    const ghEntry = await buildSubmitEntry({ parsed: gh, interactive: false })
    expect(ghEntry.homepage).toBe("https://github.com/owner/repo")
  })

  test("normalizeAssetTypes rejects invalid types", async () => {
    const parsed = parseRegistryRef("npm:@scope/bad-types")
    if (parsed.source !== "npm") throw new Error("expected npm ref")

    await expect(
      buildSubmitEntry({
        parsed,
        interactive: false,
        assetTypes: "tool,widget,skill",
      }),
    ).rejects.toThrow("Invalid asset type: widget")
  })
})

describe("agentikitSubmit", () => {
  test("dry run infers a public ref from package.json metadata", async () => {
    const kitDir = makeTempDir("agentikit-submit-kit-")
    writeJson(path.join(kitDir, "package.json"), {
      name: "@scope/local-kit",
      description: "Local kit description",
      keywords: ["agentikit", "skill", "tool"],
      author: { name: "Kit Author" },
      license: "MIT",
      agentikit: { assetTypes: ["tool", "skill"] },
      repository: { type: "git", url: "git+https://github.com/example/local-kit.git" },
    })
    const { binDir, ghBin, gitBin } = createMockBinDir()

    const result = await withEnv(
      {
        PATH: prependToPath(binDir),
        AKM_SUBMIT_GH_BIN: ghBin,
        AKM_SUBMIT_GIT_BIN: gitBin,
      },
      () => withMockedFetch((url) => {
        if (url === "https://registry.npmjs.org/@scope%2Flocal-kit") {
          return new Response("{}", { status: 200 })
        }
        if (url === "https://api.github.com/repos/itlackey/agentikit-registry") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })
        }
        if (url === "https://raw.githubusercontent.com/itlackey/agentikit-registry/main/manual-entries.json") {
          return new Response("[]", { status: 200 })
        }
        return new Response("not found", { status: 404 })
      }, () => agentikitSubmit({
        cwd: kitDir,
        dryRun: true,
        interactive: false,
        ghBin,
        gitBin,
      })),
    )

    expect(result.dryRun).toBe(true)
    expect(result.validation.refAccessible).toBe(true)
    expect(result.validation.duplicateFound).toBe(false)
    expect(result.entry.id).toBe("npm:@scope/local-kit")
    expect(result.entry.ref).toBe("@scope/local-kit")
    expect(result.entry.name).toBe("@scope/local-kit")
    expect(result.entry.tags).toEqual(["skill", "tool"])
    expect(result.commands?.some((command) => command.includes("gh repo fork itlackey/agentikit-registry --clone --remote"))).toBe(true)
  })

  test("dry run fails when the manual entry already exists", async () => {
    const { binDir, ghBin, gitBin } = createMockBinDir()

    await expect(withEnv(
      {
        PATH: prependToPath(binDir),
        AKM_SUBMIT_GH_BIN: ghBin,
        AKM_SUBMIT_GIT_BIN: gitBin,
      },
      () => withMockedFetch((url) => {
        if (url === "https://api.github.com/repos/example/existing-kit") {
          return new Response(JSON.stringify({ id: 1 }), { status: 200 })
        }
        if (url === "https://api.github.com/repos/itlackey/agentikit-registry") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })
        }
        if (url === "https://raw.githubusercontent.com/itlackey/agentikit-registry/main/manual-entries.json") {
          return new Response(JSON.stringify([{ id: "github:example/existing-kit" }]), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      }, () => agentikitSubmit({
        ref: "example/existing-kit",
        dryRun: true,
        interactive: false,
        ghBin,
        gitBin,
      })),
    )).rejects.toThrow('Registry entry "github:example/existing-kit" already exists in agentikit-registry.')
  })

  test("dry run rejects private GitHub repos even when the API is accessible", async () => {
    const { binDir, ghBin, gitBin } = createMockBinDir()

    await expect(withEnv(
      {
        PATH: prependToPath(binDir),
        AKM_SUBMIT_GH_BIN: ghBin,
        AKM_SUBMIT_GIT_BIN: gitBin,
      },
      () => withMockedFetch((url) => {
        if (url === "https://api.github.com/repos/example/private-kit") {
          return new Response(JSON.stringify({ private: true, visibility: "private" }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      }, () => agentikitSubmit({
        ref: "example/private-kit",
        dryRun: true,
        interactive: false,
        ghBin,
        gitBin,
      })),
    )).rejects.toThrow('Registry ref "example/private-kit" is not publicly accessible.')
  })

  test("dry run fetches manual entries from raw.githubusercontent using slash-containing default branches", async () => {
    const { binDir, ghBin, gitBin } = createMockBinDir()
    const urls: string[] = []

    const result = await withEnv(
      {
        PATH: prependToPath(binDir),
        AKM_SUBMIT_GH_BIN: ghBin,
        AKM_SUBMIT_GIT_BIN: gitBin,
      },
      () => withMockedFetch((url) => {
        urls.push(url)
        if (url === "https://api.github.com/repos/example/branch-kit") {
          return new Response(JSON.stringify({ private: false, visibility: "public" }), { status: 200 })
        }
        if (url === "https://api.github.com/repos/itlackey/agentikit-registry") {
          return new Response(JSON.stringify({ default_branch: "release/2026" }), { status: 200 })
        }
        if (url === "https://raw.githubusercontent.com/itlackey/agentikit-registry/release/2026/manual-entries.json") {
          return new Response("[]", { status: 200 })
        }
        return new Response("not found", { status: 404 })
      }, () => agentikitSubmit({
        ref: "example/branch-kit",
        dryRun: true,
        interactive: false,
        ghBin,
        gitBin,
      })),
    )

    expect(result.dryRun).toBe(true)
    expect(urls).toContain("https://raw.githubusercontent.com/itlackey/agentikit-registry/release/2026/manual-entries.json")
    expect(urls.some((url) => url.includes("release%2F2026"))).toBe(false)
  })

  test("dry run treats existing owner/repo-like directories as local paths", async () => {
    const parentDir = makeTempDir("agentikit-submit-local-parent-")
    const kitDir = path.join(parentDir, "kits", "my-kit")
    fs.mkdirSync(kitDir, { recursive: true })
    writeJson(path.join(kitDir, "package.json"), {
      name: "local-dir-kit",
      description: "Kit from a local owner/repo-like path",
      keywords: ["agentikit", "tool"],
    })
    const { binDir, ghBin, gitBin } = createMockBinDir()

    const result = await withEnv(
      {
        PATH: prependToPath(binDir),
        AKM_SUBMIT_GH_BIN: ghBin,
        AKM_SUBMIT_GIT_BIN: gitBin,
      },
      () => withMockedFetch((url) => {
        if (url === "https://registry.npmjs.org/local-dir-kit") {
          return new Response("{}", { status: 200 })
        }
        if (url === "https://api.github.com/repos/itlackey/agentikit-registry") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })
        }
        if (url === "https://raw.githubusercontent.com/itlackey/agentikit-registry/main/manual-entries.json") {
          return new Response("[]", { status: 200 })
        }
        return new Response("not found", { status: 404 })
      }, () => agentikitSubmit({
        ref: "kits/my-kit",
        cwd: parentDir,
        dryRun: true,
        interactive: false,
        ghBin,
        gitBin,
      })),
    )

    expect(result.entry.id).toBe("npm:local-dir-kit")
    expect(result.entry.ref).toBe("local-dir-kit")
  })

  test("dry run planned commands safely quote user-controlled values and preserve multiline bodies", async () => {
    const { binDir, ghBin, gitBin } = createMockBinDir()

    const result = await withEnv(
      {
        PATH: prependToPath(binDir),
        AKM_SUBMIT_GH_BIN: ghBin,
        AKM_SUBMIT_GIT_BIN: gitBin,
      },
      () => withMockedFetch((url) => {
        if (url === "https://api.github.com/repos/example/quoted-kit") {
          return new Response(JSON.stringify({ private: false, visibility: "public" }), { status: 200 })
        }
        if (url === "https://api.github.com/repos/itlackey/agentikit-registry") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })
        }
        if (url === "https://raw.githubusercontent.com/itlackey/agentikit-registry/main/manual-entries.json") {
          return new Response("[]", { status: 200 })
        }
        return new Response("not found", { status: 404 })
      }, () => agentikitSubmit({
        ref: "example/quoted-kit",
        name: `Kit "Alpha"`,
        dryRun: true,
        interactive: false,
        ghBin,
        gitBin,
      })),
    )

    const commitCommand = result.commands?.find((command) => command.startsWith("git commit -m "))
    expect(commitCommand).toContain(`git commit -m 'feat: add Kit "Alpha" to registry'`)

    const prCommand = result.commands?.find((command) => command.startsWith("gh pr create "))
    expect(prCommand).toContain("--body")
    expect(prCommand).toContain("## New registry entry: Kit \"Alpha\"")
    expect(prCommand).toContain("\n### Entry JSON\n")
    expect(prCommand).not.toContain("\\n")
  })

  test("rejects generic git URLs with a clear error", async () => {
    const { binDir, ghBin, gitBin } = createMockBinDir()

    await expect(withEnv(
      {
        PATH: prependToPath(binDir),
        AKM_SUBMIT_GH_BIN: ghBin,
        AKM_SUBMIT_GIT_BIN: gitBin,
      },
      () => agentikitSubmit({
        ref: "git+https://gitlab.com/org/my-kit",
        dryRun: true,
        interactive: false,
        ghBin,
        gitBin,
      }),
    )).rejects.toThrow("does not support generic git URLs")
  })

  test("rejects refs that are not publicly accessible", async () => {
    const { binDir, ghBin, gitBin } = createMockBinDir()

    await expect(withEnv(
      {
        PATH: prependToPath(binDir),
        AKM_SUBMIT_GH_BIN: ghBin,
        AKM_SUBMIT_GIT_BIN: gitBin,
      },
      () => withMockedFetch((url) => {
        if (url === "https://api.github.com/repos/example/missing-kit") {
          return new Response("not found", { status: 404 })
        }
        return new Response("not found", { status: 404 })
      }, () => agentikitSubmit({
        ref: "example/missing-kit",
        dryRun: true,
        interactive: false,
        ghBin,
        gitBin,
      })),
    )).rejects.toThrow("not publicly accessible")
  })

  test("full submit workflow uses gh and git commands in order", async () => {
    const { binDir, ghLog, gitLog, snapshotPath, ghBin, gitBin } = createMockBinDir()

    const result = await withEnv(
      {
        PATH: prependToPath(binDir),
        AKM_SUBMIT_GH_BIN: ghBin,
        AKM_SUBMIT_GIT_BIN: gitBin,
      },
      () => withMockedFetch((url) => {
        if (url === "https://api.github.com/repos/example/owner-kit") {
          return new Response(JSON.stringify({ id: 2 }), { status: 200 })
        }
        if (url === "https://api.github.com/repos/itlackey/agentikit-registry") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })
        }
        if (url === "https://raw.githubusercontent.com/itlackey/agentikit-registry/main/manual-entries.json") {
          return new Response("[]", { status: 200 })
        }
        return new Response("not found", { status: 404 })
      }, () => agentikitSubmit({
        ref: "example/owner-kit",
        cleanupFork: true,
        interactive: false,
        ghBin,
        gitBin,
      })),
    )

    expect(result.dryRun).toBe(false)
    expect(result.pr?.url).toBe("https://github.com/itlackey/agentikit-registry/pull/123")
    expect(result.pr?.number).toBe(123)
    expect(result.fork?.url).toBe("https://github.com/mock-user/agentikit-registry")

    const ghCommands = fs.readFileSync(ghLog, "utf8")
    expect(ghCommands).toContain("repo\tfork\titlackey/agentikit-registry\t--clone\t--remote")
    expect(ghCommands).toContain("api\tuser\t--jq\t.login")
    expect(ghCommands).toContain("pr\tcreate")
    // Fork delete is now deferred until after PR merge — not executed during submit
    expect(ghCommands).not.toContain("repo\tdelete")
    expect(result.fork?.cleanupCommand).toBe("gh repo delete mock-user/agentikit-registry --yes")

    expect(result.commands?.some((command) =>
      command.includes("--body") && command.includes("## New registry entry: owner-kit"),
    )).toBe(true)

    const gitCommands = fs.readFileSync(gitLog, "utf8")
    expect(gitCommands).toContain("checkout\t-b\tsubmit/github-example-owner-kit-")
    expect(gitCommands).toContain("add\tmanual-entries.json")
    expect(gitCommands).toContain("commit\t-m\tfeat: add owner-kit to registry")
    expect(gitCommands).toContain("push\torigin\tsubmit/github-example-owner-kit-")

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Array<{ id: string; ref: string }>
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toEqual(expect.objectContaining({
      id: "github:example/owner-kit",
      ref: "example/owner-kit",
    }))
  })
})
