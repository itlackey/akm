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
import { getParsedInvocation } from "../../cli/invocation";
import { makeSecretRef, resolveSecretPath } from "../../core/env-secret-ref";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { readValue } from "../../core/secret-value";
import { type ManagedSubprocessResult, runManagedSubprocess } from "../../core/subprocess";
import { withRetries } from "../../execution/retry";
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

/** Resolve this invocation's `--env` and `--secret` flags. */
export function resolveInjections(): ResolvedInjections {
  const invocation = getParsedInvocation();
  const values: Record<string, string> = {};
  const secretValues: string[] = [];
  // Parse every secret spec first, so a malformed one fails before any ref is read or audited.
  const secrets = invocation.getAllFlagValues("--secret").map((spec) => {
    const colon = spec.lastIndexOf(":");
    const varName = spec.slice(colon + 1);
    if (colon <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      throw new UsageError(
        `--secret takes <secret-ref>:<VAR>, for example secrets/deploy-token:GITHUB_TOKEN; got ${JSON.stringify(spec)}.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { ref: spec.slice(0, colon), varName };
  });
  for (const ref of invocation.getAllFlagValues("--env")) {
    const binding = resolveEnvBinding(ref);
    Object.assign(values, binding.values);
    secretValues.push(...binding.secretValues);
  }
  for (const { ref, varName } of secrets) {
    const { conceptId, absPath, source } = resolveSecretPath(ref);
    const value = readValue(absPath);
    values[varName] = value;
    secretValues.push(value);
    appendEvent({ eventType: "secret_access", ref: makeSecretRef(conceptId, source), metadata: { var: varName } });
  }
  return { values, secretValues };
}

/** `rawArgs` without the injection flags and their values; a `--` tail is kept as it is. */
export function withoutInjectionFlags(rawArgs: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i] as string;
    if (arg === "--") return [...kept, ...rawArgs.slice(i)];
    if (INJECTION_FLAGS.includes(arg)) i++;
    else if (!INJECTION_FLAGS.some((flag) => arg.startsWith(`${flag}=`))) kept.push(arg);
  }
  return kept;
}

/** Make `cwd` (and any parents) if missing and return it absolute; a relative one is from the folder akm was started in. */
export function ensureWorkingFolder(cwd: string): string {
  const folder = path.resolve(cwd);
  fs.mkdirSync(folder, { recursive: true });
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
}

/**
 * Run `argv` with `env`, no shell: one program and its arguments. Each try gets the whole
 * `timeoutMs`; a failed try (non-zero exit or timeout) is retried `maxRetries` times. A program
 * that cannot be started is raised, never retried.
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
    (r) => r.spawnError === undefined && (r.timedOut || r.aborted || r.exitCode !== 0),
  );
  if (result.spawnError) throw spawnFailure(argv[0] as string, result.spawnError);
  return result;
}

function spawnFailure(program: string, error: Error): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new NotFoundError(
      `Command not found: ${program}`,
      "FILE_NOT_FOUND",
      `Install '${program}' or add its directory to PATH.`,
    );
  }
  if (code === "EACCES") {
    return new ConfigError(
      `Command not executable: ${program}`,
      "STASH_DIR_UNREADABLE",
      `Add execute permission ('chmod +x ${program}') or invoke via an interpreter.`,
    );
  }
  return error;
}
