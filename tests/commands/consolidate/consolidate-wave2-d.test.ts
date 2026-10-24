/**
 * Wave-2 QA fixes tests — Cluster D (errors, exit codes, hint text).
 *
 * #8  — hint field rendered in error output (already working; regression guard).
 * #13 — UsageError exits 2, ConfigError exits 78, NotFoundError exits 1.
 * #15 — `akm show foo` (malformed ref) throws UsageError/MISSING_REQUIRED_ARGUMENT.
 * #16 — `config set sources <bad>` says "sources" not "stashes".
 * #27 — clone missing asset: user-facing message, no "Stash type root" leakage.
 * #38 — deprecation hints reference real commands.
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

// #13's "error class exit-code classification" describe block was DELETED
// here (D2, Phase 2 triage): all 4 tests asserted only `err.name` and
// `instanceof` — tautologies over JS class semantics ("a UsageError is an
// instanceof UsageError") that can never fail regardless of what exit code
// the CLI actually emits. Real coverage of the exit-code mapping lives in
// tests/cli/exit-code-classification.test.ts:60-99, which drives the actual
// `emitJsonError` seam and asserts the real process.exitCode values (2 / 78 /
// 1 / 70).

// ── #8: hint field rendered ───────────────────────────────────────────────────

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
    // Wave C added a default hint for ASSET_NOT_FOUND pointing at search/index.
    expect(err.hint()).toContain("akm search");
  });

  test("NotFoundError with explicit hint returns it", () => {
    const err = new NotFoundError("not found", "ASSET_NOT_FOUND", "run akm init");
    expect(err.hint()).toBe("run akm init");
  });
});

// ── #16: config set sources error message says "sources" ─────────────────────
//
// R-063 #5: previously exercised via `parseConfigValue`, a compatibility
// shim removed as dead code (zero production callers) — see the note in
// tests/config-cli.test.ts. `setConfigValue` is the live implementation
// backing `akm config set`.

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
    // Post-rewrite: Zod uses dotted indexing in error paths. The original pin
    // used `sources`, which the 0.9.0 bundles cutover retired outright; the
    // surviving `registries` array key exercises the same error-path shape.
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

// ── #27: source-resolve user-facing error messages ───────────────────────────

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
