/**
 * Tests for issue #511: safe-by-default `akm setup` config management.
 *
 * Covers the three non-interactive write paths (`runSetupFromConfig` and
 * `runSetupWithDefaults`) and their merge / backup guarantees:
 *   - `--file` / `--config` deep-merge: a partial input only updates the keys
 *     it carries and never drops sibling subkeys.
 *   - `--yes` idempotency: running N times == running once (fill-missing-only,
 *     never overwrite an existing value).
 *   - `--yes --file`: deep-merge plus defaults-fill, no prompts.
 *   - no pre-existing key is silently dropped in any mode.
 *   - a real (timestamped) backup is taken when a config already exists.
 *
 * Each test drives the setup functions directly inside an isolated XDG sandbox
 * so config reads/writes/backups land in temp dirs, never the host config.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { resetConfigCache } from "../../src/core/config";
import { getConfigPath } from "../../src/core/paths";
import { runSetupFromConfig, runSetupWithDefaults } from "../../src/setup/setup";
import {
  type Cleanup,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
  writeSandboxConfig,
} from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  // Chain isolated XDG dirs so config (write), cache (backups), data & state
  // all resolve into temp dirs for the duration of the test.
  const cfg = sandboxXdgConfigHome();
  const cache = sandboxXdgCacheHome(cfg.cleanup);
  const data = sandboxXdgDataHome(cache.cleanup);
  const state = sandboxXdgStateHome(data.cleanup);
  cleanup = state.cleanup;
  resetConfigCache();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function readWrittenConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
}

function backupDir(): string {
  return path.join(process.env.XDG_CACHE_HOME as string, "akm", "config-backups");
}

/** A fully-populated, persistent (non-transient) starting config. */
function seedFullConfig(): void {
  writeSandboxConfig({
    stashDir: "/home/tester/akm",
    semanticSearchMode: "off",
    output: { format: "json", detail: "full" },
    profiles: { agent: { claude: { platform: "claude", bin: "claude" } } },
    defaults: { agent: "claude" },
    sources: [{ path: "/home/tester/akm/skills", type: "filesystem" }],
    registries: [{ name: "default", url: "https://example.com/registry" }],
  });
  // writeSandboxConfig writes straight to disk, bypassing saveConfig's cache
  // invalidation — drop the cache so loadUserConfig re-reads the seed.
  resetConfigCache();
}

describe("runSetupFromConfig — deep merge", () => {
  test("partial --file updates a nested key but preserves sibling subkeys", async () => {
    seedFullConfig();

    await runSetupFromConfig({
      configJson: JSON.stringify({ output: { format: "text" } }),
      noInit: true,
    });

    const written = readWrittenConfig();
    const output = written.output as Record<string, unknown>;
    // The updated subkey changed...
    expect(output.format).toBe("text");
    // ...but its sibling survived (the bug this fixes: shallow replace dropped it).
    expect(output.detail).toBe("full");
    // And unrelated top-level keys are untouched.
    expect(written.profiles).toEqual({ agent: { claude: { platform: "claude", bin: "claude" } } });
    expect(written.defaults).toEqual({ agent: "claude" });
    expect(written.sources).toEqual([{ path: "/home/tester/akm/skills", type: "filesystem" }]);
    expect(written.registries).toEqual([{ name: "default", url: "https://example.com/registry" }]);
  });

  test("--config follows the identical deep-merge semantics as --file", async () => {
    seedFullConfig();

    // --config and --file share runSetupFromConfig; this asserts the JSON-blob
    // path deep-merges too (sibling subkey survives).
    await runSetupFromConfig({
      configJson: JSON.stringify({ output: { detail: "brief" } }),
      noInit: true,
    });

    const output = readWrittenConfig().output as Record<string, unknown>;
    expect(output.detail).toBe("brief");
    expect(output.format).toBe("json");
  });

  test("nested profiles merge key-by-key (sibling agent profile survives)", async () => {
    seedFullConfig();

    // Adding a second agent profile must not drop the seeded `claude` profile.
    await runSetupFromConfig({
      configJson: JSON.stringify({
        profiles: { agent: { opencode: { platform: "opencode", bin: "opencode" } } },
      }),
      noInit: true,
    });

    const profiles = readWrittenConfig().profiles as { agent: Record<string, unknown> };
    expect(profiles.agent.claude).toEqual({ platform: "claude", bin: "claude" });
    expect(profiles.agent.opencode).toEqual({ platform: "opencode", bin: "opencode" });
  });

  test("an empty --config drops no pre-existing key", async () => {
    seedFullConfig();
    const before = readWrittenConfig();

    await runSetupFromConfig({ configJson: "{}", noInit: true });

    const after = readWrittenConfig();
    for (const key of Object.keys(before)) {
      expect(after[key]).toEqual(before[key]);
    }
  });
});

