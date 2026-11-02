// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The token contrast test. It reads the UI stylesheets, resolves every colour token in both schemes and asserts the
 * WCAG contrast pairs and the accent/series distance. Every colour token is a `light-dark(a, b)` pair on `:root`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const UI_DIR = path.join(import.meta.dirname, "../src/assets/ui");

type Scheme = "light" | "dark";
type Rgb = [number, number, number];

/** The content between the braces that open at `open`, and the index after the closing brace. */
function block(css: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return { body: css.slice(open + 1, i), end: i + 1 };
  }
  throw new Error("unbalanced braces in the UI stylesheet");
}

/** Every `selector { body }` at the top level of `css`. */
function topLevelRules(css: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  let cursor = 0;
  for (let open = css.indexOf("{"); open !== -1; open = css.indexOf("{", cursor)) {
    const { body, end } = block(css, open);
    rules.push({ selector: css.slice(cursor, open).trim(), body });
    cursor = end;
  }
  return rules;
}

function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>();
  // A custom property value ends at the first `;` outside parentheses.
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*((?:[^;()]|\([^)]*(?:\([^)]*\)[^)]*)*\))+)/g)) {
    found.set(match[1] as string, (match[2] as string).trim());
  }
  return found;
}

/** The `:root` declarations that apply in `scheme`, each as a still-unresolved value. */
function schemeTokens(css: string, scheme: Scheme): Map<string, string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map<string, string>();
  // Rules may sit inside `@layer name { ... }`, so lift those out first.
  const flat = (text: string): ReturnType<typeof topLevelRules> =>
    topLevelRules(text).flatMap((rule) => (/^@layer\s+[\w-]+$/.test(rule.selector) ? flat(rule.body) : [rule]));
  for (const rule of flat(stripped)) {
    if (rule.selector === ":root") for (const [name, value] of declarations(rule.body)) tokens.set(name, value);
  }
  // `light-dark(a, b)` picks by scheme.
  for (const [name, value] of tokens) {
    const pair = /^light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/.exec(value);
    if (pair) tokens.set(name, (scheme === "light" ? pair[1] : pair[2]) as string);
  }
  return tokens;
}

