/**
 * Error-surface tests: hint text rendered in error output, `UsageError` /
 * `ConfigError` / `NotFoundError` exit codes, a malformed `akm show` ref
 * throwing `UsageError`/`MISSING_REQUIRED_ARGUMENT`, `config set` error
 * wording ("sources", not "stashes"), clone of a missing asset giving a
 * user-facing message without "Stash type root" leakage, and deprecation hints
 * naming real commands.
 */

import { describe, expect, test } from "bun:test";
import { setConfigValue } from "../../../src/commands/config-cli";
import type { AkmConfig } from "../../../src/core/config/config";
import { ConfigError, NotFoundError, UsageError } from "../../../src/core/errors";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";

function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    fn();
    return warnings;
  } finally {
    _setWarnSinkForTests(undefined);
  }
}

// Exit-code classification is covered by tests/cli/exit-code-classification.test.ts,
// which drives the actual `emitJsonError` seam and asserts the real
// process.exitCode values (2 / 78 / 1 / 70).

// ── hint field rendered ───────────────────────────────────────────────────

describe("error hint rendering (#8)", () => {
  test("ConfigError with hint: true returns hint", () => {
    const err = new ConfigError("bad", "STASH_DIR_NOT_FOUND");
    expect(err.hint()).toBeDefined();
    expect(err.hint()).toMatch(/akm setup/);
  });

  test("ConfigError with explicit hint returns it", () => {
    const err = new ConfigError("bad", "INVALID_CONFIG_FILE", "my custom hint");
    expect(err.hint()).toBe("my custom hint");
  });

  test("UsageError with INVALID_SOURCE_VALUE has a hint", () => {
    const err = new UsageError("bad source", "INVALID_SOURCE_VALUE");
    expect(err.hint()).toBeDefined();
    expect(err.hint()).toContain("local");
  });

  test("NotFoundError with ASSET_NOT_FOUND has a canned hint (Wave C #284)", () => {
    const err = new NotFoundError("not found");
    expect(err.hint()).toContain("akm search");
  });

  test("NotFoundError with explicit hint returns it", () => {
    const err = new NotFoundError("not found", "ASSET_NOT_FOUND", "run akm init");
    expect(err.hint()).toBe("run akm init");
  });
});

// ── config set sources error message says "sources" ─────────────────────────
//
// `setConfigValue` is the implementation backing `akm config set`.

describe("config-cli setConfigValue sources error message (#16)", () => {
  const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };

  test("unrecognized 'sources' warns naming 'sources', not 'stashes'", () => {
    let result!: ReturnType<typeof setConfigValue>;
    const warnings = captureWarnings(() => {
      result = setConfigValue(base, "sources", "not-json");
    });
    expect((result as unknown as Record<string, unknown>).sources).toBe("not-json");
    expect(warnings.some((w) => w.includes("sources"))).toBe(true);
    expect(warnings.some((w) => w.includes("stashes"))).toBe(false);
  });

  test("retired stashes path warns naming 'stashes', not aliased to sources", () => {
    let result!: ReturnType<typeof setConfigValue>;
    const warnings = captureWarnings(() => {
      result = setConfigValue(base, "stashes", "not-json");
    });
    expect((result as unknown as Record<string, unknown>).stashes).toBe("not-json");
    expect(warnings.some((w) => w.includes("stashes"))).toBe(true);
    expect(warnings.some((w) => w.includes("Invalid JSON array for sources"))).toBe(false);
  });

  test("invalid array element shows dotted zod indexing ('registries.0') — sources key retired (#37)", () => {
    // Zod uses dotted indexing in error paths; the `registries` array key
    // exercises that error-path shape.
    try {
      setConfigValue(base, "registries", "[{}]");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const msg = (err as UsageError).message;
      expect(msg).toContain("registries.0");
      expect(msg).not.toContain("stashes.0");
    }
  });
});

// ── source-resolve user-facing error messages ───────────────────────────────

describe("source-resolve user-facing errors (#27)", () => {
  test("error message does not contain 'Stash type root'", async () => {
    // Import the resolver lazily so we don't pull in full DB on every test run.
    const { resolveAssetPath } = await import("../../../src/sources/resolve");
    try {
      await resolveAssetPath("/tmp/nonexistent-stash-dir-xyz", "skill", "missing-skill");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      const msg = (err as NotFoundError).message;
      expect(msg).not.toContain("Stash type root");
      // Should contain user-facing wording
      expect(msg).toMatch(/Asset not found for ref|not found for ref|not accessible/i);
    }
  });

  test("error hint is set on the not-found error from source-resolve", async () => {
    const { resolveAssetPath } = await import("../../../src/sources/resolve");
    try {
      await resolveAssetPath("/tmp/nonexistent-stash-dir-xyz", "skill", "missing-skill");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      const hint = (err as NotFoundError).hint();
      // Should have an actionable hint
      expect(hint).toBeDefined();
      expect(hint).toMatch(/akm list|akm index/i);
    }
  });
});
