// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { lintCss } from "../scripts/lint-ui-css";

const rules = (css: string, file = "components.css") => lintCss(css, file).map((f) => f.rule);

describe("lint-ui-css", () => {
  test("a stylesheet that follows every rule has no findings", () => {
    const css = `@layer components {
      .card {
        margin-block: var(--space-4) 0;
        padding: var(--space-3);
        border: 1px solid var(--border);
        inline-size: min(36rem, 100%);
        box-shadow: var(--edge-accent);
        letter-spacing: var(--tracking-caps);
        &[aria-current] { font-weight: 700; }
        @media (width < 64rem) { padding: 0; }
      }
    }`;
    expect(lintCss(css, "components.css")).toEqual([]);
  });

  test("rule 1: space, radius and type literals, and colours outside tokens.css", () => {
    expect(rules(".a { padding: 12px; }")).toEqual([1]);
    expect(rules(".a { font-size: 0.85rem; }")).toEqual([1]);
    // An em font size is relative to its surroundings, not a fixed size.
    expect(rules(".a { font-size: 0.92em; }")).toEqual([]);
    expect(rules(".a { color: #ff0000; }")).toEqual([1]);
    expect(rules(":root { --x: rgb(0 0 0); }")).toEqual([1]);
    expect(rules(":root { --x: rgb(0 0 0); }", "tokens.css")).toEqual([]);
    // Layout sizes and hairlines are free.
    expect(rules(".a { inline-size: 16rem; border-block-end: 2px solid var(--rule); }")).toEqual([]);
  });

  test("rule 4: IDs and deep nesting", () => {
    expect(rules("#main { color: var(--text); }")).toEqual([4]);
    expect(rules('.a[href="#x"] { color: var(--text); }')).toEqual([]);
    expect(rules(".a { & .b { & .c { & .d { color: var(--text); } } } }")).toEqual([4]);
  });

  test("rule 5: physical properties", () => {
    expect(rules(".a { margin-left: 0; width: 50%; top: 0; }")).toEqual([5, 5, 5]);
  });

  test("rule 6: media queries outside the layout breaks and preferences", () => {
    expect(rules("@media (width < 40rem) { .a { color: var(--text); } }")).toEqual([6]);
    expect(rules("@media (forced-colors: active) { .a { color: CanvasText; } }")).toEqual([]);
  });

  test("rule 7: !important only in base.css's reduced-motion block", () => {
    expect(rules(".a { animation: none !important; }")).toEqual([7]);
    expect(rules("@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }", "base.css")).toEqual(
      [],
    );
  });

  test("rules 9, 10, 11 and 13", () => {
    expect(rules(".a { min-block-size: 100vh; }")).toEqual([9]);
    expect(rules(".tab.active { font-weight: 700; }")).toEqual([10]);
    expect(rules(".a { box-shadow: 0 0 4px var(--border); }")).toEqual([1, 11]);
    expect(rules(".a { letter-spacing: 0.1em; }")).toEqual([13]);
  });

  test("a finding names the file and line", () => {
    const [finding] = lintCss(".a {\n  color: var(--text);\n  margin-right: 0;\n}", "pages.css");
    expect(finding).toMatchObject({ file: "pages.css", line: 3, rule: 5, selector: ".a" });
  });
});
