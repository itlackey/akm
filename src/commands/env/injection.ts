// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The repeatable `--env <ref>` and `--secret <ref>:<VAR>` flags of `akm run`
 * and `akm exec`: what they resolve to, and the one child run `akm exec`
 * makes (`runProgram`). Env assets apply in the order given, then secrets over them; a later
 * flag wins over an earlier one for the same variable. Resolution keeps every
 * invariant of `resolveEnvBinding` (nothing is injected when a ref is missing;
 * audit events carry names only).
 */

import fs from "node:fs";
import path from "node:path";
import type { ArgsDef } from "citty";
import { getParsedInvocation, type ParsedInvocation } from "../../cli/invocation";
import { makeSecretRef, resolveSecretPath } from "../../core/env-secret-ref";
import { NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { parseSecretSpec } from "../../core/ref-token";
import { readValue } from "../../core/secret-value";
import { endBySignal } from "../../core/signal-observers";
import { type ManagedSubprocessResult, runManagedSubprocess } from "../../core/subprocess";
import { withRetries } from "../../execution/retry";
import type { ScriptOrigin } from "../../tasks/prepare/script-capture";
import { resolveEnvBinding } from "./env-binding";

export const INJECTION_ARGS = {
  env: {
    type: "string",
    description: "Inject every variable of this env asset (`[bundle//]env/<name>`); repeatable",
  },
  secret: {
    type: "string",
    description: "Inject a secret's value as a variable: `<secret-ref>:<VAR>`; repeatable",
  },
} as const satisfies ArgsDef;

const INJECTION_FLAGS = ["--env", "--secret"];

export interface ResolvedInjections {
  /** Variables to set in the child. NEVER print values. */
  values: Record<string, string>;
  /** Every value that came from a `secrets/` ref, for redaction. */
  secretValues: string[];
}

/** Resolve the `--env` and `--secret` flags of `invocation` (this process's own by default). */
export function resolveInjections(invocation: ParsedInvocation = getParsedInvocation()): ResolvedInjections {
  return resolveInjectionRefs({
    env: invocation.getAllFlagValues("--env"),
    secret: invocation.getAllFlagValues("--secret"),
  });
}

/** Resolve env asset refs, in order, then `<secret-ref>:<VAR>` specs over them. */
export function resolveInjectionRefs(refs: {
  env?: readonly string[];
  secret?: readonly string[];
}): ResolvedInjections {
  const values: Record<string, string> = {};
  const secretValues: string[] = [];
  // Parse every secret spec first, so a malformed one fails before any ref is read or audited.
  const secrets = (refs.secret ?? []).map((spec) => {
    const parsed = parseSecretSpec(spec);
    if (parsed === undefined) {
      throw new UsageError(
        `--secret takes <secret-ref>:<VAR>, for example secrets/deploy-token:GITHUB_TOKEN; got ${JSON.stringify(spec)}.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return parsed;
  });
  for (const ref of refs.env ?? []) {
    const binding = resolveEnvBinding(ref);
    Object.assign(values, binding.values);
    secretValues.push(...binding.secretValues);
  }
  for (const { ref, variable } of secrets) {
    const { conceptId, absPath, source } = resolveSecretPath(ref);
    const value = readValue(absPath);
    values[variable] = value;
    secretValues.push(value);
    appendEvent({ eventType: "secret_access", ref: makeSecretRef(conceptId, source), metadata: { var: variable } });
  }
  return { values, secretValues };
}

/** `rawArgs` without the given flags and their values (`booleanFlags` take none); a `--` tail is kept as it is. */
export function withoutFlags(
  rawArgs: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): string[] {
  const kept: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i] as string;
    if (arg === "--") return [...kept, ...rawArgs.slice(i)];
    if (valueFlags.includes(arg)) i++;
    else if (!booleanFlags.includes(arg) && !valueFlags.some((flag) => arg.startsWith(`${flag}=`))) kept.push(arg);
  }
  return kept;
}

/** `rawArgs` without the injection flags and their values; a `--` tail is kept as it is. */
export function withoutInjectionFlags(rawArgs: readonly string[]): string[] {
  return withoutFlags(rawArgs, INJECTION_FLAGS);
}

function refuseWorkingFolder(folder: string, code: string | undefined, where: string): UsageError {
  return new UsageError(`--cwd ${folder} cannot be made: ${code ?? "an error"} on ${where}`, "INVALID_FLAG_VALUE");
}

/**
 * Refuse a working folder that cannot be made. An existing path must be a folder; otherwise the nearest
 * existing ancestor must be a folder this process can write to and enter. Returns the folder, absolute.
 */
export function assertWorkingFolderCanBeMade(cwd: string): string {
  const folder = path.resolve(cwd);
  if (fs.existsSync(folder)) {
    if (!fs.statSync(folder).isDirectory()) throw new UsageError("--cwd <path> is not a folder", "INVALID_FLAG_VALUE");
    return folder;
  }
  let ancestor = path.dirname(folder);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  try {
    if (!fs.statSync(ancestor).isDirectory()) throw Object.assign(new Error("not a folder"), { code: "ENOTDIR" });
    fs.accessSync(ancestor, fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    throw refuseWorkingFolder(folder, (error as NodeJS.ErrnoException).code, ancestor);
  }
  return folder;
}

/** Make `cwd` (and any parents) if missing and return it absolute; a folder that cannot be made is refused ({@link assertWorkingFolderCanBeMade}); a relative one is from the folder akm was started in. */
export function ensureWorkingFolder(cwd: string): string {
  const folder = assertWorkingFolderCanBeMade(cwd);
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (error) {
    throw refuseWorkingFolder(folder, (error as NodeJS.ErrnoException).code, path.dirname(folder));
  }
  return folder;
}

export interface RunProgramOptions {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** false: the child owns this terminal. true: its output comes back in the result. */
  capture: boolean;
  signal?: AbortSignal;
  /** The script `argv` runs, so a program that cannot be started is reported as that script's. */
  script?: ScriptOrigin;
}

/**
 * Run `argv` with `env`, no shell: one program and its arguments. Each try gets the whole
 * `timeoutMs`; a failed try (non-zero exit or timeout) is retried `maxRetries` times. A program
 * that cannot be started, or a run the caller aborted, is not retried.
 */
export async function runProgram(options: RunProgramOptions): Promise<ManagedSubprocessResult> {
  const { argv, env, maxRetries = 0 } = options;
  const cwd = options.cwd === undefined ? undefined : ensureWorkingFolder(options.cwd);
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
  const result = await withRetries(
    maxRetries,
    () =>
      runManagedSubprocess([...argv], {
        capture: options.capture,
        env: childEnv,
        timeoutMs: options.timeoutMs ?? null,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    (r) => r.spawnError === undefined && !r.aborted && (r.timedOut || r.exitCode !== 0),
  );
  if (result.spawnError) throw spawnFailure(argv[0] as string, result.spawnError, options.script);
  // A passthrough child's status is akm's: one that died of a signal ends akm by the same signal.
  if (!options.capture && result.signal && !result.timedOut && !result.aborted) endBySignal(result.signal);
  return result;
}

function isFolder(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** The error for a program that could not be started; `script` names the script whose command it was. */
export function spawnFailure(program: string, error: Error, script?: ScriptOrigin): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" && script) {
    return new NotFoundError(
      script.firstLine
        ? `${script.ref}: its first line ${script.firstLine} names ${program}, which was not found`
        : `${script.ref}: ${program}, the program for its extension, was not found`,
      "FILE_NOT_FOUND",
      script.firstLine
        ? `Install '${program}', or correct the script's first line.`
        : `Install '${program}' or add its directory to PATH, or add a \`#!\` first line naming the program that runs the script.`,
    );
  }
  if (code === "ENOENT") {
    return new NotFoundError(
      `Command not found: ${program}`,
      "FILE_NOT_FOUND",
      `Install '${program}' or add its directory to PATH.`,
    );
  }
  if (code === "EACCES") {
    if (isFolder(program)) {
      return new NotFoundError(
        `Command not executable: ${program} is a folder, not a program`,
        "COMMAND_NOT_EXECUTABLE",
        "Name the program inside it.",
      );
    }
    return new NotFoundError(`Command not executable: ${program}`, "COMMAND_NOT_EXECUTABLE");
  }
  return error;
}
