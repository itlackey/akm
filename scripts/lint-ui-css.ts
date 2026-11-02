// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-ui-css.ts
 *
 * Checks the UI stylesheets in `src/assets/ui/` against the rules below. The rule numbers are stable ids that appear
 * in findings, so a gap in the list is a rule that was dropped. `!important` is left to Biome's `noImportantStyles`.
 *
 *   1  colour, space, radius, font size and shadow come from tokens: outside `tokens.css`, margins, padding, gaps,
 *      radii, `font`, insets and scroll margins use no length other than 0, 1px or 2px, and no value uses a hex,
 *      rgb() or hsl() colour
 *   4  no ID selectors; nesting at most 2 levels
 *   5  logical properties only (no margin-left, width, top, scroll-margin-top, text-align: left, ...)
 *   6  `@media` only for the layout breaks (50, 64, 72 and 90rem), reduced motion, contrast, forced colours, colour
 *      scheme and print
 *   9  no `vh` (use `dvh`)
 *  10  state comes from ARIA and data attributes: no `.active` or `.selected` classes
 *  11  `box-shadow` only from a token: the edge lines (`--edge-*`), the focus halo and `--shadow-float`
 *  13  `letter-spacing` only from a `--tracking-*` token
 *
 * Exit codes: 0 clean, 1 a finding (printed as file:line, rule, selector and declaration).
 */

import fs from "node:fs";
import path from "node:path";

export interface Finding {
  file: string;
  line: number;
  rule: number;
  selector: string;
  text: string;
}

const PHYSICAL =
  /^(margin|padding|border)-(left|right|top|bottom)(-|$)|^scroll-(margin|padding)-(left|right|top|bottom)$|^(min-|max-)?(width|height)$|^(top|left|right|bottom)$|^float$/;
const MEDIA_OK =
  /\b(50|64|72|90)rem\b|prefers-reduced-motion|prefers-contrast|forced-colors|prefers-color-scheme|^print$/;
const SHADOW_OK = /^(none|var\(--(edge-[\w-]+|focus-halo|shadow-float)\))$/;
const LENGTH = /(?<![\w.#-])(\d*\.?\d+)(px|rem|em)\b/g;
const COLOUR = /#[\da-f]{3,8}\b|\b(rgb|rgba|hsl|hsla)\(/i;
/** Properties whose lengths must come from the space, radius and type tokens (rule 1); layout sizes are free. */
const TOKEN_LENGTHS =
  /^(margin|padding|gap|row-gap|column-gap|border-radius|font|outline-offset|inset|scroll-margin)(-|$)/;

/** Every finding in one stylesheet. `file` is the name used in messages and the allowlist. */
export function lintCss(css: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  // The stack of open blocks: an at-rule prelude or a selector.
  const stack: string[] = [];
  let buffer = "";
  let line = 1;
  let startLine = 1;
  const add = (rule: number, detail: string, at = startLine) =>
    findings.push({ file, line: at, rule, selector: selectorPath(stack), text: detail });

  for (const char of text) {
    if (char === "\n") line++;
    if (char === "{") {
      const prelude = buffer.trim();
      openBlock(prelude, stack, add);
      stack.push(prelude);
      buffer = "";
      startLine = line;
    } else if (char === ";" || char === "}") {
      const declaration = buffer.trim();
      if (declaration) checkDeclaration(declaration, file, stack, add);
      if (char === "}") stack.pop();
      buffer = "";
      startLine = line;
    } else {
      if (!buffer.trim() && char.trim()) startLine = line;
      buffer += char;
    }
  }
  return findings;
}

function selectorPath(stack: string[]): string {
  return stack.filter((s) => !s.startsWith("@")).join(" > ") || stack.join(" > ");
}

function openBlock(prelude: string, stack: string[], add: (rule: number, detail: string) => void) {
  if (prelude.startsWith("@media")) {
    const query = prelude.slice(6).trim();
    if (!MEDIA_OK.test(query)) add(6, `@media ${query}`);
    return;
  }
  if (prelude.startsWith("@")) return;
  if (/(^|[\s,>+~(])#[\w-]+/.test(prelude.replace(/\[[^\]]*\]/g, ""))) add(4, `ID selector: ${prelude}`);
  if (/\.(active|selected)\b/.test(prelude)) add(10, `state class: ${prelude}`);
  const depth = stack.filter((s) => !s.startsWith("@")).length;
  if (depth >= 3) add(4, `nested ${depth + 1} levels: ${prelude}`);
}

function checkDeclaration(
  declaration: string,
  file: string,
  stack: string[],
  add: (rule: number, detail: string) => void,
) {
  const colon = declaration.indexOf(":");
  if (colon < 0) return;
  const property = declaration.slice(0, colon).trim().toLowerCase();
  const value = declaration.slice(colon + 1).trim();
  if (property.startsWith("--")) {
    if (file !== "tokens.css" && COLOUR.test(value)) add(1, `${property}: ${value}`);
    return;
  }
  if (file !== "tokens.css") {
    const lengths = [...value.matchAll(LENGTH)].filter(([whole, number, unit]) => {
      if (Number(number) === 0) return false;
      // An em font size scales with its surroundings (inline code, small print); it is not a fixed size.
      if (property === "font-size" && unit === "em") return false;
      return !(unit === "px" && (whole === "1px" || whole === "2px"));
    });
    if (lengths.length && TOKEN_LENGTHS.test(property)) add(1, `${property}: ${value}`);
    else if (COLOUR.test(value)) add(1, `${property}: ${value}`);
  }
  if (PHYSICAL.test(property) || (property === "text-align" && /^(left|right)$/.test(value)))
    add(5, `${property}: ${value}`);
  if (/\d(vh)\b/.test(value)) add(9, `${property}: ${value}`);
  if (property === "box-shadow" && !SHADOW_OK.test(value)) add(11, `${property}: ${value}`);
  if (property === "letter-spacing" && !/^(0|normal|var\(--tracking-[\w-]+\))$/.test(value))
    add(13, `${property}: ${value}`);
}

const UI_DIR = path.join(import.meta.dirname, "..", "src", "assets", "ui");

function main() {
  const files = fs
    .readdirSync(UI_DIR)
    .filter((name) => name.endsWith(".css"))
    .sort();
  const findings = files.flatMap((name) => lintCss(fs.readFileSync(path.join(UI_DIR, name), "utf8"), name));
  for (const f of findings) console.error(`${f.file}:${f.line} rule ${f.rule}: ${f.selector} { ${f.text} }`);
  if (findings.length) process.exitCode = 1;
  else console.log(`lint-ui-css: OK - ${files.length} stylesheets follow the UI CSS rules.`);
}

if (import.meta.main) main();
