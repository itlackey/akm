// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The review tools, each run on a small fixture page (plan 11.5.2). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { contactSheet, groupShots } from "./contact-sheet";
import { pngWidth, stitch } from "./stitch";
import { auditStyles, compareToRatchet } from "./style-audit";

const FIXTURE = `<!doctype html><style>
  :root { --space-2: 0.5rem; --ink: #112233; --text-sm: 0.875rem; --radius: 4px; }
  body { margin: 0; color: var(--ink); font-size: var(--text-sm); }
  .on-token { padding: var(--space-2); border-radius: var(--radius); }
  .off-token { padding: 13px; border-radius: 7px; color: #ff0000; font-size: 19px; }
</style><div class="on-token">on token</div><div class="off-token">off token</div>`;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-visual-tools-"));
}

async function swatch(page: Page, file: string, color: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 40 });
  await page.setContent(`<body style="margin:0;background:${color}">`);
  fs.writeFileSync(file, await page.screenshot());
}

test("style audit reports only values no token produces", async ({ page }) => {
  await page.setContent(FIXTURE);
  const audit = await auditStyles(page);
  expect(audit.padding).toEqual(["13px"]);
  expect(audit["border-radius"]).toEqual(["7px"]);
  expect(audit["font-size"]).toEqual(["19px"]);
  expect(audit.color).toEqual(["rgb(255, 0, 0)"]);
});

test("style audit allows a line-height token and reports a raw one", async ({ page }) => {
  await page.setContent(`<!doctype html><style>
    :root { --leading: 1.5; }
    p { margin: 0; font-size: 14px; }
    .token { line-height: var(--leading); }
    .raw { line-height: 1.37; }
  </style><p class="token">token</p><p class="raw">raw</p>`);
  expect((await auditStyles(page))["line-height"]).toEqual(["1.37"]);
});

test("style audit treats logical and var() auto margins as layout", async ({ page }) => {
  await page.setContent(`<!doctype html><style>
    :root { --x: 0.5rem; }
    body { margin: 0; }
    .box { width: 300px; }
    .logical { margin-inline: auto; }
    .shorthand { margin: var(--x) auto; }
    .start-end { margin-inline-start: auto; margin-inline-end: auto; }
    .raw { margin-left: 11px; }
  </style><div class="box logical">a</div><div class="box shorthand">b</div>
  <div class="box start-end">c</div><div class="box raw">d</div>`);
  expect((await auditStyles(page)).margin).toEqual(["11px"]);
});

test("style ratchet separates new values from cleared ones", () => {
  const result = compareToRatchet({ padding: ["13px", "9px"] }, { padding: ["13px", "5px"] });
  expect(result.added).toEqual(["padding: 9px"]);
  expect(result.cleared).toEqual(["padding: 5px"]);
  expect(compareToRatchet({ padding: ["1px"] }).added).toEqual(["padding: 1px"]);
});

test("stitch lays two labelled screenshots side by side", async ({ page }) => {
  const dir = tmpDir();
  await swatch(page, path.join(dir, "left.png"), "#c00", 200);
  await swatch(page, path.join(dir, "right.png"), "#0a0", 200);
  const png = await stitch(
    page,
    { label: "reference", file: path.join(dir, "left.png"), width: pngWidth(path.join(dir, "left.png")) },
    { label: "actual", file: path.join(dir, "right.png"), width: 200 },
  );
  expect(png.readUInt32BE(16)).toBe(2 * 200 + 3 * 16);
  await expect(page.getByText("reference")).toBeVisible();
  await expect(page.getByText("actual")).toBeVisible();
});

test("contact sheet groups baselines by width and scheme", async ({ page }) => {
  const dir = tmpDir();
  for (const name of ["overview--loaded--1440--light", "bundles--empty--1440--light", "overview--loaded--390--dark"]) {
    await swatch(page, path.join(dir, `${name}.png`), "#888", 300);
  }
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a screenshot");
  const groups = groupShots(dir);
  expect([...groups.keys()]).toEqual(["1440--light", "390--dark"]);
  expect(groups.get("1440--light")?.map((item) => item.label)).toEqual(["bundles / empty", "overview / loaded"]);
  const png = await contactSheet(page, groups.get("1440--light") ?? []);
  expect(png.readUInt32BE(16)).toBe(6 * 240 + 7 * 16);
});

test("overlay draws a 4px grid that never takes the pointer", async ({ page }) => {
  await page.setContent("<body><main>content</main></body>");
  await page.addStyleTag({ path: path.join(import.meta.dirname, "overlay.css") });
  const grid = await page.evaluate(() => {
    const style = getComputedStyle(document.body, "::after");
    return { image: style.backgroundImage, size: style.backgroundSize, events: style.pointerEvents };
  });
  expect(grid.image).toContain("linear-gradient");
  expect(grid.size).toContain("4px 4px");
  expect(grid.events).toBe("none");
});
