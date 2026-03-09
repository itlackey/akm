import { test, expect, describe } from "bun:test"
import { parseOpenRef, makeOpenRef } from "../src/stash-ref"

// ── parseOpenRef ────────────────────────────────────────────────────────────

describe("parseOpenRef", () => {
  test("parses valid tool ref", () => {
    const ref = parseOpenRef("tool:deploy.sh")
    expect(ref.type).toBe("tool")
    expect(ref.name).toBe("deploy.sh")
  })

  test("parses valid skill ref", () => {
    const ref = parseOpenRef("skill:code-review")
    expect(ref.type).toBe("skill")
    expect(ref.name).toBe("code-review")
  })

  test("parses valid command ref", () => {
    const ref = parseOpenRef("command:release.md")
    expect(ref.type).toBe("command")
    expect(ref.name).toBe("release.md")
  })

  test("parses valid agent ref", () => {
    const ref = parseOpenRef("agent:architect.md")
    expect(ref.type).toBe("agent")
    expect(ref.name).toBe("architect.md")
  })

  test("parses valid knowledge ref", () => {
    const ref = parseOpenRef("knowledge:guide.md")
    expect(ref.type).toBe("knowledge")
    expect(ref.name).toBe("guide.md")
  })

  test("decodes URL-encoded names", () => {
    const ref = parseOpenRef("tool:my%20tool.sh")
    expect(ref.name).toBe("my tool.sh")
  })

  test("throws for missing separator", () => {
    expect(() => parseOpenRef("badref")).toThrow("Invalid open ref")
  })

  test("throws for slash-separated refs", () => {
    expect(() => parseOpenRef("skill/code-review")).toThrow("Invalid open ref")
  })

  test("throws for empty type (separator at start)", () => {
    expect(() => parseOpenRef(":name")).toThrow("Invalid open ref")
  })

  test("throws for invalid type", () => {
    expect(() => parseOpenRef("widget:foo")).toThrow("Invalid open ref type")
  })

  test("throws for invalid URL encoding", () => {
    expect(() => parseOpenRef("tool:%E0%A4%A")).toThrow("Invalid open ref encoding")
  })

  test("throws for empty name", () => {
    expect(() => parseOpenRef("tool:")).toThrow("Invalid open ref name")
  })

  test("throws for null byte in name", () => {
    expect(() => parseOpenRef("tool:foo%00bar")).toThrow("Invalid open ref name")
  })

  test("throws for absolute path", () => {
    expect(() => parseOpenRef("tool:%2Fetc%2Fpasswd")).toThrow("Invalid open ref name")
  })

  test("throws for path traversal (..)", () => {
    expect(() => parseOpenRef("tool:..%2Foutside.sh")).toThrow("Invalid open ref name")
  })

  test("throws for Windows-style absolute path", () => {
    expect(() => parseOpenRef("tool:C%3A%5Cfoo")).toThrow("Invalid open ref name")
  })

  test("normalizes backslashes in name", () => {
    const ref = parseOpenRef("tool:dir%2Ffile.sh")
    expect(ref.name).toBe("dir/file.sh")
  })

  test("parses @working/ prefix", () => {
    const ref = parseOpenRef("@working/tool:deploy.sh")
    expect(ref.type).toBe("tool")
    expect(ref.name).toBe("deploy.sh")
    expect(ref.sourceKind).toBe("working")
    expect(ref.registryId).toBeUndefined()
  })

  test("parses @mounted/ prefix", () => {
    const ref = parseOpenRef("@mounted/skill:code-review")
    expect(ref.type).toBe("skill")
    expect(ref.name).toBe("code-review")
    expect(ref.sourceKind).toBe("mounted")
  })

  test("parses @installed:registryId/ prefix", () => {
    const ref = parseOpenRef("@installed:npm%3A%40scope%2Fpkg/tool:deploy.sh")
    expect(ref.type).toBe("tool")
    expect(ref.name).toBe("deploy.sh")
    expect(ref.sourceKind).toBe("installed")
    expect(ref.registryId).toBe("npm:@scope/pkg")
  })

  test("plain ref has undefined sourceKind", () => {
    const ref = parseOpenRef("tool:deploy.sh")
    expect(ref.sourceKind).toBeUndefined()
    expect(ref.registryId).toBeUndefined()
  })

  test("throws for invalid source kind", () => {
    expect(() => parseOpenRef("@bogus/tool:test.sh")).toThrow("Invalid source kind")
  })

  test("throws for empty registry id", () => {
    expect(() => parseOpenRef("@installed:/tool:test.sh")).toThrow("Empty registry id")
  })

  test("throws for @ prefix with no slash", () => {
    expect(() => parseOpenRef("@working")).toThrow("Invalid open ref")
  })
})

// ── makeOpenRef ─────────────────────────────────────────────────────────────

describe("makeOpenRef", () => {
  test("creates valid ref string", () => {
    expect(makeOpenRef("tool", "deploy.sh")).toBe("tool:deploy.sh")
  })

  test("encodes special characters in name", () => {
    const ref = makeOpenRef("tool", "my tool.sh")
    expect(ref).toBe("tool:my%20tool.sh")
  })

  test("roundtrips with parseOpenRef", () => {
    const original = { type: "skill" as const, name: "code-review" }
    const refStr = makeOpenRef(original.type, original.name)
    const parsed = parseOpenRef(refStr)
    expect(parsed.type).toBe(original.type)
    expect(parsed.name).toBe(original.name)
  })

  test("roundtrips names with special characters", () => {
    const name = "sub/dir/file name.sh"
    const refStr = makeOpenRef("tool", name)
    const parsed = parseOpenRef(refStr)
    expect(parsed.name).toBe("sub/dir/file name.sh")
  })

  test("creates @working/ prefixed ref", () => {
    expect(makeOpenRef("tool", "deploy.sh", "working")).toBe("@working/tool:deploy.sh")
  })

  test("creates @mounted/ prefixed ref", () => {
    expect(makeOpenRef("skill", "review", "mounted")).toBe("@mounted/skill:review")
  })

  test("creates @installed:id/ prefixed ref", () => {
    const ref = makeOpenRef("tool", "deploy.sh", "installed", "npm:@scope/pkg")
    expect(ref).toBe("@installed:npm%3A%40scope%2Fpkg/tool:deploy.sh")
  })

  test("installed without registryId omits colon segment", () => {
    expect(makeOpenRef("tool", "test.sh", "installed")).toBe("@installed/tool:test.sh")
  })

  test("roundtrips source-qualified refs", () => {
    const ref = makeOpenRef("tool", "deploy.sh", "installed", "npm:@scope/pkg")
    const parsed = parseOpenRef(ref)
    expect(parsed.type).toBe("tool")
    expect(parsed.name).toBe("deploy.sh")
    expect(parsed.sourceKind).toBe("installed")
    expect(parsed.registryId).toBe("npm:@scope/pkg")
  })

  test("roundtrips @working refs", () => {
    const ref = makeOpenRef("skill", "code-review", "working")
    const parsed = parseOpenRef(ref)
    expect(parsed.type).toBe("skill")
    expect(parsed.name).toBe("code-review")
    expect(parsed.sourceKind).toBe("working")
  })
})
