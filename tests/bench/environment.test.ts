/**
 * Tests for environment.ts — writeOpencodeJson, validateFixtureCorpus,
 * BENCH_OPENCODE_INVARIANTS, and setupBenchEnvironment (dryRun mode).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  BENCH_OPENCODE_INVARIANTS,
  BUILTIN_CLOUD_PREFIXES,
  setupBenchEnvironment,
  validateFixtureCorpus,
  writeOpencodeJson,
} from "./environment";
import type { LoadedOpencodeProviders } from "./opencode-config";
import { benchMkdtemp } from "./tmp";

// ── writeOpencodeJson ────────────────────────────────────────────────────────

describe("writeOpencodeJson", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = benchMkdtemp("bench-env-test-");
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("always writes plugin:[] and permission block (isolation invariants)", () => {
    const dir = path.join(tmp, "invariants");
    fs.mkdirSync(dir, { recursive: true });

    writeOpencodeJson(dir, "anthropic/claude-opus-4-7");

    const config = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(config.plugin).toEqual([]);
    expect((config.permission as Record<string, unknown>)?.bash).toBe("allow");
    expect((config.permission as Record<string, unknown>)?.edit).toBe("allow");
    expect((config.permission as Record<string, unknown>)?.write).toBe("allow");
  });

  test("writes provider block when model resolves in providers map", () => {
    const dir = path.join(tmp, "with-provider");
    fs.mkdirSync(dir, { recursive: true });

    const providers: LoadedOpencodeProviders = {
      source: "/fake/providers.json",
      providers: { myprov: { npm: "@ai-sdk/openai-compatible", name: "My Provider" } },
    };

    const result = writeOpencodeJson(dir, "myprov/my-model", providers);
    expect(result.providerKey).toBe("myprov");
    expect(result.warnings).toHaveLength(0);

    const config = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8")) as Record<string, unknown>;
    expect((config.provider as Record<string, unknown>)?.myprov).toBeDefined();
    expect(config.model).toBe("myprov/my-model");
  });

  test("writes stub (no provider block) and returns warning for built-in cloud model not in providers map", () => {
    const dir = path.join(tmp, "cloud-stub");
    fs.mkdirSync(dir, { recursive: true });

    const providers: LoadedOpencodeProviders = {
      source: "/fake/providers.json",
      providers: { otherprov: {} },
    };

    const result = writeOpencodeJson(dir, "opencode/big-pickle", providers);
    expect(result.providerKey).toBeUndefined();
    expect(result.warnings.length).toBeGreaterThan(0);

    const config = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(config.provider).toBeUndefined();
    // Invariants still present.
    expect(config.plugin).toEqual([]);
  });

  test("mode 0o600 (not world-readable)", () => {
    const dir = path.join(tmp, "mode-check");
    fs.mkdirSync(dir, { recursive: true });

    writeOpencodeJson(dir, "anthropic/claude-opus-4-7");

    const stat = fs.statSync(path.join(dir, "opencode.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ── BENCH_OPENCODE_INVARIANTS ────────────────────────────────────────────────

describe("BENCH_OPENCODE_INVARIANTS", () => {
  test("plugin is an empty readonly array", () => {
    expect(BENCH_OPENCODE_INVARIANTS.plugin).toEqual([]);
    expect(Array.isArray(BENCH_OPENCODE_INVARIANTS.plugin)).toBe(true);
  });

  test("permission.bash is 'allow'", () => {
    expect(BENCH_OPENCODE_INVARIANTS.permission.bash).toBe("allow");
  });
});

// ── BUILTIN_CLOUD_PREFIXES ───────────────────────────────────────────────────

describe("BUILTIN_CLOUD_PREFIXES", () => {
  test("includes anthropic, openai, opencode", () => {
    expect(BUILTIN_CLOUD_PREFIXES.has("anthropic")).toBe(true);
    expect(BUILTIN_CLOUD_PREFIXES.has("openai")).toBe(true);
    expect(BUILTIN_CLOUD_PREFIXES.has("opencode")).toBe(true);
  });

  test("does not include custom provider prefixes like 'shredder' or 'don'", () => {
    expect(BUILTIN_CLOUD_PREFIXES.has("shredder")).toBe(false);
    expect(BUILTIN_CLOUD_PREFIXES.has("don")).toBe(false);
  });
});

// ── validateFixtureCorpus ────────────────────────────────────────────────────

describe("validateFixtureCorpus", () => {
  test("returns known fixtures as valid", () => {
    const tasks = [{ id: "az-cli/foo", stash: "az-cli" }];
    const { valid, missing } = validateFixtureCorpus(tasks);
    expect(valid.has("az-cli")).toBe(true);
    expect(missing.size).toBe(0);
  });

  test("returns nonexistent fixture as missing with its task IDs", () => {
    const tasks = [
      { id: "ghost/task-1", stash: "ghost-fixture" },
      { id: "ghost/task-2", stash: "ghost-fixture" },
    ];
    const { valid, missing } = validateFixtureCorpus(tasks);
    expect(valid.has("ghost-fixture")).toBe(false);
    expect(missing.has("ghost-fixture")).toBe(true);
    expect(missing.get("ghost-fixture")).toEqual(["ghost/task-1", "ghost/task-2"]);
  });

  test("handles empty task list", () => {
    const { valid, missing } = validateFixtureCorpus([]);
    expect(valid.size).toBe(0);
    expect(missing.size).toBe(0);
  });

  test("deduplicates fixture names across tasks", () => {
    const tasks = [
      { id: "az-cli/a", stash: "az-cli" },
      { id: "az-cli/b", stash: "az-cli" },
      { id: "az-cli/c", stash: "az-cli" },
    ];
    const { valid } = validateFixtureCorpus(tasks);
    expect(valid.size).toBe(1);
  });
});

// ── setupBenchEnvironment (dryRun) ───────────────────────────────────────────

describe("setupBenchEnvironment dryRun", () => {
  test("creates isolation dirs and writes opencode.json with invariants", () => {
    const env = setupBenchEnvironment({
      model: "anthropic/claude-opus-4-7",
      arm: "akm",
      dryRun: true,
    });

    try {
      expect(fs.existsSync(env.dirs.cacheHome)).toBe(true);
      expect(fs.existsSync(env.dirs.configHome)).toBe(true);
      expect(fs.existsSync(env.dirs.opencodeConfig)).toBe(true);

      const config = JSON.parse(fs.readFileSync(path.join(env.dirs.opencodeConfig, "opencode.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(config.plugin).toEqual([]);
      expect((config.permission as Record<string, unknown>)?.bash).toBe("allow");
    } finally {
      env.teardown();
    }
  });

  test("throws for custom provider prefix without providers config", () => {
    expect(() =>
      setupBenchEnvironment({
        model: "shredder/qwen/qwen3.5-9b",
        arm: "akm",
        dryRun: true,
      }),
    ).toThrow(/custom provider prefix/);
  });

  test("synthetic arm never sets AKM_STASH_DIR", () => {
    const env = setupBenchEnvironment({
      model: "anthropic/claude-opus-4-7",
      arm: "synthetic",
      stashDir: "/some/stash",
      dryRun: true,
    });
    try {
      expect(env.env.AKM_STASH_DIR).toBeUndefined();
    } finally {
      env.teardown();
    }
  });

  test("teardown removes the isolation dirs", () => {
    const env = setupBenchEnvironment({
      model: "anthropic/claude-opus-4-7",
      arm: "akm",
      dryRun: true,
    });
    const { root } = env.dirs;
    expect(fs.existsSync(root)).toBe(true);
    env.teardown();
    expect(fs.existsSync(root)).toBe(false);
  });
});
