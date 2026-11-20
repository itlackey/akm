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

const SHOWN = 5;

function workflowFilesIn(root: string): string[] {
  const directory = path.join(root, "workflows");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md")
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** The advisory for the workflow files left in the enabled, writable bundles, or `undefined` when there are none. */
export function collectWorkflowFilesAdvisory(stashDir?: string): HealthCheckResult | undefined {
  const base = { name: "workflow-files", kind: "deterministic", confidence: "high" } as const;
  let files: string[];
  try {
    files = resolveSourceEntries(stashDir)
      .filter((source) => source.writable === true && source.unresolved !== true)
      .flatMap((source) => workflowFilesIn(source.path))
      .sort();
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      reason: "blocked",
      message: `Could not look for workflow files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (files.length === 0) return undefined;
  const shown = files.slice(0, SHOWN).join(", ");
  return {
    ...base,
    status: "warn",
    message:
      `${files.length} workflow file(s) remain: ${shown}${files.length > SHOWN ? ", ..." : ""}. Workflows are removed in 0.11; ` +
      "convert each to a version 5 task with `akm migrate apply <path>`, which reports why a file cannot convert and how to fix it.",
    evidence: { files },
  };
}
