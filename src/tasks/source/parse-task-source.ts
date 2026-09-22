// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Current task-source router.
 *
 * Runtime code accepts only the current v4 grammar. Historical v2/v3 files
 * and the former source-owned `schedule[].enabled` field are handled only by
 * the explicit `akm migrate` executable; execution never translates legacy
 * bytes in memory.
 */

import { UsageError } from "../../core/errors";
import { readBoundedTaskSourceYaml } from "./bounded-document";
import { parseTaskSourceV4Document, TASK_SOURCE_V4_VERSION, type TaskSourceV4Document } from "./task-source-v4";

export type ParsedTaskSource = Readonly<{ version: 4; v4: TaskSourceV4Document }>;

export interface ParseTaskSourceInput {
  readonly yaml: string;
  readonly filePath: string;
  readonly workspaceRoot?: string;
}

export function peekTaskSourceVersion(root: unknown): number | undefined {
  if (root === null || typeof root !== "object" || Array.isArray(root)) return undefined;
  const value = (root as Record<string, unknown>).version;
  return typeof value === "number" ? value : undefined;
}

function unsupportedVersionError(filePath: string, version: number): UsageError {
  return new UsageError(
    `TASK_SCHEMA_VERSION_UNSUPPORTED: Task at ${filePath} uses task schema version ${version}, which this release does not accept.`,
    "TASK_SCHEMA_VERSION_UNSUPPORTED",
    "Run `akm migrate apply --dry-run`, review the plan, then run `akm migrate apply`.",
  );
}

export function parseTaskSource(input: ParseTaskSourceInput): ParsedTaskSource {
  const { root, lineAt } = readBoundedTaskSourceYaml(input, { sourceLabel: "task source" });
  const version = peekTaskSourceVersion(root);
  if (version !== undefined && version !== TASK_SOURCE_V4_VERSION) {
    throw unsupportedVersionError(input.filePath, version);
  }
  const v4 = parseTaskSourceV4Document(root, {
    filePath: input.filePath,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    lineAt,
  });
  return Object.freeze({ version: 4 as const, v4 });
}
