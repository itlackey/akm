// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which routes a change can affect (plan 11.5.2): a map from file to routes. A file the map does not know
 * under a watched folder runs the full matrix, because "when in doubt, the job runs the full matrix".
 *
 * `bun tests/visual/affected.ts [base]` prints the routes changed since `base` (default origin/main), or `all`.
 */

import { spawnSync } from "node:child_process";
import type { RouteName } from "./support";

export const ALL = "all";
export type Affected = typeof ALL | RouteName[];

const PROPOSALS: RouteName[] = [
  "proposals-pending",
  "proposals-recent",
  "proposal-edit",
  "proposal-create",
  "proposal-retire",
  "proposal-noop",
];
const ASSETS: RouteName[] = ["asset-knowledge", "asset-command"];
const SEARCH: RouteName[] = ["search-results", "search-browse"];

/** The first matching rule wins. `ui/` is `src/assets/ui/`. */
const RULES: Array<[RegExp, Affected]> = [
  [/^src\/assets\/ui\/(overview|overview-charts)\.js$/, ["overview"]],
  [/^src\/assets\/ui\/charts\.js$/, ["overview", "bundles"]],
  [/^src\/assets\/ui\/(chart-view|echarts)\.js$/, ["overview", ...PROPOSALS]],
  [/^src\/assets\/ui\/bundles\.js$/, ["bundles"]],
  [/^src\/assets\/ui\/config\.js$/, ["config"]],
  [/^src\/assets\/ui\/(proposals|proposal-actions)\.js$/, PROPOSALS],
  [/^src\/assets\/ui\/(diff|diff-view)\.js$/, [...PROPOSALS, "edit", "new", ...ASSETS]],
  [/^src\/assets\/ui\/changes\.js$/, ["changes"]],
  [/^src\/assets\/ui\/search\.js$/, SEARCH],
  [/^src\/assets\/ui\/asset\.js$/, ASSETS],
  [/^src\/assets\/ui\/(editor|markdown)\.js$/, ["edit", "new", ...ASSETS]],
  // Anything else the client or its server ships, and the harness itself, can move every route.
  [/^(src\/assets\/ui\/|src\/commands\/ui\/|src\/commands\/metrics\/|tests\/visual\/|package\.json$|bun\.lock$)/, ALL],
];

export function affectedRoutes(files: string[]): Affected {
  const routes = new Set<RouteName>();
  for (const file of files) {
    const rule = RULES.find(([pattern]) => pattern.test(file));
    if (!rule) continue;
    const [, hit] = rule;
    if (hit === ALL) return ALL;
    for (const route of hit) routes.add(route);
  }
  return [...routes];
}

if (import.meta.main) {
  const base = process.argv[2] ?? "origin/main";
  const diff = spawnSync("git", ["diff", "--name-only", `${base}...`], { encoding: "utf8" });
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
  const result = affectedRoutes(diff.stdout.split("\n").filter(Boolean));
  console.log(result === ALL ? ALL : result.join("\n"));
}
