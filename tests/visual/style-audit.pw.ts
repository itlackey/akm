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
import { type Audit, auditStyles, compareToRatchet, type Ratchet } from "./style-audit";
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
    compareToRatchet(audit, recorded[route] as Audit | undefined).added.map((entry) => `${route} - ${entry}`),
  );
  expect(added, "off-token values the ratchet does not record").toEqual([]);
});
