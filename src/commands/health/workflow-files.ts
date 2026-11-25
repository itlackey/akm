// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `workflow-files` advisory for `akm health` / `akm doctor`: workflows are removed in 0.11, so every workflow file
 * left in an enabled, writable bundle is listed with the command that converts it. Silent when none is left; a
 * bundle that cannot be read is reported as unknown, never as none.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import type { HealthCheckResult } from "./types";

/** The workflow files under a bundle root's `workflows` folder, sorted. */
export function workflowFilesIn(root: string): string[] {
  const directory = path.join(root, "workflows");
  // asset-io: deprecated
  if (!fs.existsSync(directory)) return [];
  // asset-io: deprecated
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md")
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

export interface WorkflowFilesOfBundle {
  /** The bundle's root directory. */
  readonly bundle: string;
  readonly files: readonly string[];
}

/** The workflow files left in each enabled, writable bundle that has any; the default bundle first. */
export function remainingWorkflowFiles(stashDir?: string): WorkflowFilesOfBundle[] {
  return resolveSourceEntries(stashDir)
    .filter((source) => source.writable === true && !source.unresolved)
    .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true))
    .flatMap(({ path }) => (path === undefined ? [] : [{ bundle: path, files: workflowFilesIn(path) }]))
    .filter((entry) => entry.files.length > 0);
}

/** One line for the bundles and how to convert them; `akm doctor` and `akm migrate status` both print it. */
export function describeRemainingWorkflowFiles(bundles: readonly WorkflowFilesOfBundle[]): string {
  const count = bundles.reduce((sum, entry) => sum + entry.files.length, 0);
  const where = bundles.map((entry) => `${entry.bundle} (${entry.files.length})`).join(", ");
  return (
    `${count} workflow file(s) remain, in ${where}. Workflows are removed in 0.11; ` +
    "`akm migrate status <bundle>/workflows/*.md` reports what each becomes and why one cannot convert, and " +
    "`akm migrate apply <path>` makes the task. A workflow file stays in place when its task is made: delete it once " +
    "the task works, and it is no longer counted here."
  );
}

/** The advisory for the workflow files left in the enabled, writable bundles, or `undefined` when there are none. */
export function collectWorkflowFilesAdvisory(stashDir?: string): HealthCheckResult | undefined {
  const base = { name: "workflow-files", kind: "deterministic", confidence: "high" } as const;
  let bundles: WorkflowFilesOfBundle[];
  try {
    bundles = remainingWorkflowFiles(stashDir);
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      reason: "blocked",
      message: `Could not look for workflow files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (bundles.length === 0) return undefined;
  return {
    ...base,
    status: "warn",
    message: describeRemainingWorkflowFiles(bundles),
    evidence: { bundles, files: bundles.flatMap((entry) => entry.files) },
  };
}
