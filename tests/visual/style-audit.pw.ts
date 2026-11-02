// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The style-audit ratchet over every route of today's client, at 1440 light. It fails on an off-token value the
 * ratchet file does not record. Record today's values, or lower the ratchet after a fix, with
 * `UPDATE_STYLE_AUDIT=1 bun run test:ui-visual:docker -- --project audit style-audit`. The spec formats the file
 * with Biome after writing it, so the regenerated ratchet passes `bun run lint`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { type Audit, auditStyles, newOffToken, type Ratchet } from "./style-audit";
import { ROUTES, type RouteName, visit } from "./support";

const root = path.join(import.meta.dirname, "../..");
const RATCHET_FILE = path.join(import.meta.dirname, "style-audit.ratchet.json");

test("off-token styles never grow", async ({ page }) => {
  test.setTimeout(120_000);
  const recorded: Ratchet = JSON.parse(fs.readFileSync(RATCHET_FILE, "utf8"));
  const found: Ratchet = {};
  for (const name of Object.keys(ROUTES) as RouteName[]) {
    await visit(page, ROUTES[name].hash);
    found[name] = await auditStyles(page);
  }

  if (process.env.UPDATE_STYLE_AUDIT === "1") {
    fs.writeFileSync(RATCHET_FILE, `${JSON.stringify(found, null, 2)}\n`);
    execFileSync(path.join(root, "node_modules/.bin/biome"), ["format", "--write", RATCHET_FILE], { cwd: root });
    return;
  }

  const added = Object.entries(found).flatMap(([route, audit]) =>
    newOffToken(audit, recorded[route] as Audit | undefined).map((entry) => `${route} - ${entry}`),
  );
  expect(added, "off-token values the ratchet does not record").toEqual([]);
});

// The audit itself, on small fixture pages.
const FIXTURE = `<!doctype html><style>
  :root { --space-2: 0.5rem; --ink: #112233; --text-sm: 0.875rem; --radius: 4px; }
  body { margin: 0; color: var(--ink); font-size: var(--text-sm); }
  .on-token { padding: var(--space-2); border-radius: var(--radius); }
  .off-token { padding: 13px; border-radius: 7px; color: #ff0000; font-size: 19px; }
</style><div class="on-token">on token</div><div class="off-token">off token</div>`;

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

test("style ratchet reports only values it does not record", () => {
  expect(newOffToken({ padding: ["13px", "9px"] }, { padding: ["13px", "5px"] })).toEqual(["padding: 9px"]);
  expect(newOffToken({ padding: ["1px"] })).toEqual(["padding: 1px"]);
});
