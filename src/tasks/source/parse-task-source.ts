// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The task source version router.
 *
 * Runs the bounded YAML front end ONCE (`readBoundedTaskSourceYaml`), reads
 * `root.version`, and either dispatches into `parseTaskSourceV4Document` or
 * routes through the in-memory read shim below — no second parse of the v4
 * grammar itself, no re-serialization back to disk, no synthetic document
 * (the shim adds a pure bytes-in/bytes-out detour, never a disk write).
 *
 * The terminal routing table:
 *
 *   | root `version`        | outcome                                                        |
 *   |------------------------|-----------------------------------------------------------------|
 *   | `4`                    | `parseTaskSourceV4Document` — the current grammar               |
 *   | `2` or `3`             | in-memory read shim (below): the SAME pure planners `akm migrate apply` uses (`./task-to-v3.ts`, `./task-to-v4.ts`) convert the bytes already in hand to v4 in memory; the result is parsed and returned with a one-line stderr deprecation warning (once per file per process). If the deterministic conversion itself fails (an unmigratable shape — the file needs a human decision, not a re-run), falls back to `TASK_SCHEMA_VERSION_UNSUPPORTED` naming the specific blocked reason — the shim removes friction for the deterministic case, it never hides a real problem |
 *   | any other number       | `TASK_SCHEMA_VERSION_UNSUPPORTED`, naming the migrator          |
 *   | absent / not a number  | `parseTaskSourceV4Document` — its own `TASK_SOURCE_INVALID` "version is required and must be 4" / "must be exactly 4" wording |
 *
 * A missing or non-numeric `version:` is a MALFORMED v4 document, not a
 * legacy one — it routes into the v4 parser so the field error names the
 * one grammar `src` still accepts, rather than a generic "unsupported"
 * message that would send the user to the migrator for a document that was
 * never task v2 or v3 in the first place.
 *
 * task v2 and task v3 sources are no longer read as their own standing
 * grammar anywhere else in `src` — the only readers of that grammar are the
 * pure, byte-producing planners (`./task-to-v3.ts`, `./task-to-v4.ts`, and
 * the frozen v3 reader `./task-source-v3-frozen.ts`), reached either through
 * this shim (bytes in, bytes out, never touches disk) or through
 * `akm migrate apply` / `akm-migrate` (`scripts/akm-migrate`, which
 * additionally rewrites the file on disk once the user asks for that).
 * Policy: a deterministic byte transform is the tool's job, not the user's —
 * upgrading past a schema bump must not silently break a scheduled task, so
 * v2/v3 files keep reading successfully at the cost of a one-line
 * deprecation warning, and `akm migrate apply` remains available to rewrite
 * the file and silence it. Activation itself is host-local (scheduler
 * config, `src/core/activation-policy.ts`) and this shim never touches it:
 * the v3->v4 planner never hoists the retired `akm.enabled` field to v4's
 * top level and never carries a schedule entry's `enabled` key, so the
 * document this shim hands back carries no enablement at all — the same
 * shape a native v4 document has. The front end's own pre-version failures
 * (source not a string, source too large, YAML parse/warning/expansion)
 * render with the label `task source`.
 */

import { UsageError } from "../../core/errors";
import { warnOnce } from "../../core/warn";
import { readBoundedTaskSourceYaml } from "./bounded-document";
import {
  parseTaskSourceV4,
  parseTaskSourceV4Document,
  TASK_SOURCE_V4_VERSION,
  type TaskSourceV4Document,
} from "./task-source-v4";
import { planTaskToV3File, type TaskToV3FileInput } from "./task-to-v3";
import { planTaskToV4File, type TaskToV4FileInput } from "./task-to-v4";

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

/**
 * Thrown only when the deterministic conversion itself could not produce a
 * task source v4 document — a case where a person must decide the intended
 * behavior (e.g. an ambiguous shell command), not one the migrator can just
 * be re-run to fix. `reason`/`detail` are the SAME blocked outcome
 * `akm migrate status`/`apply` reports for this file, so the message names
 * the actual decision instead of pointing at a command that will report the
 * identical block.
 */
