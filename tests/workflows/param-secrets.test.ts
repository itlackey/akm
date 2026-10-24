// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { detectSecretShapedParams } from "../../src/workflows/exec/param-secrets";

/**
 * PR #714 review round 2, #13 — best-effort secret-shaped-param detection.
 * Params are declared non-secret (hashed into every unit prompt, cannot be
 * redacted), so this is a WARN-only nudge toward env bindings. It must catch the
 * obvious credential shapes without drowning ordinary params in false positives.
 */
describe("detectSecretShapedParams", () => {
  test("flags a secret-suggesting key name", () => {
    const warnings = detectSecretShapedParams({ apiKey: "short", password: "x" });
    expect(warnings.some((w) => w.includes('"apiKey"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"password"'))).toBe(true);
  });

  test("flags a high-entropy long string value regardless of key name", () => {
    const warnings = detectSecretShapedParams({ blob: "sk-abcdEFGH1234ijklMNOP5678qrstUVWX" });
    expect(warnings.some((w) => w.includes('"blob"'))).toBe(true);
  });

  test("recurses into nested objects and arrays, reporting the dotted/indexed path", () => {
    const warnings = detectSecretShapedParams({
      creds: { token: "abc" },
      list: ["fine", "ghp_0123456789abcdefABCDEF0123456789abcd"],
    });
    expect(warnings.some((w) => w.includes('"creds.token"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"list[1]"'))).toBe(true);
  });

  test("does not flag ordinary short/prose param values or benign key names", () => {
    const warnings = detectSecretShapedParams({
      target: "widget",
      author: "Ada Lovelace",
      files: ["a.ts", "b.ts"],
      count: 3,
      description: "review the changed files for correctness",
    });
    expect(warnings).toEqual([]);
  });

  test("never throws and never mutates its input", () => {
    const params = { apiKey: "sk-longlonglonglonglonglong123456" };
    const snapshot = JSON.stringify(params);
    expect(() => detectSecretShapedParams(params)).not.toThrow();
    expect(JSON.stringify(params)).toBe(snapshot);
  });
});
