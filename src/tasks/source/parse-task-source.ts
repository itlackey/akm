// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The task source version router.
 *
 * Runs the bounded YAML front end ONCE (`readBoundedTaskSourceYaml`), reads
 * `root.version`, and dispatches into `parseTaskSourceV4Document`. The
 * runtime reads only task source v4 (#987):
 *
 *   | root `version`        | outcome                                                        |
 *   |------------------------|-----------------------------------------------------------------|
 *   | `4`                    | `parseTaskSourceV4Document` — the current grammar               |
 *   | `4`, some `schedule[]` entry carries `enabled` (0.9.15's grammar) | `TASK_SOURCE_INVALID` naming `akm migrate apply`, which removes the key |
 *   | `2` or `3`             | `TASK_SCHEMA_VERSION_UNSUPPORTED` naming `akm migrate apply`, which converts the file |
 *   | any other number       | `TASK_SCHEMA_VERSION_UNSUPPORTED`, naming the migrator          |
 *   | absent / not a number  | `parseTaskSourceV4Document` — its own `TASK_SOURCE_INVALID` "version is required and must be 4" / "must be exactly 4" wording |
 *
 * `akm migrate apply` (`scripts/akm-migrate/`) is the one place a v2/v3
 * document, or a v4 document carrying the retired `schedule[].enabled`, is
 * converted: it rewrites the file once, under a backup. Nothing here converts
 * in memory. Every caller reports the refusal for that one file — `akm task
 * sync` keeps reconciling every other task (#867).
 *
 * A missing or non-numeric `version:` is a MALFORMED v4 document, not a
 * legacy one — it routes into the v4 parser so the field error names the
 * one grammar `src` accepts. The front end's own pre-version failures
 * (source not a string, source too large, YAML parse/warning/expansion)
 * render with the label `task source`.
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

/** Read the root `version` field without over-accepting non-number values (e.g. the string `"4"`). */
export function peekTaskSourceVersion(root: unknown): number | undefined {
  if (root === null || typeof root !== "object" || Array.isArray(root)) return undefined;
  const value = (root as Record<string, unknown>).version;
  return typeof value === "number" ? value : undefined;
}

const TASK_MIGRATE_HINT =
  "Run `akm migrate apply --dry-run` to preview the task-v3 to task-source-v4 conversion, then run `akm migrate apply`.";

/** A v2/v3 document: `akm migrate apply` converts it; this release reads only v4. */
function legacyVersionError(filePath: string, version: number): UsageError {
  return new UsageError(
    `TASK_SCHEMA_VERSION_UNSUPPORTED: Task at ${filePath} uses task schema version ${version}; this release reads only version 4. Run \`akm migrate apply\` to convert it.`,
    "TASK_SCHEMA_VERSION_UNSUPPORTED",
    TASK_MIGRATE_HINT,
  );
}

function unsupportedVersionError(filePath: string, version: number): UsageError {
  return new UsageError(
    `TASK_SCHEMA_VERSION_UNSUPPORTED: Task at ${filePath} uses task schema version ${version}, which this release does not accept.`,
    "TASK_SCHEMA_VERSION_UNSUPPORTED",
    TASK_MIGRATE_HINT,
  );
}

/**
 * True when `root`'s `schedule:` is a sequence with at least one mapping
 * entry that carries an `enabled` key, regardless of that key's value or
 * type — the shape 0.9.15's v4 grammar accepted and this release's does
 * not (`schedule[].enabled`). Activation is host-local `scheduler.enabled`,
 * so the value is never read; `akm migrate apply` removes the key.
 */
export function v4ScheduleHasRetiredEnabledKey(root: unknown): boolean {
  if (root === null || typeof root !== "object" || Array.isArray(root)) return false;
  const schedule = (root as Record<string, unknown>).schedule;
  if (!Array.isArray(schedule)) return false;
  return schedule.some(
    (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) && Object.hasOwn(entry, "enabled"),
  );
}

/** Parse task source YAML, routing per the table above. */
export function parseTaskSource(input: ParseTaskSourceInput): ParsedTaskSource {
  const { root, lineAt } = readBoundedTaskSourceYaml(input, { sourceLabel: "task source" });
  const version = peekTaskSourceVersion(root);
  if (version !== undefined && version !== TASK_SOURCE_V4_VERSION) {
    if (version === 2 || version === 3) throw legacyVersionError(input.filePath, version);
    throw unsupportedVersionError(input.filePath, version);
  }
  if (version === TASK_SOURCE_V4_VERSION && v4ScheduleHasRetiredEnabledKey(root)) {
    throw new UsageError(
      `Invalid task source v4 at ${input.filePath}: schedule[].enabled was removed (scheduler activation is host-local config). Run \`akm migrate apply\` to rewrite it.`,
      "TASK_SOURCE_INVALID",
      TASK_MIGRATE_HINT,
    );
  }
  const documentOptions = {
    filePath: input.filePath,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    lineAt,
  };
  return Object.freeze({ version: 4 as const, v4: parseTaskSourceV4Document(root, documentOptions) });
}
