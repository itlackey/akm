// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #917 — engine/embedding credentials could only resolve from process.env.
// `resolveSecret` now also accepts a `secret://<name>` reference, resolved
// through an injected store lookup (kept out of this module's own imports to
// avoid a cycle through `env-secret-ref.ts`, which already depends on it).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveSecret } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";

const ENV_VAR = "AKM_TEST_RESOLVE_SECRET_VAR";

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

describe("resolveSecret (#917)", () => {
  beforeEach(() => {
    delete process.env[ENV_VAR];
  });
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test("$VAR and ${VAR} still resolve from process.env", () => {
    process.env[ENV_VAR] = "from-env";
    expect(resolveSecret(`$${ENV_VAR}`)).toBe("from-env");
    expect(resolveSecret(`\${${ENV_VAR}}`)).toBe("from-env");
  });

  test("a literal value (no $ marker) passes through unchanged", () => {
    expect(resolveSecret("sk-literal-value")).toBe("sk-literal-value");
  });

  test("undefined passes through unchanged", () => {
    expect(resolveSecret(undefined)).toBeUndefined();
  });

  test("secret:// resolves through the injected store resolver", () => {
    const resolved = resolveSecret("secret://lab-api-key", (ref) => (ref === "lab-api-key" ? "store-value" : null));
    expect(resolved).toBe("store-value");
  });

  test("secret:// with no matching stored value throws an actionable ConfigError, never the ref's value", () => {
    let caught: unknown;
    try {
      resolveSecret("secret://missing-key", () => null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const err = caught as ConfigError;
    expect(err.code).toBe("SECRET_REFERENCE_UNRESOLVED");
    expect(err.message).toContain("secret://missing-key");
    expect(err.hint()).toBeDefined();
  });

  test("secret:// with no resolver supplied throws rather than sending the raw ref as the credential", () => {
    expect(() => resolveSecret("secret://lab-api-key")).toThrow(ConfigError);
  });
});

describe("resolveSecret empty $VAR warning (#953)", () => {
  beforeEach(() => {
    delete process.env[ENV_VAR];
  });
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test("an unset $VAR still substitutes empty, but warns once naming the variable", () => {
    const warnings = captureWarnings(() => {
      expect(resolveSecret(`$${ENV_VAR}`)).toBe("");
    });
    expect(warnings.some((w) => w.includes(ENV_VAR))).toBe(true);
  });

  test("an empty (but set) $VAR also warns", () => {
    process.env[ENV_VAR] = "";
    const warnings = captureWarnings(() => {
      expect(resolveSecret(`\${${ENV_VAR}}`)).toBe("");
    });
    expect(warnings.some((w) => w.includes(ENV_VAR))).toBe(true);
  });

  test("warns only once per variable name across repeated calls", () => {
    const warnings = captureWarnings(() => {
      resolveSecret(`$${ENV_VAR}`);
      resolveSecret(`$${ENV_VAR}`);
      resolveSecret(`$${ENV_VAR}`);
    });
    expect(warnings.length).toBe(1);
  });

  test("a set, non-empty $VAR never warns", () => {
    process.env[ENV_VAR] = "from-env";
    const warnings = captureWarnings(() => {
      expect(resolveSecret(`$${ENV_VAR}`)).toBe("from-env");
    });
    expect(warnings).toEqual([]);
  });
});
