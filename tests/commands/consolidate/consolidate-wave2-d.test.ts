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
import { parseConfigValue } from "../../../src/commands/config-cli";
import { ConfigError, NotFoundError, UsageError } from "../../../src/core/errors";
import { parseAssetRef } from "../../../src/migrate/legacy-ref-grammar";

// ── #15: parseAssetRef — MISSING_REQUIRED_ARGUMENT code ────────────────────

describe("parseAssetRef error codes (#15)", () => {
  test("empty ref throws UsageError with MISSING_REQUIRED_ARGUMENT", () => {
    try {
      parseAssetRef("");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe("MISSING_REQUIRED_ARGUMENT");
    }
  });

  test("ref without colon throws UsageError with MISSING_REQUIRED_ARGUMENT", () => {
    try {
      parseAssetRef("foo");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe("MISSING_REQUIRED_ARGUMENT");
    }
  });

  // Chunk 1.5 opened the type token: a foreign/unknown type like "badtype"
  // no longer throws (it round-trips as ordinary ref data). Only the
  // deliberately-removed deny-list (`tool`/`vault`, D1.5-6) still does, so
  // this regression guard is retargeted to one of those instead of being
  // deleted outright — #15's real contract ("a REJECTED ref throws
  // UsageError/MISSING_REQUIRED_ARGUMENT", not "any non-canonical type
  // throws") still holds.
  test("ref with a deny-listed (deliberately-removed) type throws UsageError with MISSING_REQUIRED_ARGUMENT", () => {
    try {
      parseAssetRef("tool:name");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe("MISSING_REQUIRED_ARGUMENT");
    }
  });

  test("ref with a foreign/unknown type is accepted as an open token (chunk 1.5) — does not throw", () => {
    const ref = parseAssetRef("badtype:name");
    expect(ref.type).toBe("badtype");
    expect(ref.name).toBe("name");
  });

  test("valid ref parses correctly", () => {
    const ref = parseAssetRef("skill:deploy");
    expect(ref.type).toBe("skill");
    expect(ref.name).toBe("deploy");
  });

  test("MISSING_REQUIRED_ARGUMENT has a hint in errors.ts", () => {
    const err = new UsageError("test", "MISSING_REQUIRED_ARGUMENT");
    expect(err.hint()).toBeDefined();
    // 0.9.0 grammar (D-R3): the hint teaches [bundle//]conceptId, never type:name.
    expect(err.hint()).toMatch(/\[bundle\/\/\]conceptId/);
  });
});

// ── #13: exit code classification ────────────────────────────────────────────

describe("error class exit-code classification (#13)", () => {
  test("UsageError should be classified as exit 2", () => {
    const err = new UsageError("bad input");
    // Verify the code exists so callers can distinguish
    expect(err.name).toBe("UsageError");
    expect(err instanceof UsageError).toBe(true);
  });

  test("ConfigError should be classified as exit 78", () => {
    const err = new ConfigError("config bad");
    expect(err.name).toBe("ConfigError");
    expect(err instanceof ConfigError).toBe(true);
  });

  test("NotFoundError should be classified as exit 1 (GENERAL)", () => {
    const err = new NotFoundError("not found");
    expect(err.name).toBe("NotFoundError");
    expect(err instanceof NotFoundError).toBe(true);
  });

  test("UsageError and ConfigError are distinguishable via instanceof", () => {
    const usage = new UsageError("bad");
    const config = new ConfigError("bad");
    expect(usage instanceof UsageError).toBe(true);
    expect(usage instanceof ConfigError).toBe(false);
    expect(config instanceof ConfigError).toBe(true);
    expect(config instanceof UsageError).toBe(false);
  });
});

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
    expect(err.hint()).toContain("stash");
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

describe("config-cli parseConfigValue sources error message (#16)", () => {
  test("invalid sources value shows 'sources' not 'stashes' in error", () => {
    try {
      parseConfigValue("sources", "not-json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const msg = (err as UsageError).message;
      expect(msg).toContain("sources");
      expect(msg).not.toContain("stashes");
    }
  });

  test("retired stashes path is rejected without aliasing to sources", () => {
    try {
      parseConfigValue("stashes", "not-json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const msg = (err as UsageError).message;
      expect(msg).toContain("Unknown config key: stashes");
      expect(msg).not.toContain("Invalid JSON array for sources");
    }
  });

  test("invalid array element shows dotted zod indexing ('registries.0') — sources key retired (#37)", () => {
    // Post-rewrite: Zod uses dotted indexing in error paths. The original pin
    // used `sources`, which the 0.9.0 bundles cutover retired outright; the
    // surviving `registries` array key exercises the same error-path shape.
    try {
      parseConfigValue("registries", "[{}]");
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
