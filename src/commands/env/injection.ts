// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The repeatable `--env <ref>` and `--secret <ref>:<VAR>` flags of `akm run`
 * and `akm exec`: what they resolve to, and the one child spawn `akm exec`
 * makes. Env assets apply in the order given, then secrets over them; a later
 * flag wins over an earlier one for the same variable. Resolution keeps every
 * invariant of `resolveEnvBinding` (nothing is injected when a ref is missing;
 * audit events carry names only).
 */

import { spawnSync } from "node:child_process";
import type { ArgsDef } from "citty";
import { getParsedInvocation } from "../../cli/invocation";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { readValue } from "../../core/secret-value";
import { makeSecretRef, resolveSecretPath } from "../../sources/env-secret-ref";
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

/**
 * Run `command` with `env`, on this terminal, and exit with its status. Never
 * through a shell; the child's own output is not akm's and is not scrubbed.
 */
export function runChild(command: readonly string[], env: Record<string, string | undefined>): void {
  const result = spawnSync(command[0] as string, command.slice(1), { stdio: "inherit", env });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new NotFoundError(
        `Command not found: ${command[0]}`,
        "FILE_NOT_FOUND",
        `Install '${command[0]}' or add its directory to PATH.`,
      );
    }
    if (code === "EACCES") {
      throw new ConfigError(
        `Command not executable: ${command[0]}`,
        "STASH_DIR_UNREADABLE",
        `Add execute permission ('chmod +x ${command[0]}') or invoke via an interpreter.`,
      );
    }
    throw result.error;
  }
  // Not `process.exit`: the CLI's own cleanup still runs before the process ends with the child's status.
  process.exitCode = result.status ?? 0;
}
