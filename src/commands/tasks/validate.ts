// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task validate <path>` (#907) — parse ONE task file by filesystem
 * path, not a concept ref/id, and report the same diagnostic `akm task
 * sync` would produce for it. The file need not live in any configured
 * bundle: unlike every other `akm task` subcommand, this one never resolves
 * a bundle/adapter/concept id at all — it reads exactly the path it was
 * given and classifies it.
 *
 * Reuses the exact version-routing shim `parseTaskSource`
 * (`src/tasks/source/parse-task-source.ts`) already applies for every other
 * task-source reader (`akm task sync`'s `compileTaskSources` included) —
 * this module never forks a second parser or a second v2/v3 migration
 * planner. `readBoundedTaskSourceYaml` / `peekTaskSourceVersion` / `own` are
 * the SAME front-end helpers that shim itself calls first; they are used
 * here only to recover the file's ORIGINALLY DECLARED schema version for
 * the report, because `parseTaskSource`'s own `ParsedTaskSource.version` is
 * always `4` post-shim — it cannot answer "was this a v2/v3/v4 file?" on
 * its own once a v2/v3 source has been converted in memory.
 *
 * Beyond parsing, this module also runs the SAME two per-source gates
 * `akm task sync`'s `compileTaskSources` runs before it ever installs a
 * schedule — `assertTaskScheduleInputsSatisfyContract` and
 * `assertTaskScheduleCronValid` (both extracted from `scheduler-sync.ts` for
 * exactly this reuse) — so a file `sync` would reject can never
 * be reported `valid`/`converts` here. Cron dialect is checked against
 * `backendNameForPlatform()`, the same platform default `sync` falls back
 * to whenever it has no injected/native-inspected backend to hand (see
 * `akmTasksAdd`, `src/commands/tasks/tasks.ts`); a bare file was never
 * installed anywhere; there is no native scheduler state to inspect for it.
 *
 * Deliberately DOES NOT call `prepareTaskV3Execution` (the function
 * `compileTaskSources` calls between those two gates) or resolve an
 * execution engine: that path resolves a composed command/persona ref
 * against the local index and lowers the task's cascade-composed
 * engine/model — both of which assume a real, indexed bundle and a
 * configured engine. A bare file passed to `validate` has neither, so
 * running that step would make an otherwise-valid command-kind task report
 * `invalid` on any machine with no engine configured. `resolved`
 * is therefore the compiled task shape `sync` itself would build a
 * scheduler binding from — id, the compiled v4 `version`, `target`
 * (`uses`/`run`), the declared `inputs` contract, and `schedule` bindings —
 * never an execution-lowered plan.
 *
 * Outcome classification (mirrors `parse-task-source.ts`'s own routing
 * table in its header, extended for the two gates above):
 *   - `valid`       — parses as task source v4 directly (declared `version: 4`)
 *                      and passes both sync gates.
 *   - `converts`    — declared `version: 2` or `3`; the deterministic
 *                      in-memory migrator produced a valid v4 document that
 *                      passes both sync gates.
 *   - `blocked`     — declared `version: 2` or `3`; the migrator itself
 *                      could not convert it (an ambiguous/unmigratable
 *                      shape) — the ONLY way `parseTaskSource` ever throws
 *                      for those two version numbers, so no message-text
 *                      sniffing is needed to tell this apart from `invalid`.
 *   - `invalid`     — the document declares SOME version (`4`, or anything
 *                      other than 2/3/4) but fails to parse/validate, OR it
 *                      parsed (directly or via a SUCCESSFUL v2/v3
 *                      conversion) but fails one of the two sync gates
 *                      above, OR the YAML itself does not parse at all
 *                      (a genuine syntax error, not merely a non-task
 *                      shape) — reported with the parser's own reason.
 *   - `not-a-task`  — the document parses as YAML but never declares a
 *                      `version:` field at all (or isn't a YAML mapping) —
 *                      the strongest signal available that the file was
 *                      never intended as a task source in the first place.
 */

import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../core/errors";
import type { InputContract } from "../../execution/input-contract";
import { backendNameForPlatform } from "../../tasks/backends";
import { assertTaskScheduleCronValid, assertTaskScheduleInputsSatisfyContract } from "../../tasks/scheduler-sync";
import { own, readBoundedTaskSourceYaml } from "../../tasks/source/bounded-document";
import { type ParsedTaskSource, parseTaskSource, peekTaskSourceVersion } from "../../tasks/source/parse-task-source";
import type {
  TaskSourceV4Document,
  TaskSourceV4ScheduleBinding,
  TaskSourceV4Target,
} from "../../tasks/source/task-source-v4";

export type TaskValidateOutcome = "valid" | "converts" | "blocked" | "invalid" | "not-a-task";

/**
 * The compiled task shape `akm task sync` would build a scheduler binding
 * from — never an execution-lowered plan (this file's header). No
 * `bundleName`: a bare file path is never resolved against a bundle here,
 * unlike `akm task explain`, so there is nothing genuine to report for it.
 */
export interface TaskValidateResolved {
  readonly id: string;
  readonly version: TaskSourceV4Document["version"];
  readonly name?: string;
  readonly description?: string;
  readonly target: TaskSourceV4Target;
  readonly inputs: InputContract;
  readonly schedule: readonly TaskSourceV4ScheduleBinding[];
}

export interface TaskValidateResult {
  readonly ok: boolean;
  readonly path: string;
  /**
   * The file's own declared task schema version (2, 3, or 4) — absent only
   * for `not-a-task` and for a YAML syntax error, neither of which ever
   * declared one. Named `sourceVersion`, not `schemaVersion`, for the same
   * reason `TaskExplainEnvelope` is (`sourceVersion: 3 | 4`,
   * `src/commands/tasks/explain.ts`): every command registered in
   * `src/output/shapes/passthrough.ts` (this one included) gets an
   * ENVELOPE `schemaVersion` auto-stamped by `makeStampHandler` — a
   * different field the output layer owns, always present, defaulting to
   * `1`. Reusing that name for task-file data would either collide with or
   * be silently overwritten by the envelope's own version field.
   */
  readonly sourceVersion?: number;
  readonly outcome: TaskValidateOutcome;
  /** Present only when `outcome` is not `valid`/`converts` — the diagnostic `akm task sync` would report for this source. */
  readonly reason?: string;
  /** The compiled task shape sync produces (this file's header) — present only on `valid`/`converts`. */
  readonly resolved?: TaskValidateResolved;
}

/** True when `root` is a YAML mapping that itself declares a `version:` key, regardless of that key's type/value. */
function declaresVersionKey(root: unknown): boolean {
  return root !== null && typeof root === "object" && !Array.isArray(root) && own(root, "version");
}

function buildResolved(id: string, v4: TaskSourceV4Document): TaskValidateResolved {
  return {
    id,
    version: v4.version,
    ...(v4.name !== undefined ? { name: v4.name } : {}),
    ...(v4.description !== undefined ? { description: v4.description } : {}),
    target: v4.target,
    inputs: v4.inputs ?? {},
    schedule: v4.schedule,
  };
}

export async function akmTaskValidate(filePath: string): Promise<TaskValidateResult> {
  const resolvedPath = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    throw new UsageError(`Task file not found: ${JSON.stringify(filePath)}.`, "INVALID_FLAG_VALUE");
  }
  if (!stat.isFile()) {
    throw new UsageError(`${JSON.stringify(filePath)} is not a regular file.`, "INVALID_FLAG_VALUE");
  }
  let yaml: string;
  try {
    yaml = fs.readFileSync(resolvedPath, "utf8");
  } catch (cause) {
    throw new UsageError(
      `Task file ${JSON.stringify(filePath)} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      "INVALID_FLAG_VALUE",
    );
  }

  // Peek the declared version BEFORE the real parse, using the identical
  // bounded YAML front end `parseTaskSource` calls internally — never a
  // second/looser YAML reader. A front-end failure here (unparseable YAML,
  // not a mapping, exceeds a resource bound) means the document itself does
  // not parse at all — tracked as `peekFailed` so that case reports
  // `invalid`, never `not-a-task` (`not-a-task` is reserved for
  // YAML that DOES parse but never declared a task shape). The real parse
  // below throws the identical error either way, so nothing is lost by
  // swallowing it here.
  let root: unknown;
  let peekFailed = false;
  try {
    root = readBoundedTaskSourceYaml({ yaml, filePath: resolvedPath }, { sourceLabel: "task source" }).root;
  } catch {
    peekFailed = true;
  }
  const declaredVersion = peekFailed ? undefined : peekTaskSourceVersion(root);
  const hasVersionKey = !peekFailed && declaresVersionKey(root);
  const workspaceRoot = path.dirname(resolvedPath);
  const backend = backendNameForPlatform();

  let parsed: ParsedTaskSource;
  try {
    parsed = parseTaskSource({ yaml, filePath: resolvedPath, workspaceRoot });
  } catch (cause) {
    if (!(cause instanceof UsageError)) throw cause;
    const reason = cause.message;
    // `parseTaskSource` only ever throws for a declared version 2/3 via the
    // unmigratable-conversion branch (see this file's header) — no separate
    // message check needed to recognize "blocked" here.
    if (declaredVersion === 2 || declaredVersion === 3) {
      return { ok: false, path: resolvedPath, sourceVersion: declaredVersion, outcome: "blocked", reason };
    }
    if (peekFailed) {
      return { ok: false, path: resolvedPath, outcome: "invalid", reason };
    }
    if (!hasVersionKey) {
      return { ok: false, path: resolvedPath, outcome: "not-a-task", reason };
    }
    return {
      ok: false,
      path: resolvedPath,
      ...(declaredVersion !== undefined ? { sourceVersion: declaredVersion } : {}),
      outcome: "invalid",
      reason,
    };
  }

  // Success is unreachable from any path that leaves `declaredVersion`
  // undefined — the router requires a numeric 2/3/4 version to reach here.
  const sourceVersion = declaredVersion ?? 4;

  // The document itself parsed (directly, or via a successful v2/v3
  // conversion) — now the two gates `compileTaskSources` runs before
  // accepting it. A violation here is `invalid`, never `blocked`: the
  // migrator already succeeded, so this is the same kind of defect a
  // native v4 document with the identical schedule would have.
  try {
    assertTaskScheduleInputsSatisfyContract(parsed.v4, resolvedPath);
    assertTaskScheduleCronValid(parsed.v4, backend);
  } catch (cause) {
    if (!(cause instanceof UsageError)) throw cause;
    return { ok: false, path: resolvedPath, sourceVersion, outcome: "invalid", reason: cause.message };
  }

  const id = path.parse(resolvedPath).name;
  return {
    ok: true,
    path: resolvedPath,
    sourceVersion,
    outcome: sourceVersion === 2 || sourceVersion === 3 ? "converts" : "valid",
    resolved: buildResolved(id, parsed.v4),
  };
}
