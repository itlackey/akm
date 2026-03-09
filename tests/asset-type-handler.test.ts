import { test, expect, describe } from "bun:test"
import {
  getHandler,
  tryGetHandler,
  getAllHandlers,
  getRegisteredTypeNames,
} from "../src/asset-type-handler"

// ── getHandler ──────────────────────────────────────────────────────────────

describe("getHandler", () => {
  test("returns registered handler for 'tool'", () => {
    const handler = getHandler("tool")
    expect(handler).toBeDefined()
    expect(handler.typeName).toBe("tool")
  })

  test("returns registered handler for 'skill'", () => {
    const handler = getHandler("skill")
    expect(handler).toBeDefined()
    expect(handler.typeName).toBe("skill")
  })

  test("returns registered handler for 'command'", () => {
    const handler = getHandler("command")
    expect(handler).toBeDefined()
    expect(handler.typeName).toBe("command")
  })

  test("returns registered handler for 'agent'", () => {
    const handler = getHandler("agent")
    expect(handler).toBeDefined()
    expect(handler.typeName).toBe("agent")
  })

  test("returns registered handler for 'knowledge'", () => {
    const handler = getHandler("knowledge")
    expect(handler).toBeDefined()
    expect(handler.typeName).toBe("knowledge")
  })

  test("returns registered handler for 'script'", () => {
    const handler = getHandler("script")
    expect(handler).toBeDefined()
    expect(handler.typeName).toBe("script")
  })

  test("throws for unknown type", () => {
    expect(() => getHandler("nonexistent")).toThrow("Unknown asset type")
  })
})

// ── tryGetHandler ───────────────────────────────────────────────────────────

describe("tryGetHandler", () => {
  test("returns handler for known type", () => {
    const handler = tryGetHandler("tool")
    expect(handler).toBeDefined()
    expect(handler!.typeName).toBe("tool")
  })

  test("returns undefined for unknown type", () => {
    const handler = tryGetHandler("nonexistent")
    expect(handler).toBeUndefined()
  })
})

// ── getAllHandlers ───────────────────────────────────────────────────────────

describe("getAllHandlers", () => {
  test("returns all 6 handlers", () => {
    const handlers = getAllHandlers()
    expect(handlers).toHaveLength(6)
  })

  test("each handler has a typeName property", () => {
    const handlers = getAllHandlers()
    for (const handler of handlers) {
      expect(typeof handler.typeName).toBe("string")
      expect(handler.typeName.length).toBeGreaterThan(0)
    }
  })
})

// ── getRegisteredTypeNames ──────────────────────────────────────────────────

describe("getRegisteredTypeNames", () => {
  test("returns all type names", () => {
    const names = getRegisteredTypeNames()
    expect(names).toContain("tool")
    expect(names).toContain("skill")
    expect(names).toContain("command")
    expect(names).toContain("agent")
    expect(names).toContain("knowledge")
    expect(names).toContain("script")
  })

  test("returns exactly 6 type names", () => {
    const names = getRegisteredTypeNames()
    expect(names).toHaveLength(6)
  })
})

// ── lazy initialization ─────────────────────────────────────────────────────

describe("lazy initialization", () => {
  test("loads handlers on first access without explicit import of handlers/index", () => {
    // This test verifies that getHandler triggers lazy registration.
    // We have not imported ../src/handlers/index directly in this file,
    // yet getHandler should still resolve "tool" via ensureHandlersRegistered.
    const handler = getHandler("tool")
    expect(handler).toBeDefined()
    expect(handler.typeName).toBe("tool")
  })
})
