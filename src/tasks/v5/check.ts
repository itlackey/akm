// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Everything the design checks before a version 5 task runs, that does not need
 * running anything: `checkTaskV5` reads the task and every task it runs, all the
 * way down, and throws on the first rule that fails. A start, `doctor explain`
 * and the scheduler call this one function with the same inputs and flags, so
 * what they accept is what a run is given. What one file alone decides is
 * `parseTaskSourceV5Document`'s (`./source.ts`); this adds what needs other
 * files: the assets a step names, the env assets and secrets, the inputs given,
 * and tasks that run each other in a loop.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveEnvBinding } from "../../commands/env/env-binding";
import { assertWorkingFolderCanBeMade } from "../../commands/env/injection";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { resolveSecretPath } from "../../core/env-secret-ref";
import { NotFoundError, UsageError } from "../../core/errors";
import { parseSecretSpec } from "../../core/ref-token";
import {
  applyInputDefaults,
  type InputContract,
  type InputFlag,
  materializeInputFlags,
  validateInputs,
} from "../../execution/input-contract";
import { resolveAssetPath } from "../../sources/resolve";
import { scriptProgram } from "../frozen-script";
import { resolveBundleAsset } from "../run/load-task";
import { parseTaskSource } from "../source/parse-task-source";
import { TASK_V5_INPUT_DIAGNOSTICS } from "../source/task-input-diagnostics";
import { readTaskV5Options, type TaskSourceV5Document, type TaskV5Options, type TaskV5RefKind } from "./source";

/** The flags of a start that are checked as the same options are in a task file. */
export interface TaskV5StartFlags {
  readonly env?: readonly string[];
  readonly secret?: readonly string[];
  readonly inherit?: readonly string[];
  readonly timeout?: string | number;
  readonly maxRetries?: number;
  /** Absolute: a `--cwd` is taken from the folder akm was started in. */
  readonly cwd?: string;
}

export interface TaskV5Bundle {
  readonly name: string;
  readonly dir: string;
}

export interface TaskV5CheckInput {
  /** The task, as typed or as a step names it: `[bundle//]tasks/<name>`. */
  readonly ref: string;
  /** The bundle an unqualified ref is read from. */
  readonly bundle: TaskV5Bundle;
  /** The inputs given, as the command line gives them: an array input repeats its flag. */
  readonly inputs?: readonly InputFlag[];
  readonly flags?: TaskV5StartFlags;
}

const WHOLE_TOKEN = /^\$\{([^}\s]+)\}$/;
const ASSET_TYPE: Readonly<Record<TaskV5RefKind, string>> = {
  tasks: "task",
  commands: "command",
  scripts: "script",
  agents: "agent",
};

interface Visited {
  readonly file: string;
  readonly ref: string;
}

/** Check a task and everything it runs, for a start with these inputs and flags. Returns the task's document. */
export async function checkTaskV5(input: TaskV5CheckInput): Promise<TaskSourceV5Document> {
  const flags = input.flags ?? {};
  checkStartFlags(flags);
  return checkTask(input.bundle, input.ref, input.inputs ?? [], new Set(), [], input.ref);
}

function checkStartFlags(flags: TaskV5StartFlags): void {
  const given: Record<string, unknown> = {};
  if (flags.env !== undefined) given.env = flags.env;
  if (flags.secret !== undefined) given.secret = flags.secret;
  if (flags.inherit !== undefined) given.inherit = flags.inherit;
  if (flags.timeout !== undefined) given.timeout = flags.timeout;
  if (flags.maxRetries !== undefined) given["max-retries"] = flags.maxRetries;
  const options = readTaskV5Options(
    given,
    ["env", "secret", "inherit", "timeout", "max-retries"],
    [],
    new Set(),
    (at, detail) => {
      throw new UsageError(`--${at[0]} ${detail}`, "INVALID_FLAG_VALUE");
    },
  );
  checkOptionRefs(options, "akm run");
  if (flags.cwd !== undefined) assertWorkingFolderCanBeMade(flags.cwd);
}

