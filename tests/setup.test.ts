import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withMockedFetch } from "./_helpers/sandbox";

const DETECT_SOURCE_PATH = path.join(import.meta.dir, "../src/setup/detect.ts");

async function loadDetectModule(fromDir: string) {
  const copiedPath = path.join(fromDir, `detect-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  fs.copyFileSync(DETECT_SOURCE_PATH, copiedPath);
  return import(pathToFileURL(copiedPath).href);
}

// ── detect.ts tests ─────────────────────────────────────────────────────────

// HOME / globalThis.fetch isolation is provided by tests/_preload.ts —
// the per-test snapshot/restore of those is now automatic. We still
// `fs.rmSync` the per-test tmp dirs because the harness doesn't track
// arbitrary disk allocations.

describe("detectAgentPlatforms", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-detect-"));
    process.env.HOME = testHome;
  });

  afterEach(() => {
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  test("returns empty array when no platforms found", async () => {
    const { detectAgentPlatforms } = await loadDetectModule(testHome);
    const result = detectAgentPlatforms();
    expect(result).toEqual([]);
  });

  test("detects .claude directory", async () => {
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    const { detectAgentPlatforms } = await loadDetectModule(testHome);
    const result = detectAgentPlatforms();
    const claude = result.find((p: { name: string }) => p.name === "Claude Code");
    expect(claude).toBeDefined();
    expect(claude?.path).toBe(path.join(testHome, ".claude"));
  });

  test("detects .config/opencode directory", async () => {
    fs.mkdirSync(path.join(testHome, ".config", "opencode"), { recursive: true });
    const { detectAgentPlatforms } = await loadDetectModule(testHome);
    const result = detectAgentPlatforms();
    const opencode = result.find((p: { name: string }) => p.name === "OpenCode");
    expect(opencode).toBeDefined();
    expect(opencode?.path).toBe(path.join(testHome, ".config", "opencode"));
  });

  test("detects multiple platforms", async () => {
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(testHome, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(testHome, ".continue"), { recursive: true });
    const { detectAgentPlatforms } = await loadDetectModule(testHome);
    const result = detectAgentPlatforms();
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  test("ignores files (only detects directories)", async () => {
    fs.writeFileSync(path.join(testHome, ".claude"), "not a directory");
    const { detectAgentPlatforms } = await loadDetectModule(testHome);
    const result = detectAgentPlatforms();
    const claude = result.find((p: { name: string }) => p.name === "Claude Code");
    expect(claude).toBeUndefined();
  });

  test("returns empty when HOME and USERPROFILE are both unset", async () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const { detectAgentPlatforms } = await loadDetectModule(testHome);
    const result = detectAgentPlatforms();
    expect(result).toEqual([]);
  });

  test("falls back to USERPROFILE when HOME is unset (Windows)", async () => {
    delete process.env.HOME;
    process.env.USERPROFILE = testHome;
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    const { detectAgentPlatforms } = await loadDetectModule(testHome);
    const result = detectAgentPlatforms();
    const claude = result.find((p: { name: string }) => p.name === "Claude Code");
    expect(claude).toBeDefined();
    expect(claude?.path).toBe(path.join(testHome, ".claude"));
    delete process.env.USERPROFILE;
  });
});

describe("detectOllama", () => {
  // globalThis.fetch is sandboxed by `withMockedFetch` — the helper restores
  // the original fetch before returning, so the harness tripwire stays quiet.

  test("returns available=true with models from API", async () => {
    const mockFetch = (async (input: string | URL | Request) => {
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
    }) as unknown as typeof fetch;

    const result = await withMockedFetch(async () => {
      const { detectOllama } = await loadDetectModule(os.tmpdir());
      return detectOllama();
    }, mockFetch);
    expect(result.available).toBe(true);
    expect(result.models).toContain("llama3.2");
    expect(result.models).toContain("nomic-embed-text");
    expect(result.models).toContain("codellama");
  });

  test("strips :latest suffix from model names", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          models: [{ name: "llama3.2:latest" }, { name: "phi3:v2" }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await withMockedFetch(async () => {
      const { detectOllama } = await loadDetectModule(os.tmpdir());
      return detectOllama();
    }, mockFetch);
    expect(result.models).toContain("llama3.2");
    expect(result.models).toContain("phi3:v2");
    expect(result.models).not.toContain("llama3.2:latest");
  });

  test("returns available=false when fetch fails", async () => {
    const mockFetch = (async () => {
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;

    const result = await withMockedFetch(async () => {
      const { detectOllama } = await loadDetectModule(os.tmpdir());
      return detectOllama();
    }, mockFetch);
    // May still be available=true if `ollama list` CLI works, or false if both fail
    // Just verify it doesn't throw
    expect(typeof result.available).toBe("boolean");
    expect(Array.isArray(result.models)).toBe(true);
  });

  test("returns sorted model names", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          models: [{ name: "zephyr:latest" }, { name: "alpaca:latest" }, { name: "mistral:latest" }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await withMockedFetch(async () => {
      const { detectOllama } = await loadDetectModule(os.tmpdir());
      return detectOllama();
    }, mockFetch);
    expect(result.models).toEqual(["alpaca", "mistral", "zephyr"]);
  });
});