function unmigratableVersionError(filePath: string, version: number, reason: string, detail?: string): UsageError {
  return new UsageError(
    `TASK_SCHEMA_VERSION_UNSUPPORTED: Task at ${filePath} uses task schema version ${version} and needs a human decision before it can run — the deterministic migrator cannot convert it automatically (${reason}${detail ? `: ${detail}` : ""}).`,
    "TASK_SCHEMA_VERSION_UNSUPPORTED",
    "Review the file and resolve the ambiguity by hand, then it will convert normally; `akm migrate status` reports the same reason.",
  );
}

function unsupportedVersionError(filePath: string, version: number): UsageError {
  return new UsageError(
    `TASK_SCHEMA_VERSION_UNSUPPORTED: Task at ${filePath} uses task schema version ${version}, which this release does not accept.`,
    "TASK_SCHEMA_VERSION_UNSUPPORTED",
    TASK_MIGRATE_HINT,
  );
}

/** Why the in-memory shim could not produce a task source v4 document for this file. */
interface PlanInMemoryV4Blocked {
  readonly reason: string;
  readonly detail?: string;
}

/**
 * Plan the SAME bytes already in hand through the pure v3->v4 (and, for v2,
 * chained v2->v3->v4) migration planner(s) — never touches disk, never
 * writes the file, never re-reads it from disk. Returns the produced v4
 * YAML text, or the blocked reason/detail when the deterministic conversion
 * cannot proceed (an unmigratable v2/v3 shape) — the caller falls back to
 * the same hard error this gate threw before the shim existed, now naming
 * that reason.
 */
function planInMemoryV4Bytes(
  version: 2 | 3,
  yaml: string,
  filePath: string,
  workspaceRoot?: string,
): string | PlanInMemoryV4Blocked {
  const bytes = Buffer.from(yaml, "utf8");
  // `writable`/`onDiskWritable` gate the DISK apply path's "don't touch a
  // read-only file" check inside the planners; this shim never writes
  // anything to disk, so that check does not apply here and must not block
  // an otherwise-legal read of a task file that happens to be read-only.
  const baseInput = {
    filePath,
    bytes,
    mode: 0o644,
    writable: true,
    onDiskWritable: true,
    ...(workspaceRoot ? { containmentRoot: workspaceRoot } : {}),
  };

  let v3Bytes: Buffer;
  if (version === 3) {
    v3Bytes = bytes;
  } else {
    const v3Outcome = planTaskToV3File(baseInput as TaskToV3FileInput);
    if (v3Outcome.status !== "changed") return { reason: v3Outcome.reason, detail: v3Outcome.detail };
    v3Bytes = v3Outcome.after;
  }

  const v4Outcome = planTaskToV4File({ ...baseInput, bytes: v3Bytes } as TaskToV4FileInput);
  if (v4Outcome.status !== "changed") return { reason: v4Outcome.reason, detail: v4Outcome.detail };
  return v4Outcome.after.toString("utf8");
}

/** Parse task source YAML, routing per the terminal table above. */
export function parseTaskSource(input: ParseTaskSourceInput): ParsedTaskSource {
  const { root, lineAt } = readBoundedTaskSourceYaml(input, { sourceLabel: "task source" });
  const version = peekTaskSourceVersion(root);
  if (version !== undefined && version !== TASK_SOURCE_V4_VERSION) {
    if (version === 2 || version === 3) {
      const shimmed = planInMemoryV4Bytes(version, input.yaml, input.filePath, input.workspaceRoot);
      if (typeof shimmed === "string") {
        const v4 = parseTaskSourceV4({
          yaml: shimmed,
          filePath: input.filePath,
          ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
        });
        warnOnce(
          `task-source:v${version}-shim:${input.filePath}`,
          `akm: task ${input.filePath} uses schema v${version} — auto-read as v4; run \`akm migrate apply\` to rewrite it and silence this`,
        );
        return Object.freeze({ version: 4 as const, v4 });
      }
      throw unmigratableVersionError(input.filePath, version, shimmed.reason, shimmed.detail);
    }
    throw unsupportedVersionError(input.filePath, version);
  }
  const documentOptions = {
    filePath: input.filePath,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    lineAt,
  };
  return Object.freeze({ version: 4 as const, v4: parseTaskSourceV4Document(root, documentOptions) });
}
