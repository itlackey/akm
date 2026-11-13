// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The map's colours, measured from tokens.css: the eight categorical slots and the highlight stay apart for normal
// vision and under protan, deutan and tritan simulation, and every mark can be seen against the map background.

const css = readFileSync(new URL("../src/lib/ui/tokens.css", import.meta.url), "utf8");
/** `--name: light-dark(#light, #dark)` as { light, dark } rgb triples. */
function token(name) {
  const match = css.match(new RegExp(`${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, "i"));
  assert.ok(match, `${name} is not a light-dark() pair in tokens.css`);
  const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return { light: rgb(match[1]), dark: rgb(match[2]) };
}

// Machado, Oliveira and Fernandes 2009, severity 1.0, applied to linear sRGB.
const SIMULATIONS = {
  normal: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
const linear = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
const clamp = (v) => Math.min(1, Math.max(0, v));
const simulate = (rgb, matrix) => {
  const l = rgb.map(linear);
  return matrix.map((row) => clamp(row[0] * l[0] + row[1] * l[1] + row[2] * l[2]));
};
/** CIELAB (D65) of a linear-sRGB triple. */
function lab([r, g, b]) {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const deltaE76 = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
const luminance = (rgb) => {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

/** The smallest ΔE between any two of the colours, over normal vision and the three simulated deficiencies. */
function closestPair(colours) {
  let worst = { de: Infinity, vision: "", pair: [0, 0] };
  for (const [vision, matrix] of Object.entries(SIMULATIONS)) {
    const seen = colours.map((c) => simulate(c, matrix));
    for (let i = 0; i < seen.length; i++)
      for (let j = i + 1; j < seen.length; j++) {
        const de = deltaE76(seen[i], seen[j]);
        if (de < worst.de) worst = { de, vision, pair: [i, j] };
      }
  }
  return worst;
}

/** The floor the palette meets (CIE76). The measured minimum is 25.6 (light) and 26.0 (dark). */
const MIN_DELTA_E = 25;
const slots = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => token(`--map-${n}`));
const highlight = token("--map-highlight");
const use = [0, 1, 2, 3, 4].map((n) => token(`--use-${n}`));
const bg = token("--bg");

for (const scheme of ["light", "dark"]) {
  test(`${scheme}: the eight map colours (28 pairs) stay at least ${MIN_DELTA_E} apart, for all four kinds of vision`, () => {
    const worst = closestPair(slots.map((s) => s[scheme]));
    assert.ok(
      worst.de >= MIN_DELTA_E,
      `slots ${worst.pair.map((n) => n + 1)} are ${worst.de.toFixed(1)} apart (${worst.vision})`,
    );
  });
  test(`${scheme}: the highlight is not one of the categories, for all four kinds of vision`, () => {
    const worst = closestPair([...slots.map((s) => s[scheme]), highlight[scheme]]);
    assert.ok(worst.de >= MIN_DELTA_E, `${worst.pair} are ${worst.de.toFixed(1)} apart (${worst.vision})`);
  });
  test(`${scheme}: each map colour and the highlight is at least 3:1 against the map background`, () => {
    for (const [n, colour] of [...slots, highlight].entries())
      assert.ok(
        contrast(colour[scheme], bg[scheme]) >= 3,
        `colour ${n + 1}: ${contrast(colour[scheme], bg[scheme]).toFixed(2)}`,
      );
  });
  test(`${scheme}: "use" steps rise in contrast with the background; never shown is visible but below the first step`, () => {
    const ratios = use.map((colour) => contrast(colour[scheme], bg[scheme]));
    assert.ok(ratios[0] > 1.3, `never shown must stay visible: ${ratios[0].toFixed(2)}`);
    for (let n = 1; n < ratios.length; n++)
      assert.ok(ratios[n] > ratios[n - 1], `step ${n} does not beat step ${n - 1}`);
    for (const ratio of ratios.slice(1)) assert.ok(ratio >= 3, `a used step is ${ratio.toFixed(2)}:1`);
    assert.ok(ratios[0] < 3, "never shown is quieter than 3:1");
  });
}

test("the simulation and ΔE are right: a colour is zero from itself, and red and green close up for protan", () => {
  assert.equal(deltaE76([0.2, 0.3, 0.4], [0.2, 0.3, 0.4]), 0);
  const red = [200, 40, 40];
  const green = [40, 160, 40];
  const apart = (matrix) => deltaE76(simulate(red, matrix), simulate(green, matrix));
  assert.ok(apart(SIMULATIONS.protan) < apart(SIMULATIONS.normal) / 2);
});