async function checkTask(
  bundle: TaskV5Bundle,
  ref: string,
  inputs: readonly InputFlag[],
  later: ReadonlySet<string>,
  trail: readonly Visited[],
  where: string,
): Promise<TaskSourceV5Document> {
  const found = await locateTaskV5Asset(bundle, ref, "tasks", where);
  if (trail.some((visited) => visited.file === found.file)) {
    throw new UsageError(
      `Invalid task source v5 at ${found.file}: tasks run each other in a loop: ${[...trail.map((visited) => visited.ref), ref].join(" -> ")}.`,
      "TASK_SOURCE_INVALID",
    );
  }
  const parsed = parseTaskSource({ yaml: fs.readFileSync(found.file, "utf8"), filePath: found.file });
  if (parsed.version === 4) {
    throw new UsageError(
      `Invalid task source v5 at ${where}: ${ref} is a version 4 task, and a version 5 task does not run one. Run \`akm migrate apply\` to convert it.`,
      "TASK_SOURCE_INVALID",
    );
  }
  const document = parsed.v5;
  checkSupplied(document.inputs ?? {}, inputs, later);
  checkOptionRefs(document.options, ref);
  checkWorkingFolder(document.options, found.bundle, ref);
  const visited = [...trail, { file: found.file, ref }];
  for (const step of document.steps) {
    const at = step.name === "" ? ref : `${ref} step ${step.name}`;
    checkOptionRefs(step.options, at);
    checkWorkingFolder(step.options, found.bundle, at);
    if (step.kind === "exec" || step.kind === "prompt") continue;
    const target = step.run as string;
    if (step.kind === "tasks") {
      const given: InputFlag[] = [];
      const known = new Set<string>();
      for (const { name, value } of step.taskInputs ?? []) {
        if (typeof value === "string" && WHOLE_TOKEN.test(value)) known.add(name);
        else given.push({ name, value: typeof value === "boolean" ? value : String(value) });
      }
      await checkTask(found.bundle, target, given, known, visited, at);
      continue;
    }
    const asset = await locateTaskV5Asset(found.bundle, target, step.kind, at);
    if (step.kind === "scripts") {
      scriptProgram(target, asset.file, []);
    }
  }
  return document;
}

/** The file a ref names, in the bundle it is read from, and that bundle. A ref that names nothing is refused. */
export async function locateTaskV5Asset(
  bundle: TaskV5Bundle,
  ref: string,
  kind: TaskV5RefKind,
  where: string,
): Promise<{ file: string; bundle: TaskV5Bundle }> {
  const parsed = parseBundleRef(ref);
  const name = parsed.conceptId.slice(parsed.conceptId.indexOf("/") + 1);
  const type = ASSET_TYPE[kind];
  const owner = parsed.bundle ?? bundle.name;
  try {
    if (owner === bundle.name) return { file: await resolveAssetPath(bundle.dir, type, name), bundle };
    const found = resolveBundleAsset(loadConfig(), { bundle: owner, type, name });
    return { file: found.file, bundle: { name: owner, dir: found.bundleRoot } };
  } catch (cause) {
    throw inContext(where, cause);
  }
}

/**
 * The inputs given, as the task's declared inputs take them: converted to their types, defaults applied, each
 * required one present. One whose value is only known when the step runs counts as given.
 */
function checkSupplied(contract: InputContract, flags: readonly InputFlag[], later: ReadonlySet<string>): void {
  const declared = Object.keys(contract);
  for (const name of later) {
    if (!declared.includes(name)) throw TASK_V5_INPUT_DIAGNOSTICS.unknownFlag(name, [...declared].sort());
  }
  const repeated = flags.find((flag) => later.has(flag.name));
  if (repeated) throw TASK_V5_INPUT_DIAGNOSTICS.duplicateNonArray(repeated.name);
  const known = Object.fromEntries(Object.entries(contract).filter(([name]) => !later.has(name)));
  const defaulted = applyInputDefaults(known, materializeInputFlags(known, flags, TASK_V5_INPUT_DIAGNOSTICS));
  const errors = validateInputs(known, defaulted);
  if (errors.length > 0) throw TASK_V5_INPUT_DIAGNOSTICS.contractViolation(errors);
}

/** The env assets and secrets an `env:` or `secret:` names must exist, and an env asset's own bindings with them. */
function checkOptionRefs(options: Pick<TaskV5Options, "env" | "secret">, where: string): void {
  for (const entry of options.env ?? []) {
    if (typeof entry !== "string") continue;
    try {
      resolveEnvBinding(entry, { locateOnly: true });
    } catch (cause) {
      throw inContext(where, cause);
    }
  }
  for (const spec of options.secret ?? []) {
    try {
      resolveSecretPath((parseSecretSpec(spec) as { ref: string }).ref);
    } catch (cause) {
      throw inContext(where, cause);
    }
  }
}

/** A `cwd:` names a folder that can be made, read from the bundle the task is in. */
function checkWorkingFolder(options: Pick<TaskV5Options, "cwd">, bundle: TaskV5Bundle, where: string): void {
  if (options.cwd === undefined) return;
  try {
    assertWorkingFolderCanBeMade(path.resolve(bundle.dir, options.cwd));
  } catch (cause) {
    throw inContext(where, cause);
  }
}

/** The same error, with where it was found in front of its message. */
function inContext(where: string, cause: unknown): unknown {
  if (cause instanceof NotFoundError) return new NotFoundError(`${where}: ${cause.message}`, cause.code);
  if (cause instanceof UsageError) return new UsageError(`${where}: ${cause.message}`, cause.code);
  return cause;
}
