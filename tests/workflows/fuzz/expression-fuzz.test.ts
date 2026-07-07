// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../../src/workflows/exec/step-work";
import {
  type ExpressionScope,
  parseTemplate,
  resolveTemplate,
  resolveWholeValue,
} from "../../../src/workflows/program/expressions";
import { fuzzSeeds, Rng, withSeed } from "./_rng";

/**
 * Seeded fuzz for the `${{ … }}` expression language (`program/expressions.ts`).
 *
 * Properties (each iteration reproducible from its printed seed):
 *   - `parseTemplate` NEVER throws, on any random string (literals, valid refs,
 *     malformed/nested/unterminated openers, unicode, `$&`/`$$`/backticks,
 *     JSON-ish noise) — errors are always returned, never raised;
 *   - resolution is a SINGLE pass: a scope value that itself contains a
 *     `${{ … }}` sequence is inserted verbatim and never re-scanned, so a
 *     planted `${{ params.SECRET }}` inside data can never exfiltrate the
 *     secret (the P1 re-scan-injection bug class);
 *   - `resolveWholeValue` accepts EXACTLY one bare reference and rejects any
 *     surrounding literal text or a second reference.
 *
 * Golden cases live in `program-expressions.test.ts`; this widens them.
 */

const IDENTS = ["x", "y", "files", "a_b", "n-1", "Result"] as const;
const STEP_IDS = ["discover", "review", "a-1"] as const;

/** Tokens that stress the tokenizer: partial openers, closers, $-noise, unicode. */
const NOISE = [
  "",
  "plain text ",
  "$",
  "${",
  "{{",
  "}}",
  "${{",
  " }} ",
  "`backtick`",
  "$&",
  "$$",
  "\\",
  '{"json":true}',
  "héllo 日本語 🔥",
  "\n\t",
  "steps.x.output",
  "params.",
] as const;

function validRef(rng: Rng): string {
  switch (rng.int(4)) {
    case 0:
      return `\${{ params.${rng.pick(IDENTS)} }}`;
    case 1:
      return "${{ item }}";
    case 2:
      return "${{ item_index }}";
    default:
      return `\${{ steps.${rng.pick(STEP_IDS)}.output.${rng.pick(IDENTS)} }}`;
  }
}

function malformedRef(rng: Rng): string {
  return rng.pick([
    "${{ }}",
    "${{ unknownRoot }}",
    "${{ 123 }}",
    "${{ params }}",
    "${{ params.x.y.z }}",
    "${{ item.foo }}",
    "${{ steps.x }}",
    "${{ params.x", // unterminated
    "${{ a ${{ b }} }}", // nested
    "${{ steps.x.output[abc] }}",
  ]);
}

/** A random template string: a run of literals, valid refs, and malformed noise. */
function randomTemplate(rng: Rng): string {
  const parts: string[] = [];
  const count = rng.range(0, 8);
  for (let i = 0; i < count; i++) {
    switch (rng.int(3)) {
      case 0:
        parts.push(rng.pick(NOISE));
        break;
      case 1:
        parts.push(validRef(rng));
        break;
      default:
        parts.push(malformedRef(rng));
        break;
    }
  }
  return parts.join("");
}

const SCOPE_BASE: Omit<ExpressionScope, "params"> = {
  stepOutputs: { discover: { x: "dx", files: ["f0", "f1"] }, review: { verdict: "pass" }, "a-1": {} },
  item: "the-item",
  itemIndex: 3,
};

describe("expression fuzz — parseTemplate never throws", () => {
  const seeds = fuzzSeeds(400);
  test("any random template string parses to a result, never an exception", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const template = randomTemplate(rng);
        const parsed = parseTemplate(template);
        expect(typeof parsed.ok).toBe("boolean");
        if (parsed.ok) {
          // A clean parse must also resolve without throwing (errors returned).
          const scope: ExpressionScope = {
            ...SCOPE_BASE,
            params: { x: "px", y: "py", files: [], a_b: "z", "n-1": 1, Result: {} },
          };
          const resolved = resolveTemplate(parsed.segments, scope);
          expect(typeof resolved.ok).toBe("boolean");
        } else {
          expect(parsed.errors.length).toBeGreaterThan(0);
          expect(parsed.errors.every((e) => typeof e.message === "string" && e.message.length > 0)).toBe(true);
        }
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("expression fuzz — resolution never re-scans substituted data", () => {
  const seeds = fuzzSeeds(300);
  test("a planted ${{ params.SECRET }} inside a scope value is inserted literally, never resolved", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const sentinel = `LEAKED_${seed}_${rng.int(1_000_000)}`;
        const payloadRef = "${{ params.SECRET }}";
        // The injected value carries a live-looking reference to the secret.
        const injected: unknown = rng.bool()
          ? `before ${payloadRef} after`
          : { note: payloadRef, nested: [payloadRef] };

        const name = rng.pick(IDENTS);
        const params: Record<string, unknown> = { [name]: injected, SECRET: sentinel };
        const scope: ExpressionScope = { ...SCOPE_BASE, params };

        const template = `pre-${rng.int(9)} \${{ params.${name} }} -post`;
        const parsed = parseTemplate(template);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const resolved = resolveTemplate(parsed.segments, scope);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;

        // The payload survives byte-for-byte; the secret is NEVER dereferenced.
        expect(resolved.text).toContain(payloadRef);
        expect(resolved.text.includes(sentinel)).toBe(false);
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("expression fuzz — resolveWholeValue accepts exactly one bare reference", () => {
  const seeds = fuzzSeeds(300);
  test("a lone ${{ ref }} resolves to its RAW value; any wrapping is rejected", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const rawValue: unknown = rng.pick([["a", "b", "c"], { k: 1, nested: { z: [true, null] } }, "scalar", 42]);
        const name = rng.pick(IDENTS);
        const scope: ExpressionScope = { ...SCOPE_BASE, params: { [name]: rawValue } };
        const bare = `\${{ params.${name} }}`;

        // Exactly one bare reference → RAW value (arrays stay arrays, etc.).
        const okResult = resolveWholeValue(bare, scope);
        expect(okResult.ok).toBe(true);
        if (okResult.ok) expect(canonicalJson(okResult.value)).toBe(canonicalJson(rawValue));

        // Any surrounding literal or a second reference → rejected, not spliced.
        const wrappings = [
          `x${bare}`,
          `${bare}y`,
          `${bare} ${bare}`,
          ` ${bare}`,
          `${bare}\n`,
          "plain literal, no ref",
          "",
          `\${{ params.${name}`, // unterminated
        ];
        const wrapping = rng.pick(wrappings);
        expect(resolveWholeValue(wrapping, scope).ok).toBe(false);
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});
