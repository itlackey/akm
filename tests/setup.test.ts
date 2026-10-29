import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { type Cleanup, sandboxHome } from "./_helpers/sandbox";

// ── detect.ts tests ─────────────────────────────────────────────────────────

describe("detectAgentPlatforms", () => {
  let testHome: string;
  let envCleanup: Cleanup = () => {};

  beforeEach(() => {
    const homeResult = sandboxHome();
    testHome = homeResult.dir;
    envCleanup = homeResult.cleanup;
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
  });

  test("returns empty array when no platforms found", async () => {
    const { detectAgentPlatforms } = await import("../src/setup/detect");
    const result = detectAgentPlatforms();
    expect(result).toEqual([]);
  });

  test("detects .claude directory", async () => {
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    // Re-import to pick up fresh HOME
    const { detectAgentPlatforms } = await import("../src/setup/detect");
    const result = detectAgentPlatforms();
    const claude = result.find((p) => p.name === "Claude Code");
    expect(claude).toBeDefined();
    expect(claude?.path).toBe(path.join(testHome, ".claude"));
  });

  test("detects .config/opencode directory", async () => {
    fs.mkdirSync(path.join(testHome, ".config", "opencode"), { recursive: true });
    const { detectAgentPlatforms } = await import("../src/setup/detect");
    const result = detectAgentPlatforms();
    const opencode = result.find((p) => p.name === "OpenCode");
    expect(opencode).toBeDefined();
    expect(opencode?.path).toBe(path.join(testHome, ".config", "opencode"));
  });

  test("detects multiple session-log-capable platforms", async () => {
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(testHome, ".config", "opencode"), { recursive: true });
    const { detectAgentPlatforms } = await import("../src/setup/detect");
    const result = detectAgentPlatforms();
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual(["Claude Code", "OpenCode"]);
  });

  // #567 — detection-trap fix. The old AGENT_PLATFORMS list offered four
  // harnesses with no session-log provider (Continue, Codeium/Windsurf, Cursor,
  // Codex CLI). Selecting them added a stash source that was never indexed — a
  // silent no-op. detectAgentPlatforms now derives only from
  // SESSION_LOG_HARNESSES, so those config dirs are NOT offered even when present.
  // Codex has since gained a session-log provider but declares no
  // `setupDetectionDir` (`~/.codex` holds credentials and rollouts, not assets),
  // so it stays unoffered.
  test("does NOT offer harnesses with no setup detection dir (Continue/Codeium/Cursor/Codex)", async () => {
    fs.mkdirSync(path.join(testHome, ".continue"), { recursive: true });
    fs.mkdirSync(path.join(testHome, ".codeium"), { recursive: true });
    fs.mkdirSync(path.join(testHome, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(testHome, ".codex"), { recursive: true });
    const { detectAgentPlatforms } = await import("../src/setup/detect");
    const result = detectAgentPlatforms();
    // None of the dead-option dirs surface as candidates.
    expect(result).toEqual([]);
  });

  // The candidate list must equal the session-log-capable harnesses that
  // declare a setup detection dir — the registry is the single source.
  test("offered platforms equal SESSION_LOG_HARNESSES with a setupDetectionDir", async () => {
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(testHome, ".config", "opencode"), { recursive: true });
    fs.mkdirSync(path.join(testHome, ".cursor"), { recursive: true });
    const { detectAgentPlatforms } = await import("../src/setup/detect");
    const { SESSION_LOG_HARNESSES } = await import("../src/integrations/harnesses");
    const expected = SESSION_LOG_HARNESSES.filter((h) => h.setupDetectionDir)
      .map((h) => h.displayName)
      .sort();
    const got = detectAgentPlatforms()
      .map((p) => p.name)
      .sort();
    expect(got).toEqual(expected);
  });

  test("ignores files (only detects directories)", async () => {
    fs.writeFileSync(path.join(testHome, ".claude"), "not a directory");
    const { detectAgentPlatforms } = await import("../src/setup/detect");
    const result = detectAgentPlatforms();
    const claude = result.find((p) => p.name === "Claude Code");
    expect(claude).toBeUndefined();
  });

  // ISOLATION-01/02: USERPROFILE is not one of the AKM_*/XDG_*/HOME vars
  // tests/_preload.ts owns (HARNESSED + the leak tripwire only cover those
  // prefixes), so mutating it here relies entirely on this file restoring it
  // itself — including on assertion failure, where a bare `delete` at the end
  // of the test body would never run. Snapshot + restore in try/finally.
  test("returns empty when HOME and USERPROFILE are both unset", async () => {
    const originalUserProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    try {
      const { detectAgentPlatforms } = await import("../src/setup/detect");
      const result = detectAgentPlatforms();
      expect(result).toEqual([]);
    } finally {
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  test("falls back to USERPROFILE when HOME is unset (Windows)", async () => {
    const originalUserProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    process.env.USERPROFILE = testHome;
    try {
      fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
      const { detectAgentPlatforms } = await import("../src/setup/detect");
      const result = detectAgentPlatforms();
      const claude = result.find((p) => p.name === "Claude Code");
      expect(claude).toBeDefined();
      expect(claude?.path).toBe(path.join(testHome, ".claude"));
    } finally {
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });
});
