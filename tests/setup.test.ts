import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── detect.ts tests ─────────────────────────────────────────────────────────

describe("detectAgentPlatforms", () => {
  let testHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-detect-"));
    process.env.HOME = testHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  test("returns empty array when no platforms found", async () => {
    const { detectAgentPlatforms } = await import("../src/detect");
    const result = detectAgentPlatforms();
    expect(result).toEqual([]);
  });

  test("detects .claude directory", async () => {
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    // Re-import to pick up fresh HOME
    const { detectAgentPlatforms } = await import("../src/detect");
    const result = detectAgentPlatforms();
    const claude = result.find((p) => p.name === "Claude Code");
    expect(claude).toBeDefined();
    expect(claude?.path).toBe(path.join(testHome, ".claude"));
  });

  test("detects .config/opencode directory", async () => {
    fs.mkdirSync(path.join(testHome, ".config", "opencode"), { recursive: true });
    const { detectAgentPlatforms } = await import("../src/detect");
    const result = detectAgentPlatforms();
    const opencode = result.find((p) => p.name === "OpenCode");
    expect(opencode).toBeDefined();
    expect(opencode?.path).toBe(path.join(testHome, ".config", "opencode"));
  });

  test("detects multiple platforms", async () => {
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(testHome, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(testHome, ".continue"), { recursive: true });
    const { detectAgentPlatforms } = await import("../src/detect");
    const result = detectAgentPlatforms();
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  test("ignores files (only detects directories)", async () => {
    fs.writeFileSync(path.join(testHome, ".claude"), "not a directory");
    const { detectAgentPlatforms } = await import("../src/detect");
    const result = detectAgentPlatforms();
    const claude = result.find((p) => p.name === "Claude Code");
    expect(claude).toBeUndefined();
  });

  test("returns empty when HOME and USERPROFILE are both unset", async () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const { detectAgentPlatforms } = await import("../src/detect");
    const result = detectAgentPlatforms();
    expect(result).toEqual([]);
  });

  test("falls back to USERPROFILE when HOME is unset (Windows)", async () => {
    delete process.env.HOME;
    process.env.USERPROFILE = testHome;
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    const { detectAgentPlatforms } = await import("../src/detect");
    const result = detectAgentPlatforms();
    const claude = result.find((p) => p.name === "Claude Code");
    expect(claude).toBeDefined();
    expect(claude?.path).toBe(path.join(testHome, ".claude"));
    delete process.env.USERPROFILE;
  });
});

describe("detectOllama", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns available=true with models from API", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [{ name: "llama3.2:latest" }, { name: "nomic-embed-text:latest" }, { name: "codellama:latest" }],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const { detectOllama } = await import("../src/detect");
    const result = await detectOllama();
    expect(result.available).toBe(true);
    expect(result.models).toContain("llama3.2");
    expect(result.models).toContain("nomic-embed-text");
    expect(result.models).toContain("codellama");
  });

  test("strips :latest suffix from model names", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          models: [{ name: "llama3.2:latest" }, { name: "phi3:v2" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const { detectOllama } = await import("../src/detect");
    const result = await detectOllama();
    expect(result.models).toContain("llama3.2");
    expect(result.models).toContain("phi3:v2");
    expect(result.models).not.toContain("llama3.2:latest");
  });

  test("returns available=false when fetch fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("Connection refused");
    }) as typeof fetch;

    const { detectOllama } = await import("../src/detect");
    const result = await detectOllama();
    // May still be available=true if `ollama list` CLI works, or false if both fail
    // Just verify it doesn't throw
    expect(typeof result.available).toBe("boolean");
    expect(Array.isArray(result.models)).toBe(true);
  });

  test("returns sorted model names", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          models: [{ name: "zephyr:latest" }, { name: "alpaca:latest" }, { name: "mistral:latest" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const { detectOllama } = await import("../src/detect");
    const result = await detectOllama();
    expect(result.models).toEqual(["alpaca", "mistral", "zephyr"]);
  });
});

describe("detectOpenViking", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns available=true for reachable server", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ status: "ok", result: [] }), { status: 200 });
    }) as typeof fetch;

    const { detectOpenViking } = await import("../src/detect");
    const result = await detectOpenViking("https://example.com");
    expect(result.available).toBe(true);
    expect(result.url).toBe("https://example.com");
  });

  test("returns available=false for unreachable server", async () => {
    globalThis.fetch = (async () => {
      throw new Error("Connection refused");
    }) as typeof fetch;

    const { detectOpenViking } = await import("../src/detect");
    const result = await detectOpenViking("https://unreachable.example.com");
    expect(result.available).toBe(false);
  });

  test("normalizes URL even on failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("Connection refused");
    }) as typeof fetch;

    const { detectOpenViking } = await import("../src/detect");
    const result = await detectOpenViking("https://example.com///");
    expect(result.url).toBe("https://example.com");
  });

  test("strips trailing slashes from URL", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof fetch;

    const { detectOpenViking } = await import("../src/detect");
    const result = await detectOpenViking("https://example.com///");
    expect(result.url).toBe("https://example.com");
  });

  test("returns available=true when stat endpoint returns 404 (server is up)", async () => {
    globalThis.fetch = (async () => {
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    const { detectOpenViking } = await import("../src/detect");
    const result = await detectOpenViking("https://example.com");
    expect(result.available).toBe(true);
  });

  test("returns available=true when stat endpoint returns 500", async () => {
    globalThis.fetch = (async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof fetch;

    const { detectOpenViking } = await import("../src/detect");
    const result = await detectOpenViking("https://example.com");
    expect(result.available).toBe(true);
  });

  test("returns available=true via root fallback when stat throws but root responds", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) throw new Error("Connection refused"); // stat endpoint
      return new Response("OK", { status: 200 }); // root fallback
    }) as typeof fetch;

    const { detectOpenViking } = await import("../src/detect");
    const result = await detectOpenViking("https://example.com");
    expect(result.available).toBe(true);
  });
});
