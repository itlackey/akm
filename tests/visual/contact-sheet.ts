// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contact sheets of the baselines (plan 11.5.2): one sheet per width and scheme, every route and state tiled and labelled.
 * `bun tests/visual/contact-sheet.ts [screenshotsDir] [outDir]`
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { renderSheet, type SheetItem, withPage } from "./sheet";

const COLUMNS = 6;
const CELL_WIDTH = 240;

/** `<route>--<state>--<width>--<scheme>.png` -> sheets keyed `<width>--<scheme>`, items sorted by name. */
export function groupShots(dir: string): Map<string, SheetItem[]> {
  const groups = new Map<string, SheetItem[]>();
  for (const name of fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".png"))
    .sort()) {
    const [route, state, width, scheme] = path.basename(name, ".png").split("--");
    if (!route || !state || !width || !scheme) continue;
    const key = `${width}--${scheme}`;
    groups.set(key, [...(groups.get(key) ?? []), { label: `${route} / ${state}`, file: path.join(dir, name) }]);
  }
  return groups;
}

export async function contactSheet(page: Page, items: SheetItem[]): Promise<Buffer> {
  return renderSheet(page, items, { columns: COLUMNS, cellWidth: CELL_WIDTH });
}

if (import.meta.main) {
  const [dir = path.join(import.meta.dir, "__screenshots__"), out = ".ui-visual/contact-sheets"] =
    process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  await withPage(async (page) => {
    for (const [key, items] of groupShots(dir)) {
      fs.writeFileSync(path.join(out, `contact-sheet--${key}.png`), await contactSheet(page, items));
      console.log(`${key}: ${items.length} shots`);
    }
  });
}
