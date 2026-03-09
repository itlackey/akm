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
} {
  const binDir = makeTempDir("agentikit-submit-bin-")
  const ghLog = path.join(binDir, "gh.log")
  const gitLog = path.join(binDir, "git.log")
  const snapshotPath = path.join(binDir, "manual-entries.snapshot.json")

  writeExecutable(path.join(binDir, "gh"), `#!/usr/bin/env sh
set -eu
GH_LOG=${JSON.stringify(ghLog)}
log_args() {
  printf '%s' "$1"
  shift
  for arg in "$@"; do
    printf '\\t%s' "$arg"
  done
  printf '\\n'
}
log_args "$@" >> "${ghLog}"
cmd1="\${1-}"
cmd2="\${2-}"
if [ "$cmd1" = "--version" ]; then
  echo "gh version 2.55.0"
  exit 0
fi
if [ "$cmd1" = "auth" ] && [ "$cmd2" = "status" ]; then
  exit 0
fi
if [ "$cmd1" = "api" ] && [ "$cmd2" = "user" ]; then
  echo "mock-user"
  exit 0
fi
if [ "$cmd1" = "repo" ] && [ "$cmd2" = "fork" ]; then
  mkdir -p "$PWD/agentikit-registry"
  printf '[]\\n' > "$PWD/agentikit-registry/manual-entries.json"
  exit 0
fi
if [ "$cmd1" = "pr" ] && [ "$cmd2" = "create" ]; then
  echo "https://github.com/itlackey/agentikit-registry/pull/123"
  exit 0
fi
if [ "$cmd1" = "repo" ] && [ "$cmd2" = "delete" ]; then
  exit 0
fi
echo "unexpected gh command: $*" >&2
exit 1
`)

  writeExecutable(path.join(binDir, "git"), `#!/usr/bin/env sh
set -eu
GIT_LOG=${JSON.stringify(gitLog)}
SNAPSHOT_PATH=${JSON.stringify(snapshotPath)}
log_args() {
  printf '%s' "$1"
  shift
  for arg in "$@"; do
    printf '\\t%s' "$arg"
  done
  printf '\\n'
}
log_args "$@" >> "${gitLog}"
if [ -f "$PWD/manual-entries.json" ]; then
  cp "$PWD/manual-entries.json" "${snapshotPath}"
fi
exit 0
`)

  return { binDir, ghLog, gitLog, snapshotPath }
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
    const { binDir } = createMockBinDir()

    const result = await withEnv(
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        AKM_SUBMIT_GH_BIN: path.join(binDir, "gh"),
        AKM_SUBMIT_GIT_BIN: path.join(binDir, "git"),
      },
      () => withMockedFetch((url) => {
        if (url === "https://registry.npmjs.org/%40scope%2Flocal-kit") {
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
        ghBin: path.join(binDir, "gh"),
        gitBin: path.join(binDir, "git"),
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
    const { binDir } = createMockBinDir()

    await expect(withEnv(
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        AKM_SUBMIT_GH_BIN: path.join(binDir, "gh"),
        AKM_SUBMIT_GIT_BIN: path.join(binDir, "git"),
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
        ghBin: path.join(binDir, "gh"),
        gitBin: path.join(binDir, "git"),
      })),
    )).rejects.toThrow('Registry entry "github:example/existing-kit" already exists in agentikit-registry.')
  })

  test("full submit workflow uses gh and git commands in order", async () => {
    const { binDir, ghLog, gitLog, snapshotPath } = createMockBinDir()

    const result = await withEnv(
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        AKM_SUBMIT_GH_BIN: path.join(binDir, "gh"),
        AKM_SUBMIT_GIT_BIN: path.join(binDir, "git"),
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
        ghBin: path.join(binDir, "gh"),
        gitBin: path.join(binDir, "git"),
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
    expect(ghCommands).toContain("repo\tdelete\tmock-user/agentikit-registry\t--yes")

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
