import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const buildDir = process.env.AGENTIKIT_TEST_BUILD_DIR || path.join(os.tmpdir(), "agentikit-test")
const modulePath = path.join(buildDir, "src", "stash.js")
const { agentikitOpen, agentikitSearch, agentikitRun } = await import(pathToFileURL(modulePath).href)

function writeFile(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

test("agentikitSearch only includes tool files with .sh/.ts/.js and returns runCmd", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")
  writeFile(path.join(stashDir, "tools", "script.ts"), "console.log('x')\n")
  writeFile(path.join(stashDir, "tools", "README.md"), "ignore\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitSearch({ query: "", type: "tool" })

  assert.equal(result.hits.length, 2)
  assert.equal(result.hits.every((hit) => hit.type === "tool"), true)
  assert.equal(result.hits.some((hit) => hit.name === "README.md"), false)
  assert.equal(result.hits.some((hit) => typeof hit.runCmd === "string"), true)
})

test("agentikitSearch creates bun runCmd from nearest package.json up to tools root", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  const nestedTool = path.join(stashDir, "tools", "group", "nested", "job.js")
  writeFile(nestedTool, "console.log('job')\n")
  writeFile(path.join(stashDir, "tools", "group", "package.json"), "{\"name\":\"group\"}")
  writeFile(path.join(stashDir, "tools", "package.json"), "{\"name\":\"root\"}")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitSearch({ query: "job", type: "tool" })

  assert.equal(result.hits.length, 1)
  assert.match(result.hits[0].runCmd ?? "", /^cd ".+\/tools\/group" && bun ".+\/job\.js"$/)
  assert.equal(result.hits[0].kind, "bun")
})

test("agentikitSearch only includes bun install in runCmd when AGENTIKIT_BUN_INSTALL is enabled", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  const nestedTool = path.join(stashDir, "tools", "group", "nested", "job.js")
  writeFile(nestedTool, "console.log('job')\n")
  writeFile(path.join(stashDir, "tools", "group", "package.json"), "{\"name\":\"group\"}")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  process.env.AGENTIKIT_BUN_INSTALL = "true"
  try {
    const result = agentikitSearch({ query: "job", type: "tool" })
    assert.equal(result.hits.length, 1)
    assert.match(result.hits[0].runCmd ?? "", /^cd ".+\/tools\/group" && bun install && bun ".+\/job\.js"$/)
    assert.equal(result.hits[0].kind, "bun")
  } finally {
    delete process.env.AGENTIKIT_BUN_INSTALL
  }
})

test("agentikitOpen returns full payloads for skill/command/agent", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "skills", "ops", "SKILL.md"), "# Ops\n")
  writeFile(path.join(stashDir, "commands", "release.md"), "---\ndescription: \"Release command\"\n---\nrun release\n")
  writeFile(path.join(stashDir, "agents", "coach.md"), "---\ndescription: \"Coach\"\nmodel: \"gpt-5\"\n---\nGuide users\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir

  const skill = agentikitOpen({ ref: "skill:ops" })
  const command = agentikitOpen({ ref: "command:release.md" })
  const agent = agentikitOpen({ ref: "agent:coach.md" })

  assert.equal(skill.type, "skill")
  assert.match(skill.content ?? "", /Ops/)
  assert.equal(command.type, "command")
  assert.match(command.template ?? "", /run release/)
  assert.equal(command.description, "Release command")
  assert.equal(agent.type, "agent")
  assert.match(agent.prompt ?? "", /Guide users/)
  assert.equal(agent.modelHint, "gpt-5")
})

test("agentikitOpen returns clear error when stash type root is missing", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  try {
    process.env.AGENTIKIT_STASH_DIR = stashDir
    assert.throws(
      () => agentikitOpen({ ref: "agent:missing.md" }),
      /Stash type root not found for ref: agent:missing\.md/,
    )
  } finally {
    fs.rmSync(stashDir, { recursive: true, force: true })
  }
})

test("agentikitRun executes a shell tool and returns its output", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "hello.sh"), "#!/usr/bin/env bash\necho 'hello from stash'\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitRun({ ref: "tool:hello.sh" })

  assert.equal(result.type, "tool")
  assert.equal(result.name, "hello.sh")
  assert.match(result.output, /hello from stash/)
  assert.equal(result.exitCode, 0)
})

test("agentikitRun returns non-zero exitCode when tool fails", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "failing.sh"), "#!/usr/bin/env bash\necho 'oops' >&2\nexit 1\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitRun({ ref: "tool:failing.sh" })

  assert.equal(result.type, "tool")
  assert.notEqual(result.exitCode, 0)
  assert.match(result.output, /oops/)
})

test("agentikitRun throws when given a non-tool ref", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  process.env.AGENTIKIT_STASH_DIR = stashDir
  assert.throws(
    () => agentikitRun({ ref: "skill:ops" }),
    /agentikitRun only supports tool refs/,
  )
})

test("agentikitOpen rejects malformed open ref encoding", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  process.env.AGENTIKIT_STASH_DIR = stashDir
  assert.throws(
    () => agentikitOpen({ ref: "tool:%E0%A4%A" }),
    /Invalid open ref encoding/,
  )
})

test("agentikitOpen rejects traversal and absolute path refs", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  process.env.AGENTIKIT_STASH_DIR = stashDir

  assert.throws(
    () => agentikitOpen({ ref: "tool:..%2Foutside.sh" }),
    /Invalid open ref name/,
  )
  assert.throws(
    () => agentikitOpen({ ref: "tool:%2Fetc%2Fpasswd" }),
    /Invalid open ref name/,
  )
})

test("agentikitOpen blocks symlink escapes outside stash type root", (t) => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-outside-"))
  const outsideFile = path.join(outsideDir, "outside.sh")
  const symlinkFile = path.join(stashDir, "tools", "link.sh")
  writeFile(outsideFile, "echo outside\n")
  fs.mkdirSync(path.join(stashDir, "tools"), { recursive: true })

  try {
    fs.symlinkSync(outsideFile, symlinkFile)
  } catch {
    t.skip("Symlinks are not supported in this environment")
    return
  }

  process.env.AGENTIKIT_STASH_DIR = stashDir
  assert.throws(
    () => agentikitOpen({ ref: "tool:link.sh" }),
    /Ref resolves outside the stash root/,
  )
})
