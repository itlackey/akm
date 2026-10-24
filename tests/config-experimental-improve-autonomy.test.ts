// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D8 — the `experimental.improveAutonomy` opt-in key.
 *
 * Before D8 this key was documented but did not exist: it was absent from the
 * schema, read nowhere in the runtime, and `akm config set
 * experimental.improveAutonomy true` failed with `Unknown config key`. The
 * documentation therefore inverted the safety posture — an operator could read
 * that autonomy required an opt-in, never set the key, and conclude they were
 * review-first while consolidate was deleting files.
 *
 * These pin the key's existence and its default. The gating behaviour itself is
 * pinned by `tests/integration/improve-autonomy-gate.test.ts`, which asserts on
 * the filesystem rather than on this flag.
 */

import { describe, expect, test } from "bun:test";
import { AkmConfigSchema } from "../src/core/config/config-schema";
import { isImproveAutonomyEnabled } from "../src/core/config/experimental";

const BASE = { configVersion: "0.9.0" as const };

describe("experimental.improveAutonomy schema", () => {
  test("accepts the key and round-trips true", () => {
    const parsed = AkmConfigSchema.parse({ ...BASE, experimental: { improveAutonomy: true } });
    expect(parsed.experimental?.improveAutonomy).toBe(true);
  });

  test("accepts the key set to false", () => {
    const parsed = AkmConfigSchema.parse({ ...BASE, experimental: { improveAutonomy: false } });
    expect(parsed.experimental?.improveAutonomy).toBe(false);
  });

  test("rejects a non-boolean value rather than coercing it", () => {
    expect(() => AkmConfigSchema.parse({ ...BASE, experimental: { improveAutonomy: "yes" } })).toThrow();
  });

  test("the whole section is optional", () => {
    expect(() => AkmConfigSchema.parse(BASE)).not.toThrow();
  });
});

describe("isImproveAutonomyEnabled", () => {
  test("is OFF when the section is absent — autonomy is opt-in, never inferred", () => {
    expect(isImproveAutonomyEnabled({})).toBe(false);
  });

  test("is OFF when the section exists but the key does not", () => {
    expect(isImproveAutonomyEnabled({ experimental: {} })).toBe(false);
  });

  test("is OFF when explicitly false", () => {
    expect(isImproveAutonomyEnabled({ experimental: { improveAutonomy: false } })).toBe(false);
  });

  test("is ON only when explicitly true", () => {
    expect(isImproveAutonomyEnabled({ experimental: { improveAutonomy: true } })).toBe(true);
  });
});
