// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Playwright never fails on an obsolete snapshot, so a renamed route would leave its old pictures in the tree for
 * reviewers to misread. Every baseline must be `<route>--<state>--<width>--<scheme>` (or a media variant) of a route
 * the matrix knows and a name some spec actually shoots.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ROUTES } from "./support";

const DIR = import.meta.dir;
const SHOTS = path.join(DIR, "__screenshots__");
const ROUTE_NAMES = new Set<string>([...Object.keys(ROUTES), "gallery"]);
const SPECS = fs
  .readdirSync(DIR)
  .filter((file) => file.endsWith(".pw.ts"))
  .map((file) => fs.readFileSync(path.join(DIR, file), "utf8"))
  .join("\n");

const STEM = /^(.+?)--(.+?)--(\d+)--([a-z-]+)\.png$/;

/** Every `route--state` name a spec writes; a `${...}` hole matches any text. */
const NAMES = [...SPECS.matchAll(/[`"']([\w${}.-]+--[\w${}.-]+?)(?:\.png)?[`"']/g)].map(
  (found) => new RegExp(`^${(found[1] as string).replace(/\$\{[^}]*\}/g, ".+")}$`),
);

describe("visual baselines", () => {
  const files = fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter((file) => file.endsWith(".png")) : [];

  test("there are baselines to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("every baseline maps to a route and a name a spec shoots", () => {
    const orphans = files.filter((file) => {
      const match = STEM.exec(file);
      if (!match) return true;
      const [, route, state] = match;
      return !ROUTE_NAMES.has(route as string) || !NAMES.some((name) => name.test(`${route}--${state}`));
    });
    expect(orphans).toEqual([]);
  });
});
