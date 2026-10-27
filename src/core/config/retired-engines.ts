// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the engine names of the retired `engines` form became, kept in the data
 * directory (`migrate/engine-targets.json`) after `akm migrate apply` has rewritten
 * the config. The conversion renames the engine `defaults` named to `default` and
 * moves an old `default` aside, so an `engine:` selector that is still in a file the
 * migration has not rewritten (a read-only bundle, a block it could not splice) keeps
 * its meaning only if the old names outlive the config that had them. The migrator
 * writes and removes this file; the resolver of `engine:` selectors reads it
 * ({@link retiredEngineTargets}); nothing else does.
 */

import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../common";
import { getDataDir } from "../paths";
import type { EngineTarget } from "./convert-engines-shared";

export type EngineTargets = Readonly<Record<string, EngineTarget>>;

function rememberedPath(): string {
  return path.join(getDataDir(), "migrate", "engine-targets.json");
}

/** An old engine name's entry, when it is `{ "connection": "<name>" }` or `{ "harness": "<name>" }`. */
function targetOf(value: unknown): EngineTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.connection === "string" && value.connection) return { connection: value.connection };
  if (typeof value.harness === "string" && value.harness) return { harness: value.harness };
  return undefined;
}

/** The names an earlier run's config step recorded; a file that is not a name map, or an entry that is not a target, holds none. */
export function rememberedEngineTargets(): EngineTargets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(rememberedPath(), "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([engine, value]) => {
      const target = targetOf(value);
      return target ? [[engine, target]] : [];
    }),
  );
}

export function rememberEngineTargets(targets: EngineTargets): void {
  fs.mkdirSync(path.dirname(rememberedPath()), { recursive: true });
  fs.writeFileSync(rememberedPath(), `${JSON.stringify(targets, null, 2)}\n`);
}

export function forgetEngineTargets(): void {
  fs.rmSync(rememberedPath(), { force: true });
}
