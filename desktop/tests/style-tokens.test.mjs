// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Every colour the UI draws is a custom property in tokens.css, so an app that embeds the UI can set it
// (`experimental.web.tokens`). A colour written anywhere else in Desktop's styles, markup or scripts fails here,
// unless it is listed below with the reason it is not a token.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));

/** `file: [literal, ...]`, each with why it is not a token. */
const ALLOWED = {
  // White alpha masks for the 3D map's points; three.js multiplies each by the point's own token colour.
  "lib/SimilarityMap.svelte": ["#fff", "#fff", "#fff", "rgba(255,255,255,0)"],
  // Not used by any page (nothing imports Trend.svelte), so nothing draws it.
  "lib/Trend.svelte": ["#e1e7e2"],
};
/** Not the UI: the vendored chart library, the server (its login page has its own minimal style), and the tokens. */
const SKIP = new Set(["lib/ui/echarts.js", "lib/ui/tokens.css"]);

// CSS's named colours. `transparent`, `currentColor` and the system colours used under forced colours are not themes.
const NAMED =
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  );
const HEX = /(?<=["'`\s:(,])#[0-9a-f]{3,8}(?=["'`\s;,)]|$)/gi;
const FUNCTION = /(?<![\w.])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[-\d.][^)]*\)/g;
const NAMED_VALUE = new RegExp(`(?<![-\\w])(?:${NAMED.join("|")})(?![-\\w])`, "gi");

function files(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "server") files(full, found);
    } else if (/\.(css|svelte|js|ts)$/.test(entry.name) && !/\.server\.ts$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** The declaration values of a style sheet: where a named colour would be a colour (not a selector or a property). */
const values = (css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/[\w-]+\s*:\s*([^;{}]+)[;}]/g)].map((m) => m[1]).join("\n");
const styles = (text, file) =>
  file.endsWith(".css")
    ? text
    : file.endsWith(".svelte")
      ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
      : "";

/** Every colour literal in a file: hex values, colour functions, then named colours in style values. Comments are skipped. */
function literals(file) {
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return [
    ...(text.match(HEX) ?? []),
    ...(text.match(FUNCTION) ?? []),
    ...(values(styles(text, file)).match(NAMED_VALUE) ?? []),
  ];
}

test("Desktop's styles, markup and scripts draw colours only through the tokens", () => {
  const found = {};
  for (const file of files(src)) {
    const name = path.relative(src, file).split(path.sep).join("/");
    if (SKIP.has(name)) continue;
    const hits = literals(file);
    if (hits.length) found[name] = hits;
  }
  assert.deepEqual(
    found,
    ALLOWED,
    "A colour outside tokens.css: use a token (var(--name), or the token reader in chart and map code), or add it to tokens.css.",
  );
});

test("the guard finds a colour in a style sheet, a component's style, its markup and its script", (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "akm-style-tokens-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const write = (name, text) => {
    writeFileSync(path.join(scratch, name), text);
    return path.join(scratch, name);
  };
  const css = ".x { color: #12ab34; background: rgb(0 0 0 / 0.4); border-color: white; white-space: nowrap; }";
  assert.deepEqual(literals(write("a.css", css)), ["#12ab34", "rgb(0 0 0 / 0.4)", "white"]);
  const svelte =
    '<script>const c = "#fff"; const ok = rgb("--bg");</script><rect fill="#abc" /><style>.y { outline: 1px solid red; }</style>';
  assert.deepEqual(literals(write("b.svelte", svelte)), ["#fff", "#abc", "red"]);
  assert.deepEqual(literals(write("c.svelte", '<a href="#main">x</a><style>.z { color: var(--text); }</style>')), []);
});

test("every token in tokens.css is in the theming reference, and the reference names no other", () => {
  const defined = new Set(
    readFileSync(path.join(src, "lib/ui/tokens.css"), "utf8").match(/(?<=^\s*)--[a-z0-9-]+(?=:)/gm),
  );
  const reference = readFileSync(new URL("../docs/theming.md", import.meta.url), "utf8");
  const documented = new Set(reference.match(/(?<=^\| `)--[a-z0-9-]+(?=` \|)/gm));
  assert.deepEqual([...defined].sort(), [...documented].sort());
});
