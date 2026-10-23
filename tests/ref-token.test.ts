import { describe, expect, test } from "bun:test";
import { isRefToken, isSecretRefToken, substituteRefTokens } from "../src/core/ref-token";

// ── substituteRefTokens: the one `${ref}` token ─────────────────────────────
//
// Substitutes inside VALUES only, recognises only a `${…}` body that is an akm
// ref, supports multiple/embedded tokens, and reports missing refs without
// partially mutating (callers must reject on `missing`).

type Hit = { kind: "secret"; value: string } | { kind: "path"; path: string };

describe("substituteRefTokens", () => {
  test("a secrets/ ref yields the secret value and lists it for redaction", () => {
    const { values, missing, secretValues } = substituteRefTokens({ API_KEY: "${secrets/my_api_token}" }, (ref) =>
      ref === "secrets/my_api_token" ? { kind: "secret", value: "s3cr3t" } : undefined,
    );
    expect(values.API_KEY).toBe("s3cr3t");
    expect(missing).toEqual([]);
    expect(secretValues).toEqual(["s3cr3t"]);
  });

  test("any other asset ref yields a path and is not a secret value", () => {
    const { values, secretValues } = substituteRefTokens({ RUN: "${scripts/lab/run.sh} --go" }, (ref) =>
      ref === "scripts/lab/run.sh" ? { kind: "path", path: "/b/scripts/lab/run.sh" } : undefined,
    );
    expect(values.RUN).toBe("/b/scripts/lab/run.sh --go");
    expect(secretValues).toEqual([]);
  });

  test("a bundle-qualified ref reaches the resolver whole", () => {
    const seen: string[] = [];
    const { values } = substituteRefTokens({ T: "${team//secrets/x}" }, (ref) => {
      seen.push(ref);
      return { kind: "secret", value: "v" } satisfies Hit;
    });
    expect(seen).toEqual(["team//secrets/x"]);
    expect(values.T).toBe("v");
  });

  test("substitutes several tokens embedded in a larger string, each ref resolved once", () => {
    let calls = 0;
    const { values, missing } = substituteRefTokens(
      { AUTH: "Bearer ${secrets/a}:${secrets/b}-${secrets/a}" },
      (ref) => {
        calls++;
        return { kind: "secret", value: ref === "secrets/a" ? "AAA" : "BBB" };
      },
    );
    expect(values.AUTH).toBe("Bearer AAA:BBB-AAA");
    expect(missing).toEqual([]);
    expect(calls).toBe(2);
  });

  test("leaves anything that is not an akm ref untouched: ${HOME}, $VAR, bash parameter forms", () => {
    const { values, missing } = substituteRefTokens(
      {
        HOME_REF: "${HOME}",
        PLAIN: "$VAR",
        SLASHES: "${x/a/b}",
        BASH: "${PATH//:/ }",
        FRAGMENT: "${secrets/x#frag}",
        LITERAL: "no tokens here",
      },
      () => {
        throw new Error("resolver must not be called for text that is not a ref");
      },
    );
    expect(values).toEqual({
      HOME_REF: "${HOME}",
      PLAIN: "$VAR",
      SLASHES: "${x/a/b}",
      BASH: "${PATH//:/ }",
      FRAGMENT: "${secrets/x#frag}",
      LITERAL: "no tokens here",
    });
    expect(missing).toEqual([]);
  });

  test("a bundle-qualified ref follows the core ref grammar even when its first segment is not a native type directory", () => {
    const seen: string[] = [];
    const { values, missing } = substituteRefTokens(
      { A: "${docs//tables/customers}", B: "x ${team//release} y", C: "${unresolved//tables/x}" },
      (ref) => {
        seen.push(ref);
        if (ref === "unresolved//tables/x") return undefined;
        return { kind: "path", path: `/p/${ref.replace("//", "/")}` };
      },
    );
    expect(seen).toEqual(["docs//tables/customers", "team//release", "unresolved//tables/x"]);
    expect(values.A).toBe("/p/docs/tables/customers");
    expect(values.B).toBe("x /p/team/release y");
    expect(values.C).toBe("${unresolved//tables/x}");
    expect(missing).toEqual(["unresolved//tables/x"]);
  });

  test("an unqualified body with no native type prefix stays text", () => {
    const { values, missing } = substituteRefTokens({ A: "${tables/customers}", B: "${release}" }, () => {
      throw new Error("resolver must not be called for an unqualified opaque body");
    });
    expect(values).toEqual({ A: "${tables/customers}", B: "${release}" });
    expect(missing).toEqual([]);
  });

  test("never substitutes keys, only values", () => {
    const { values } = substituteRefTokens({ "${secrets/k}": "v" }, () => ({ kind: "secret", value: "RESOLVED" }));
    expect(Object.keys(values)).toEqual(["${secrets/k}"]);
    expect(values["${secrets/k}"]).toBe("v");
  });

  test("reports missing refs (de-duplicated, first-seen order) and leaves their tokens", () => {
    const { values, missing, secretValues } = substituteRefTokens(
      { A: "${secrets/gone}", B: "${secrets/gone} ${team//secrets/also}" },
      () => undefined,
    );
    expect(missing).toEqual(["secrets/gone", "team//secrets/also"]);
    expect(values.A).toBe("${secrets/gone}");
    expect(values.B).toBe("${secrets/gone} ${team//secrets/also}");
    expect(secretValues).toEqual([]);
  });

  test("supports the full name character set (letters, digits, _ . / -)", () => {
    const { values, missing } = substituteRefTokens({ V: "${secrets/ns/sub.key-name_1}" }, (ref) =>
      ref === "secrets/ns/sub.key-name_1" ? { kind: "secret", value: "ok" } : undefined,
    );
    expect(values.V).toBe("ok");
    expect(missing).toEqual([]);
  });
});

describe("isRefToken", () => {
  test("accepts exactly one whole-string ref token", () => {
    expect(isRefToken("${secrets/openai}")).toBe(true);
    expect(isRefToken("${team//secrets/openai}")).toBe(true);
    expect(isRefToken("${docs//tables/customers}")).toBe(true);
    expect(isRefToken("${OPENAI_KEY}")).toBe(false);
    expect(isRefToken("$OPENAI_KEY")).toBe(false);
    expect(isRefToken("prefix-${secrets/openai}")).toBe(false);
    expect(isRefToken("secret://openai")).toBe(false);
  });
});

describe("isSecretRefToken", () => {
  test("accepts only a token whose ref names a secrets/ asset", () => {
    expect(isSecretRefToken("${secrets/openai}")).toBe(true);
    expect(isSecretRefToken("${team//secrets/openai}")).toBe(true);
    expect(isSecretRefToken("${scripts/run.sh}")).toBe(false);
    expect(isSecretRefToken("${OPENAI_KEY}")).toBe(false);
    expect(isSecretRefToken("prefix-${secrets/openai}")).toBe(false);
  });
});