function parseHex(value: string): Rgb | null {
  const hex = /^#([\da-f]{6})$/i.exec(value);
  if (!hex) return null;
  const n = Number.parseInt(hex[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The colour a token resolves to, following `var()` chains; null when it is not defined or not a plain hex colour. */
function resolve(tokens: Map<string, string>, name: string, depth = 0): Rgb | null {
  const value = tokens.get(name);
  if (value === undefined || depth > 8) return null;
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  return ref ? resolve(tokens, ref[1] as string, depth + 1) : parseHex(value);
}

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLab distance (Ottosson), for the accent/series check. */
function deltaE(a: Rgb, b: Rgb): number {
  const lab = (rgb: Rgb) => {
    const [r, g, bl] = rgb.map(linear) as Rgb;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ] as Rgb;
  };
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

interface Pair {
  rule: string;
  fg: string;
  bg: string;
  min: number;
}

const SURFACES = ["--bg", "--surface", "--surface-2"];
const TEXT = 4.5;
const NON_TEXT = 3;

const PAIRS: Pair[] = [
  ...SURFACES.concat("--accent-bg").map((bg) => ({ rule: "text", fg: "--text", bg, min: TEXT })),
  ...SURFACES.map((bg) => ({ rule: "text", fg: "--muted", bg, min: TEXT })),
  ...[...SURFACES.slice(0, 2), "--accent-bg"].map((bg) => ({ rule: "text", fg: "--accent", bg, min: TEXT })),
  ...[...SURFACES.slice(0, 2), "--accent-bg"].map((bg) => ({ rule: "text", fg: "--link", bg, min: TEXT })),
  ...["ok", "warn", "fail"].flatMap((status) =>
    ["--surface", `--${status}-bg`].map((bg) => ({ rule: "text", fg: `--${status}`, bg, min: TEXT })),
  ),
  { rule: "text", fg: "--on-accent", bg: "--accent", min: TEXT },
  { rule: "text", fg: "--on-accent", bg: "--fail", min: TEXT },
  ...SURFACES.map((bg) => ({ rule: "control-edge", fg: "--border-strong", bg, min: NON_TEXT })),
  ...["--s1", "--s2", "--s3", "--s4", "--s5", "--s6"].map((fg) => ({
    rule: "series",
    fg,
    bg: "--surface",
    min: NON_TEXT,
  })),
  // The focus ring is drawn in `--link` (base.css `:focus-visible`).
  ...[...SURFACES.slice(0, 2), "--accent-bg", "--ok-bg", "--fail-bg"].map((bg) => ({
    rule: "focus-ring",
    fg: "--link",
    bg,
    min: NON_TEXT,
  })),
];

const readCss = () =>
  fs
    .readdirSync(UI_DIR)
    .filter((file) => file.endsWith(".css"))
    .sort()
    .map((file) => fs.readFileSync(path.join(UI_DIR, file), "utf8"))
    .join("\n");

/** Every violated assertion for `scheme`, keyed `scheme rule fg/bg`. */
function violations(css: string, scheme: Scheme): Record<string, string> {
  const tokens = schemeTokens(css, scheme);
  const found: Record<string, string> = {};
  const fail = (key: string, why: string) => {
    found[`${scheme} ${key}`] = why;
  };

  for (const pair of PAIRS) {
    const key = `${pair.rule} ${pair.fg} on ${pair.bg}`;
    const fg = resolve(tokens, pair.fg);
    const bg = resolve(tokens, pair.bg);
    if (!fg || !bg) {
      // Never skip: a missing token and a value that is not a plain hex colour both fail, so the pair cannot pass unchecked.
      fail(key, !tokens.has(pair.fg) || !tokens.has(pair.bg) ? "token not defined" : "not a plain hex colour");
      continue;
    }
    const ratio = contrast(fg, bg);
    if (ratio < pair.min) fail(key, `${ratio.toFixed(2)}:1, needs ${pair.min}:1`);
  }

  const accent = resolve(tokens, "--accent");
  const s1 = resolve(tokens, "--s1");
  if (!accent || !s1) {
    fail(
      "accent-vs-series --accent from --s1",
      tokens.has("--accent") && tokens.has("--s1") ? "not a plain hex colour" : "token not defined",
    );
  } else {
    const distance = deltaE(accent, s1);
    if (distance < 0.08)
      fail("accent-vs-series --accent from --s1", `OKLab distance ${distance.toFixed(3)}, needs 0.08`);
  }

  // The age ramp is ordinal by contrast with the surface (older reads stronger in either scheme), and its weak end stays visible.
  const ramp = ["--age-1", "--age-2", "--age-3"].map((name) => resolve(tokens, name));
  const surface = resolve(tokens, "--surface");
  if (ramp.some((colour) => colour === null) || !surface) {
    fail("age-ramp --age-1..3", "token not defined or not a plain hex colour");
  } else {
    const [c1, c2, c3] = (ramp as Rgb[]).map((colour) => contrast(colour, surface)) as [number, number, number];
    if (!(c1 < c2 && c2 < c3)) fail("age-ramp --age-1..3", "contrast with --surface does not rise with age");
    else if (c1 < 2) fail("age-ramp --age-1 on --surface", "weak end below 2:1");
  }
  return found;
}

describe("token contrast", () => {
  const css = readCss();
  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: every contrast pair passes`, () => {
      expect(violations(css, scheme)).toEqual({});
    });
  }

  test("the parser reads light-dark() pairs for either scheme", () => {
    const pairs = ":root{--a: light-dark(#ffffff, #000000); --b: var(--a);}";
    expect(resolve(schemeTokens(pairs, "dark"), "--b")).toEqual([0, 0, 0]);
    expect(resolve(schemeTokens(pairs, "light"), "--b")).toEqual([255, 255, 255]);
  });

  test("a dark age ramp that rises with contrast passes, and an unresolvable token fails instead of being skipped", () => {
    const ramp = ":root{--surface:#161b23;--age-1:#3a5a9e;--age-2:#5f8ae8;--age-3:#a9c3f7}";
    expect(violations(ramp, "dark")["dark age-ramp --age-1..3"]).toBeUndefined();
    expect(violations(ramp, "dark")["dark age-ramp --age-1 on --surface"]).toBeUndefined();
    const odd = ":root{--surface:#161b23;--muted:oklch(70% 0.1 250)}";
    expect(violations(odd, "dark")["dark text --muted on --surface"]).toBe("not a plain hex colour");
  });

  test("the contrast formula matches known ratios", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 2);
  });
});
