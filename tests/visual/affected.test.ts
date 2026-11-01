// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ALL, affectedRoutes } from "./affected";

describe("affectedRoutes", () => {
  test("a page module affects only its routes", () => {
    expect(affectedRoutes(["src/assets/ui/history.js"])).toEqual(["history"]);
    expect(affectedRoutes(["src/assets/ui/search.js"])).toEqual(["search-results", "search-browse"]);
  });

  test("routes from several files are merged without repeats", () => {
    const routes = affectedRoutes(["src/assets/ui/diff-view.js", "src/assets/ui/proposals.js"]);
    expect(routes).toContain("edit");
    expect(routes).toContain("proposal-noop");
    expect(new Set(routes).size).toBe(routes.length);
  });

  test("shared files and the harness affect everything", () => {
    for (const file of ["src/assets/ui/styles.css", "src/assets/ui/lib.js", "tests/visual/support.ts", "bun.lock"]) {
      expect(affectedRoutes([file])).toBe(ALL);
    }
  });

  test("an unknown file under the client runs the full matrix", () => {
    expect(affectedRoutes(["src/assets/ui/new-page.js"])).toBe(ALL);
  });

  test("files outside the watched set affect nothing", () => {
    expect(affectedRoutes(["README.md", "src/core/paths.ts"])).toEqual([]);
  });

  test("a shared module affects every route of each module that imports it, directly or not", () => {
    const dir = path.resolve(import.meta.dirname, "../../src/assets/ui");
    const importers = new Map<string, Set<string>>();
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".js"))) {
      for (const [, dep] of fs
        .readFileSync(path.join(dir, file), "utf8")
        .matchAll(/(?:from |import\()"\.\/([\w-]+)\.js"/g)) {
        if (dep) importers.set(dep, (importers.get(dep) ?? new Set()).add(file));
      }
    }
    const routesOf = (file: string) => affectedRoutes([`src/assets/ui/${file}`]);
    const reachers = (file: string, seen = new Set<string>()): Set<string> => {
      for (const importer of importers.get(file.replace(/\.js$/, "")) ?? []) {
        if (!seen.has(importer)) reachers(importer, seen.add(importer));
      }
      return seen;
    };
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".js"))) {
      const own = routesOf(file);
      if (own === ALL) continue;
      for (const importer of reachers(file)) {
        const theirs = routesOf(importer);
        if (theirs === ALL) continue;
        expect(own, `${file} is used by ${importer}`).toEqual(expect.arrayContaining(theirs));
      }
    }
  });

  test("chart modules reach the pages that draw charts", () => {
    expect(affectedRoutes(["src/assets/ui/charts.js"])).toEqual(["overview", "bundles"]);
    expect(affectedRoutes(["src/assets/ui/chart-view.js"])).toContain("proposals-pending");
  });
});
