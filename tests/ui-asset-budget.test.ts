// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Size budgets for the `akm ui` assets (plan §8.5, D-52). Each file is measured at gzip level 9, the size a browser
 * downloads. Authored files (everything but the vendored echarts.js) share one total, CSS has its own cap, and so does
 * every page module. Raise a limit only by changing the plan.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const KB = 1024;
const BUDGET = {
  authoredTotal: 85 * KB,
  css: 12 * KB,
  pageModule: 8 * KB,
  echarts: 200 * KB,
} as const;

const uiDir = path.resolve(import.meta.dir, "../src/assets/ui");
const ECHARTS = "echarts.js";

const sizes = new Map<string, number>(
  fs
    .readdirSync(uiDir)
    .filter((name) => fs.statSync(path.join(uiDir, name)).isFile())
    .map((name) => [name, gzipSync(fs.readFileSync(path.join(uiDir, name)), { level: 9 }).length] as const),
);

const kb = (bytes: number) => `${(bytes / KB).toFixed(1)} KB`;
const authored = [...sizes].filter(([name]) => name !== ECHARTS);
const authoredTotal = authored.reduce((sum, [, size]) => sum + size, 0);
const cssFiles = authored.filter(([name]) => name.endsWith(".css"));
const cssTotal = cssFiles.reduce((sum, [, size]) => sum + size, 0);
const echartsSize = sizes.get(ECHARTS) ?? 0;
const modules = authored.filter(([name]) => name.endsWith(".js"));

describe("ui asset budgets (gzip -9)", () => {
  test(`authored total ${kb(authoredTotal)} <= ${kb(BUDGET.authoredTotal)}`, () => {
    expect(authored.length).toBeGreaterThan(0);
    expect(authoredTotal).toBeLessThanOrEqual(BUDGET.authoredTotal);
  });

  test(`css ${kb(cssTotal)} <= ${kb(BUDGET.css)}`, () => {
    expect(cssFiles.length).toBeGreaterThan(0);
    for (const [name, size] of cssFiles) expect({ name, size }).toEqual({ name, size: Math.min(size, BUDGET.css) });
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
