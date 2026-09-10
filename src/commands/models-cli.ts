// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isDeepStrictEqual } from "node:util";
import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { loadConfig } from "../core/config/config";
import {
  copyDefaultModelMap,
  loadModelMapLayers,
  mergedModelMapProfiles,
  mergeModelMapLayers,
} from "../integrations/agent/model-map";

interface ModelsListRow {
  readonly alias: string;
  readonly column: string;
  readonly model: string;
  readonly inference?: unknown;
  readonly source: "default" | "user";
  readonly via: "literal" | "engine";
  readonly engine?: string;
}

/**
 * Compute the effective alias table (#946): every (alias, column) pair from
 * the fully resolved map, labeled with where its value came from.
 *
 * `source` compares the installed-only merge against the full (installed +
 * user) merge for the same pair — identical means the user file never
 * touched it. `via`/`engine` come from the raw overlaid-but-unresolved
 * profile (before `engine` indirection is expanded), so a column that
 * resolves through `{ engine: "local-fast" }` reports which engine it
 * borrowed its model from.
 */
function modelsListRows(): ModelsListRow[] {
  const config = loadConfig();
  const layers = loadModelMapLayers();
  const rawProfiles = mergedModelMapProfiles(layers.installed, layers.user);
  const defaultsOnly = mergeModelMapLayers(layers.installed, undefined, config.engines);
  const resolved = mergeModelMapLayers(layers.installed, layers.user, config.engines);

  const rows: ModelsListRow[] = [];
  for (const [alias, columns] of Object.entries(resolved.aliases)) {
    for (const [column, profile] of Object.entries(columns)) {
      const raw = rawProfiles[alias]?.[column];
      const via: "literal" | "engine" = raw?.engine !== undefined ? "engine" : "literal";
      const defaultProfile = defaultsOnly.aliases[alias]?.[column];
      const source: "default" | "user" =
        defaultProfile !== undefined && isDeepStrictEqual(defaultProfile, profile) ? "default" : "user";
      rows.push({
        alias,
        column,
        model: profile.model,
        ...(Object.hasOwn(profile, "inference") ? { inference: profile.inference } : {}),
        source,
        via,
        ...(via === "engine" && raw?.engine !== undefined ? { engine: raw.engine } : {}),
      });
    }
  }
  rows.sort((left, right) =>
    left.alias === right.alias ? left.column.localeCompare(right.column) : left.alias.localeCompare(right.alias),
  );
  return rows;
}

/** Operator-owned model-map lifecycle commands. Alias expansion is consumed through the runtime API. */
export const modelsCommand = defineGroupCommand({
  meta: { name: "models", description: "Inspect and customize model intent alias defaults" },
  subCommands: {
    "copy-defaults": defineJsonCommand({
      meta: {
        name: "copy-defaults",
        description: "Copy AKM's installed models.json into the user configuration directory",
      },
      args: {
        overwrite: {
          type: "boolean",
          default: false,
          description: "Confirm replacing an existing regular user models.json file",
        },
      },
      run({ args }) {
        output("models", copyDefaultModelMap({ overwrite: args.overwrite === true }));
      },
    }),
    list: defineJsonCommand({
      meta: {
        name: "list",
        description: "Show the effective model intent alias table and where each mapping resolved from",
      },
      run() {
        output("models-list", { rows: modelsListRows() });
      },
    }),
  },
});