describe("runSetupFromConfig — backup guarantees", () => {
  test("creates a real timestamped backup when a config already exists", async () => {
    seedFullConfig();

    const result = await runSetupFromConfig({
      configJson: JSON.stringify({ output: { format: "text" } }),
      noInit: true,
    });
    expect(result.written).toBe(true);

    const entries = fs.readdirSync(backupDir());
    expect(entries.some((n) => /^config-.*\.json$/.test(n) && n !== "config.latest.json")).toBe(true);
    expect(entries).toContain("config.latest.json");
  });
});

describe("runSetupFromConfig — --yes (applyDefaults) deep-merge + fill", () => {
  test("deep-merges the file and leaves non-file keys untouched", async () => {
    seedFullConfig();

    await runSetupFromConfig({
      configJson: JSON.stringify({ output: { format: "text" } }),
      noInit: true,
      applyDefaults: true,
    });

    const written = readWrittenConfig();
    const output = written.output as Record<string, unknown>;
    expect(output.format).toBe("text");
    expect(output.detail).toBe("full");
    // Existing values preserved; defaults only fill what was missing.
    expect(written.stashDir).toBe("/home/tester/akm");
    expect(written.defaults).toEqual({ agent: "claude" });
  });
});

describe("runSetupWithDefaults — idempotency", () => {
  test("preserves every existing value and is idempotent across runs", async () => {
    seedFullConfig();

    await runSetupWithDefaults({ noInit: true });
    const first = fs.readFileSync(getConfigPath(), "utf8");

    await runSetupWithDefaults({ noInit: true });
    const second = fs.readFileSync(getConfigPath(), "utf8");

    // Idempotency contract: running N times == running once. Detection
    // (#514) may legitimately inject profiles (e.g. a live local LLM), so the
    // first run is not a no-op — but the SECOND run must add/change nothing.
    // Compare structurally rather than byte-for-byte: JSON object key
    // insertion order is not part of the config's identity, and the apply
    // helpers can reorder `profiles`/`defaults` keys without altering content.
    expect(JSON.parse(second)).toEqual(JSON.parse(first));

    // No pre-existing value was overwritten by a default.
    const written = JSON.parse(first) as Record<string, unknown>;
    expect(written.stashDir).toBe("/home/tester/akm");
    expect(written.output).toEqual({ format: "json", detail: "full" });
    expect(written.sources).toEqual([{ path: "/home/tester/akm/skills", type: "filesystem" }]);
    expect(written.registries).toEqual([{ name: "default", url: "https://example.com/registry" }]);
    // The pre-existing agent default must survive untouched. Detection (#514)
    // may ADD other defaults (e.g. an `llm` default when a live local server is
    // present on the host), but it must never overwrite the seeded `agent`.
    expect((written.defaults as Record<string, unknown>).agent).toBe("claude");
  });

  test("on a fresh install writes config and takes no backup", async () => {
    // No seed: no config on disk yet.
    expect(fs.existsSync(getConfigPath())).toBe(false);

    const result = await runSetupWithDefaults({ noInit: true });
    expect(result.written).toBe(true);
    expect(fs.existsSync(getConfigPath())).toBe(true);

    // Nothing to back up on a fresh install → no backup files written.
    expect(fs.existsSync(backupDir())).toBe(false);
  });
});
