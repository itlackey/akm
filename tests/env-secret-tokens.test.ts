import { describe, expect, test } from "bun:test";
import { resolveSecretTokens } from "../src/commands/env/env";

// ── resolveSecretTokens: env value `${secret:NAME}` substitution ─────────────
//
// The helper substitutes inside VALUES only, recognises only the
// `${secret:...}` form, supports multiple/embedded tokens, and reports missing
// secrets without partially mutating (callers must reject on `missing`).

describe("resolveSecretTokens", () => {
  test("substitutes a single token", () => {
    const { values, missing } = resolveSecretTokens({ API_KEY: "${secret:my_api_token}" }, (name) =>
      name === "my_api_token" ? "s3cr3t" : undefined,
    );
    expect(values.API_KEY).toBe("s3cr3t");
    expect(missing).toEqual([]);
  });

  test("substitutes multiple tokens embedded in a larger string", () => {
    const { values, missing } = resolveSecretTokens(
      { AUTH: "Bearer ${secret:a}:${secret:b}" },
      (name) => ({ a: "AAA", b: "BBB" })[name],
    );
    expect(values.AUTH).toBe("Bearer AAA:BBB");
    expect(missing).toEqual([]);
  });

  test("substitutes the same token appearing multiple times", () => {
    const { values } = resolveSecretTokens({ PAIR: "${secret:x}-${secret:x}" }, () => "1");
    expect(values.PAIR).toBe("1-1");
  });

  test("leaves shell-style ${VAR} and literal $VAR untouched", () => {
    const { values, missing } = resolveSecretTokens(
      { HOME_REF: "${HOME}", PLAIN: "$VAR", LITERAL: "no tokens here" },
      () => {
        throw new Error("resolver must not be called for non-secret tokens");
      },
    );
    expect(values.HOME_REF).toBe("${HOME}");
    expect(values.PLAIN).toBe("$VAR");
    expect(values.LITERAL).toBe("no tokens here");
    expect(missing).toEqual([]);
  });

  test("never substitutes keys, only values", () => {
    const { values } = resolveSecretTokens({ "${secret:k}": "v" }, () => "RESOLVED");
    expect(Object.keys(values)).toEqual(["${secret:k}"]);
    expect(values["${secret:k}"]).toBe("v");
  });

  test("reports missing secrets (de-duplicated, first-seen order) and leaves their tokens", () => {
    const { values, missing } = resolveSecretTokens(
      { A: "${secret:gone}", B: "${secret:gone} ${secret:also}" },
      () => undefined,
    );
    expect(missing).toEqual(["gone", "also"]);
    // Tokens for missing secrets are left intact (caller must reject, not inject).
    expect(values.A).toBe("${secret:gone}");
    expect(values.B).toBe("${secret:gone} ${secret:also}");
  });

  test("supports the full secret-name character set (letters, digits, _ . / -)", () => {
    const { values, missing } = resolveSecretTokens({ V: "${secret:ns/sub.key-name_1}" }, (name) =>
      name === "ns/sub.key-name_1" ? "ok" : undefined,
    );
    expect(values.V).toBe("ok");
    expect(missing).toEqual([]);
  });
});
