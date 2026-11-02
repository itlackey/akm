// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Size budgets for the `akm ui` assets. Each file is measured in raw bytes, because the server sends the files without
 * a `Content-Encoding`, so raw is what a browser downloads. Authored files (everything but the vendored echarts.js)
 * share one total, CSS has its own cap, and so does every page module. Sizes are decimal KB (1 KB = 1000 bytes). Each
 * cap sits a little above today's size; raise one only deliberately, with the reason in the change.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const KB = 1000;
const BUDGET = {
  authoredTotal: 310 * KB,
  css: 60 * KB,
  pageModule: 25 * KB,
  echarts: 600 * KB,
} as const;

const uiDir = path.resolve(import.meta.dir, "../src/assets/ui");
const ECHARTS = "echarts.js";

const sizes = new Map<string, number>(
  fs
    .readdirSync(uiDir)
    .filter((name) => fs.statSync(path.join(uiDir, name)).isFile())
    .map((name) => [name, fs.statSync(path.join(uiDir, name)).size] as const),
);

const kb = (bytes: number) => `${(bytes / KB).toFixed(1)} KB`;
const authored = [...sizes].filter(([name]) => name !== ECHARTS);
const authoredTotal = authored.reduce((sum, [, size]) => sum + size, 0);
const cssFiles = authored.filter(([name]) => name.endsWith(".css"));
const cssTotal = cssFiles.reduce((sum, [, size]) => sum + size, 0);
const echartsSize = sizes.get(ECHARTS) ?? 0;
const modules = authored.filter(([name]) => name.endsWith(".js"));

describe("ui asset budgets (raw bytes)", () => {
  test(`authored total ${kb(authoredTotal)} <= ${kb(BUDGET.authoredTotal)}`, () => {
    expect(authored.length).toBeGreaterThan(0);
    expect(authoredTotal).toBeLessThanOrEqual(BUDGET.authoredTotal);
  });

  test(`css ${kb(cssTotal)} <= ${kb(BUDGET.css)}`, () => {
    expect(cssFiles.length).toBeGreaterThan(0);
    expect(cssTotal).toBeLessThanOrEqual(BUDGET.css);
  });

  test(`each page module <= ${kb(BUDGET.pageModule)} (largest ${kb(Math.max(...modules.map(([, s]) => s)))})`, () => {
    expect(modules.length).toBeGreaterThan(0);
    for (const [name, size] of modules)
      expect({ name, size }).toEqual({ name, size: Math.min(size, BUDGET.pageModule) });
  });

  test(`echarts ${kb(echartsSize)} <= ${kb(BUDGET.echarts)}`, () => {
    expect(echartsSize).toBeGreaterThan(0);
    expect(echartsSize).toBeLessThanOrEqual(BUDGET.echarts);
  });
});
