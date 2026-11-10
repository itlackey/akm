// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text rendering of the combined migration plan: the config file's moved
 * keys and notes, and the assets' `engine:` keys and old-spelling refs in content.
 */

import type { TextFormatterEntry } from "./registry";

interface MigrationPlanResult {
  status: string;
  blockers?: string[];
  configFile?: { credentials?: string[]; notes?: string[] };
  assetEngineKeys?: { changed: number; skipped: number; notes?: string[] };
  assetContentRefs?: {
    changed: number;
    skipped: number;
    refs: number;
    stateRows?: number;
    shadowed?: { bundleId: string; from: string; to: string }[];
  };
}

function planGlyph(status: string): string {
  switch (status) {
    case "current":
      return "✓";
    case "ready":
      return "⚠";
    default: // "blocked"
      return "✗";
  }
}

export function formatMigratePlain(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const plan = result as MigrationPlanResult;
  if (typeof plan.status !== "string") return null;

  const lines: string[] = [`${planGlyph(plan.status)} ${plan.status}`];
  if (plan.configFile?.credentials?.length) {
    lines.push(
      `    credentials.json: ${plan.configFile.credentials.length} key(s) (${plan.configFile.credentials.join(", ")})`,
    );
  }
  if (plan.assetEngineKeys) {
    lines.push(
      `    asset engine keys: ${plan.assetEngineKeys.changed} change, ${plan.assetEngineKeys.skipped} skipped`,
    );
  }
  if (plan.assetContentRefs) {
    const refs = plan.assetContentRefs;
    lines.push(
      `    asset content refs: ${refs.refs} in ${refs.changed} file(s) change, ${refs.skipped} skipped, ${refs.shadowed?.length ?? 0} shadowed, ${refs.stateRows ?? 0} history row(s) re-keyed`,
    );
  }

  if (plan.blockers?.length) {
    lines.push("", "blockers:", ...plan.blockers.map((blocker) => `  - ${blocker}`));
  }
  if (plan.configFile?.notes?.length) {
    lines.push("", "config notes:", ...plan.configFile.notes.map((note) => `  - ${note}`));
  }

  if (plan.assetEngineKeys?.notes?.length) {
    lines.push("", "engine name notes:", ...plan.assetEngineKeys.notes.map((note) => `  - ${note}`));
  }

  if (plan.assetContentRefs?.shadowed?.length) {
    lines.push(
      "",
      "shadowed refs (another file holds the old spelling as its ref; not rewritten, resolve them by hand):",
      ...plan.assetContentRefs.shadowed.map((ref) => `  - ${ref.bundleId}: ${ref.from} (now ${ref.to})`),
    );
  }

  return lines.join("\n");
}

export const migrateFormatters: TextFormatterEntry[] = [
  { command: "migrate-status", handler: (r) => formatMigratePlain(r) },
  { command: "migrate-apply", handler: (r) => formatMigratePlain(r) },
];
