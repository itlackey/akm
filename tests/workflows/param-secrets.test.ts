// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { detectSecretShapedParams, secretShapedParamValues } from "../../src/workflows/exec/param-secrets";

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

describe("ordinary paths are not secret-shaped", () => {
  const ordinary = {
    config_path: "/tmp/akm-review-20261030/config.json",
    win: "C:\\Users\\dev\\akm-review-20261030\\config.json",
    unc: "\\\\fileserver\\share\\reports-2026-10-30\\out.json",
    nested: { dir: "./build/output-2026-10-30/v1.2.3/bundle.js" },
    list: ["~/work/akm-review-20261030/a.txt", "/var/log/akm/run-20261030-123456/out.log"],
    relative: "reports/2026-10-30/summary-final.md",
    relativeWin: "data\\2026\\run-20261030\\out.json",
    runDir: "/var/runs/550e8400-e29b-41d4-a716-446655440000/out.json",
  };

  test("no warning for Unix/Windows paths, including nested params and arrays", () => {
    expect(detectSecretShapedParams(ordinary)).toEqual([]);
  });

  test("no redaction value for the same paths", () => {
    expect(secretShapedParamValues(ordinary)).toEqual([]);
  });

  test("a credential-named key is still flagged and redacted for a path value", () => {
    const params = { token_path: "/tmp/akm-review-20261030/config.json" };
    expect(detectSecretShapedParams(params)).toHaveLength(1);
    expect(secretShapedParamValues(params)).toEqual(["/tmp/akm-review-20261030/config.json"]);
  });

  test("credential-looking path and query segments are still flagged and redacted", () => {
    const risky = [
      "/tmp/ghp_0123456789abcdefABCDEF0123456789abcd/config.json",
      "C:\\Users\\dev\\sk-abcdEFGH1234ijklMNOP5678qrstUVWX\\x.txt",
      "/srv/data/aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1fG/out.json",
      "/api/export/report.json?token=Zm9vYmFyYmF6cXV4",
      "out/ghp_0123456789abcdefABCDEF0123456789abcd/x.md",
      "out/aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1fG/out.json",
    ];
    for (const value of risky) {
      expect(detectSecretShapedParams({ p: value })).toHaveLength(1);
      expect(secretShapedParamValues({ p: value })).toEqual([value]);
    }
  });

  test("a non-path high-entropy value is still flagged", () => {
    const params = { blob: "Zx9Qw3Er5Ty7Ui1Op2As4Df6Gh8Jk0Lm" };
    expect(detectSecretShapedParams(params)).toHaveLength(1);
    expect(secretShapedParamValues(params)).toEqual([params.blob]);
  });

  test("slash-bearing base64 without a file extension stays on the whole-string check", () => {
    const params = { blob: "aB3dEfGh/1jKlMn0pQr+StUvWxYz012345/abcDEF==" };
    expect(secretShapedParamValues(params)).toEqual([params.blob]);
  });
});
