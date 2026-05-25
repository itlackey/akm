// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression suite for #486 — NO_COLOR / TTY-aware glyph stripping.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { plainize, shouldDecorate } from "../src/core/tty";

const ENV_KEYS = ["NO_COLOR", "FORCE_COLOR"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("shouldDecorate (#486)", () => {
  it("returns false when NO_COLOR is set to any value", () => {
    process.env.NO_COLOR = "1";
    expect(shouldDecorate()).toBe(false);
    process.env.NO_COLOR = "0"; // per spec: any presence disables
    expect(shouldDecorate()).toBe(false);
    process.env.NO_COLOR = "";
    expect(shouldDecorate()).toBe(false);
  });

  it("returns true when FORCE_COLOR is set even without a TTY", () => {
    process.env.FORCE_COLOR = "1";
    expect(shouldDecorate()).toBe(true);
  });

  it("FORCE_COLOR=0 does NOT force decoration", () => {
    process.env.FORCE_COLOR = "0";
    // Falls through to TTY detection — test runs without a TTY → false.
    expect(shouldDecorate()).toBe(false);
  });

  it("returns false when stderr is not a TTY and no override is set", () => {
    // bun test runs stderr as a non-TTY by default.
    expect(shouldDecorate()).toBe(false);
  });
});

describe("plainize (#486)", () => {
  it("returns input unchanged when decoration is enabled", () => {
    process.env.FORCE_COLOR = "1";
    expect(plainize("👋 First time with akm?")).toContain("👋");
    expect(plainize("✓ Stash created")).toContain("✓");
  });

  it("replaces known emoji with ASCII when decoration is disabled", () => {
    process.env.NO_COLOR = "1";
    expect(plainize("✓ Stash created")).toBe("[ok] Stash created");
    expect(plainize("✗ failed")).toBe("[x] failed");
    expect(plainize("⚠ heads up")).toBe("[!] heads up");
  });

  it("strips the wave emoji prefix on first-run banner", () => {
    process.env.NO_COLOR = "1";
    const result = plainize("👋 First time with akm?");
    expect(result).not.toContain("👋");
    expect(result).toContain("First time with akm?");
  });

  it("preserves indentation and newlines", () => {
    process.env.NO_COLOR = "1";
    const input = "\n✓ Stash created at /tmp/x\n  Next: akm add ...";
    const out = plainize(input);
    expect(out.startsWith("\n[ok]")).toBe(true);
    expect(out).toContain("\n  Next:");
  });

  it("removes unmapped pictographs via catch-all sweep", () => {
    process.env.NO_COLOR = "1";
    expect(plainize("🚀 launch")).not.toContain("🚀");
    expect(plainize("🚀 launch")).toContain("launch");
  });
});
