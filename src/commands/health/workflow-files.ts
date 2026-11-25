// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `workflow-files` advisory for `akm health` / `akm doctor`: workflows are removed in 0.11, so every workflow file
 * left in an enabled, writable bundle is listed with the command that converts it, and every blocked workflow run is
 * named with the commands that finish or abandon it: 0.11 has no engine to continue one. An active run is not
 * reported. Silent when there is nothing to report; a bundle or run list that cannot be read is reported as unknown,
 * never as none.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { listWorkflowRuns } from "../../workflows/runtime/runs";
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

/** One line for the blocked runs and how to finish or abandon them before 0.11. */
function describeBlockedWorkflowRuns(runs: readonly { id: string; workflowRef: string }[]): string {
  return (
    `${runs.length} blocked workflow run(s): ${runs.map((run) => `${run.id} (${run.workflowRef})`).join(", ")}. ` +
    "A run still blocked when you upgrade to 0.11 cannot continue. Finish it with `akm workflow resume <id>` " +
    "(or `akm workflow run <id>`), or give it up with `akm workflow abandon <id>`, before upgrading."
  );
}

/** The advisory for the workflow files and blocked workflow runs left, or `undefined` when there are none. */
export async function collectWorkflowFilesAdvisory(stashDir?: string): Promise<HealthCheckResult | undefined> {
  const base = { name: "workflow-files", kind: "deterministic", confidence: "high" } as const;
  let bundles: WorkflowFilesOfBundle[];
  let blocked: { id: string; workflowRef: string }[];
  try {
    bundles = remainingWorkflowFiles(stashDir);
    blocked = (await listWorkflowRuns()).runs
      .filter((run) => run.status === "blocked")
      .map(({ id, workflowRef }) => ({ id, workflowRef }));
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      reason: "blocked",
      message: `Could not look for workflow files or runs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (bundles.length === 0 && blocked.length === 0) return undefined;
  const message = [
    ...(bundles.length > 0 ? [describeRemainingWorkflowFiles(bundles)] : []),
    ...(blocked.length > 0 ? [describeBlockedWorkflowRuns(blocked)] : []),
  ].join(" ");
  return {
    ...base,
    status: "warn",
    message,
    evidence: { bundles, files: bundles.flatMap((entry) => entry.files), blockedRuns: blocked },
  };
}
