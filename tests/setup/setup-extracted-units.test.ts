// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Direct unit tests for the pure functions extracted out of the setup
 * monolith during the setup.ts decomposition:
 *   - `deepMergeConfig` / `isPlainObject`  (src/core/config/deep-merge.ts)
 *   - the setup context's `replace`          (src/setup/steps.ts)
 *
 * These functions are now independently importable; the point of the move was
 * to make them testable without driving the whole wizard.
 */

import { describe, expect, test } from "bun:test";
import { deepMergeConfig, isPlainObject } from "../../src/core/config/deep-merge";
import { createSetupContext } from "../../src/setup/steps";

describe("deepMergeConfig", () => {
  test("merges nested plain objects key-by-key, preserving sibling subkeys", () => {
    const base = { output: { format: "json", detail: "brief" }, bundles: { local: { path: "/a" } } };
    const merged = deepMergeConfig(base, { output: { format: "text" } });
    expect(merged).toEqual({ output: { format: "text", detail: "brief" }, bundles: { local: { path: "/a" } } });
  });

  test("arrays replace wholesale (no element merge)", () => {
    const base = { registries: [{ url: "https://a.test" }, { url: "https://b.test" }] };
    const merged = deepMergeConfig(base, { registries: [{ url: "https://c.test" }] });
    expect(merged).toEqual({ registries: [{ url: "https://c.test" }] });
  });

  test("scalars replace and undefined values are skipped", () => {
    const base = { a: 1, b: 2 };
    const merged = deepMergeConfig(base, { a: 9, b: undefined });
    expect(merged).toEqual({ a: 9, b: 2 });
  });

  test("does not mutate the base object graph", () => {
    const base: Record<string, unknown> = { nested: { keep: true } };
    const merged = deepMergeConfig(base, { nested: { added: 1 } });
    expect(base).toEqual({ nested: { keep: true } });
    expect(merged).toEqual({ nested: { keep: true, added: 1 } });
  });

  test("scalar values replace at their configured key", () => {
    expect(deepMergeConfig({ a: 1 }, { a: 5 })).toEqual({ a: 5 });
  });

  test("isPlainObject rejects null and arrays", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });

  test("rejects prototype-pollution keys at every depth", () => {
    expect(() => deepMergeConfig({}, JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(/Unsafe/);
    expect(() => deepMergeConfig({}, { safe: JSON.parse('{"constructor":{"prototype":{"x":1}}}') })).toThrow(/Unsafe/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("setup context", () => {
  test("apply merges a delta into the accumulated config", () => {
    const ctx = createSetupContext(
      { semanticSearchMode: "off", output: { format: "json", detail: "brief" } },
      { nonInteractive: true },
    );
    ctx.apply({ output: { format: "text" } } as never);
    expect(ctx.config.output).toEqual({ format: "text", detail: "brief" });
  });

  test("replace sets a key wholesale, so an entry the user removed is gone, and deletes a key given undefined", () => {
    const ctx = createSetupContext(
      { semanticSearchMode: "off", harnesses: { claude: {}, codex: {} }, embedding: { model: "m" } },
      { nonInteractive: true },
    );
    ctx.replace({ harnesses: { claude: {} }, embedding: undefined });
    expect(ctx.config.harnesses).toEqual({ claude: {} });
    expect("embedding" in ctx.config).toBe(false);
    expect(ctx.config.semanticSearchMode).toBe("off");
  });
});
