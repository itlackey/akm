// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How a recorded invocation is classified, for usage capture (src/cli/usage.ts) and the daily usage report
 * (src/cli/usage-report.ts) alike: its event source, the error code it failed with, which outcomes are failures, and
 * which commands and flags akm's own definitions mark Deprecated.
 */

import { AKM_ERROR_CODES } from "../core/errors";
import { resolveAgentIdentity } from "../workflows/runtime/agent-identity";
import type { ArgDefinition, ArgumentUsage, InvocationUsage, UsageCommand } from "./usage";

let errorCode: string | undefined;
/** The `code` of the error the command failed with (`emitJsonError`); a code outside akm's own closed list is not kept. */
export function setUsageErrorCode(code: string | undefined): void {
  if (code !== undefined && AKM_ERROR_CODES.has(code)) errorCode = code;
}
/** The code set since the last take, cleared: usage capture reads it once, when the command finishes. */
export function takeUsageErrorCode(): string | undefined {
  const code = errorCode;
  errorCode = undefined;
  return code;
}

/** The categories that are not failures: a success, a health warning (exit 4) and a cancellation (a signal). */
const NOT_FAILURES: ReadonlySet<string> = new Set(["success", "health-warning", "cancelled"]);

/** Whether an outcome category counts as a failure: every error category, and an exit code akm does not name. */
export function isFailureCategory(category: string): boolean {
  return !NOT_FAILURES.has(category);
}

/** A run the scheduler started: `akm task dispatch`, or `akm run --scheduled` (an earlier row's `akm task run --scheduled`). */
function scheduledRun(usage: InvocationUsage): boolean {
  const command = usage.command.join(" ");
  if (command === "task dispatch") return true;
  return (
    (command === "run" || command === "task run") &&
    usage.arguments.some((a) => a.name === "scheduled" && a.explicit && a.value === true)
  );
}

export const CLI_USAGE_SOURCES: ReadonlySet<string> = new Set(["user", "agent", "task", "improve", "audit", "unknown"]);

/**
 * An explicit `AKM_EVENT_SOURCE` wins; otherwise a run the scheduler started is "task", a detected agent harness is
 * "agent", a terminal with no harness (`terminal`) is "user", and anything else (a pipe, a script, a harness akm does
 * not know) is "unknown".
 */
export function resolveCliUsageSource(env: NodeJS.ProcessEnv, terminal = false, usage?: InvocationUsage): string {
  const explicit = env.AKM_EVENT_SOURCE ?? "";
  if (CLI_USAGE_SOURCES.has(explicit)) return explicit;
  if (usage && scheduledRun(usage)) return "task";
  if (resolveAgentIdentity(env).harness) return "agent";
  return terminal ? "user" : "unknown";
}

/** Whether a definition's own description marks it Deprecated, as its help prints it. */
function markedDeprecated(description: unknown): boolean {
  return typeof description === "string" && /^Deprecated\b/.test(description);
}

/**
 * The Deprecated parts of a command as it was typed, from akm's own definitions: `command` when the typed command or
 * a parent of it is marked Deprecated, and `flags`, the names of the Deprecated flags given explicitly.
 */
export function deprecatedUse(
  root: UsageCommand,
  typed: readonly string[],
  args: readonly Pick<ArgumentUsage, "name" | "explicit">[],
): { command: boolean; flags: string[] } {
  const flags = new Map<string, ArgDefinition>(Object.entries(root.args ?? {}));
  let command = false;
  let node = root;
  for (const token of typed) {
    const next = Object.hasOwn(node.subCommands ?? {}, token) ? node.subCommands?.[token] : undefined;
    if (!next) break;
    node = next;
    command ||= markedDeprecated((node.meta as { description?: unknown } | undefined)?.description);
    for (const [name, definition] of Object.entries(node.args ?? {})) flags.set(name, definition);
  }
  const used = new Set<string>();
  for (const argument of args) {
    if (argument.explicit && markedDeprecated(flags.get(argument.name)?.description)) used.add(argument.name);
  }
  return { command, flags: [...used] };
}

/**
 * What an invocation's detail carries and its aggregate never does, so the daily report cannot read it: the ref of
 * the task it ran in (`AKM_TASK_REF`), and which of it is Deprecated.
 */
export function detailOnly(root: UsageCommand, usage: InvocationUsage, env: NodeJS.ProcessEnv) {
  const deprecated = deprecatedUse(root, usage.invokedCommand ?? usage.command, usage.arguments);
  return {
    ...(env.AKM_TASK_REF ? { task: env.AKM_TASK_REF } : {}),
    ...(deprecated.command || deprecated.flags.length ? { deprecated } : {}),
  };
}
