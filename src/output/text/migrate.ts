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
    reconcile?: string[];
  };
  bundlePolicy?: { changed: number; notes?: string[] };
  taskFilesV5?: { filePath: string; notes?: readonly string[]; guidance?: string }[];
  workflowFiles?: { message: string };
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
  if (plan.bundlePolicy) lines.push(`    bundle policy: ${plan.bundlePolicy.changed} change(s)`);

  if (plan.blockers?.length) {
    lines.push("", "blockers:", ...plan.blockers.map((blocker) => `  - ${blocker}`));
  }
  if (plan.configFile?.notes?.length) {
    lines.push("", "config notes:", ...plan.configFile.notes.map((note) => `  - ${note}`));
  }

  if (plan.assetEngineKeys?.notes?.length) {
    lines.push("", "engine name notes:", ...plan.assetEngineKeys.notes.map((note) => `  - ${note}`));
  }

  if (plan.bundlePolicy?.notes?.length) {
    lines.push("", "bundle policy notes:", ...plan.bundlePolicy.notes.map((note) => `  - ${note}`));
  }

  const v5Notes = plan.taskFilesV5?.flatMap((file) =>
    (file.notes ?? []).map((note) => `  - ${file.filePath}: ${note}`),
  );
  if (v5Notes?.length) lines.push("", "version 5 notes (change by hand):", ...v5Notes);
  const v5Guidance = plan.taskFilesV5?.flatMap((file) =>
    file.guidance ? [`  - ${file.filePath}: ${file.guidance}`] : [],
  );
  if (v5Guidance?.length) lines.push("", "how to fix:", ...v5Guidance);

  if (plan.workflowFiles) lines.push("", `workflow files: ${plan.workflowFiles.message}`);

  if (plan.assetContentRefs?.shadowed?.length) {
    lines.push(
      "",
      "shadowed refs (another file holds the old spelling as its ref; not rewritten, resolve them by hand):",
      ...plan.assetContentRefs.shadowed.map((ref) => `  - ${ref.bundleId}: ${ref.from} (now ${ref.to})`),
    );
  }

  if (plan.assetContentRefs?.reconcile?.length) {
    lines.push("", "git reconcile:", ...plan.assetContentRefs.reconcile.map((note) => `  - ${note}`));
  }

  return lines.join("\n");
}

export const migrateFormatters: TextFormatterEntry[] = [
  { command: "migrate-status", handler: (r) => formatMigratePlain(r) },
  { command: "migrate-apply", handler: (r) => formatMigratePlain(r) },
];
