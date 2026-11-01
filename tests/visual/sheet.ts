// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** A labelled grid of screenshots, drawn by the browser and captured as one PNG. Stitch and the contact sheet are built on it. */

import fs from "node:fs";
import { type Browser, chromium, type Page } from "@playwright/test";

export interface SheetItem {
  label: string;
  file: string;
}

export interface SheetLayout {
  columns: number;
  /** The width of each picture in px; its height follows. */
  cellWidth: number;
}

const GAP = 16;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function sheetMarkup(items: SheetItem[], layout: SheetLayout): string {
  const figures = items
    .map((item) => {
      const data = fs.readFileSync(item.file).toString("base64");
      return `<figure><figcaption>${escapeHtml(item.label)}</figcaption><img alt="" src="data:image/png;base64,${data}"></figure>`;
    })
    .join("");
  return `<!doctype html><style>
    body { margin: 0; padding: ${GAP}px; background: #fff; color: #111; font: 600 13px/1.4 system-ui, sans-serif; }
    main { display: grid; grid-template-columns: repeat(${layout.columns}, ${layout.cellWidth}px); gap: ${GAP}px; align-items: start; }
    figure { margin: 0; }
    figcaption { margin-block-end: 4px; overflow-wrap: anywhere; }
    img { display: block; width: 100%; height: auto; outline: 1px solid #bbb; }
  </style><main>${figures}</main>`;
}

/** Draw `items` in `layout` on `page` and return the sheet as a PNG. */
export async function renderSheet(page: Page, items: SheetItem[], layout: SheetLayout): Promise<Buffer> {
  const width = layout.columns * layout.cellWidth + (layout.columns + 1) * GAP;
  await page.setViewportSize({ width, height: 400 });
  await page.setContent(sheetMarkup(items, layout));
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  return page.screenshot({ fullPage: true });
}

/** Run `work` with a fresh page of a throwaway browser, for the command-line entry points. */
export async function withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
  const browser: Browser = await chromium.launch();
  try {
    return await work(await browser.newPage({ deviceScaleFactor: 1 }));
  } finally {
    await browser.close();
  }
}
