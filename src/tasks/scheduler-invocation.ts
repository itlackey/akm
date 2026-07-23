// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { resolveStashDir } from "../core/common";
import { ConfigError } from "../core/errors";
import { getCacheDir, getConfigDir, getDataDir } from "../core/paths";

export const SCHEDULED_TASK_CONTEXT_KEYS = [
  "AKM_STASH_DIR",
  "AKM_CONFIG_DIR",
  "AKM_DATA_DIR",
  "AKM_CACHE_DIR",
  "AKM_STATE_DIR",
] as const;

type ScheduledTaskContextKey = (typeof SCHEDULED_TASK_CONTEXT_KEYS)[number];

export type ScheduledTaskContext = Record<ScheduledTaskContextKey, string>;

export interface ScheduledTaskInvocation {
  argv: string[];
  environment: ScheduledTaskContext;
}

/** Resolve the complete non-secret AKM directory context captured by schedulers. */
export function resolveScheduledTaskContext(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ScheduledTaskContext {
  return canonicalContext({
    AKM_STASH_DIR: path.resolve(resolveStashDir(undefined, env)),
    AKM_CONFIG_DIR: path.resolve(getConfigDir(env, platform)),
    AKM_DATA_DIR: path.resolve(getDataDir(env, platform)),
    AKM_CACHE_DIR: path.resolve(getCacheDir(env)),
    // Retain the legacy state root for scheduled commands and upgrade tooling
    // that still honor it even though current durable state lives under DATA.
    AKM_STATE_DIR: path.resolve(resolveStateDir(env, platform)),
  });
}

/**
 * Build the one scheduler-generated argv shape consumed by all backends.
 *
 * `target` records the bundle a non-primary task lives in as a `--target
 * <bundle>` token so the scheduled `akm tasks run` resolves the task (and its
 * relative asset refs) from that bundle. It is emitted ONLY when supplied and
 * non-empty — callers pass it exclusively for a non-default bundle, so a
 * primary-bundle (or default) task's argv stays byte-identical to pre-0.9.x
 * installs and never shows spurious drift on upgrade.
 */
export function buildScheduledTaskInvocation(
  akmArgv: readonly string[],
  id: string,
  context: ScheduledTaskContext,
  target?: string,
): ScheduledTaskInvocation {
  const environment = canonicalContext(context);
  const targetArgs = target !== undefined && target !== "" ? ["--target", target] : [];
  return {
    argv: [...akmArgv, "tasks", "run", id, ...targetArgs, "--scheduled"],
    environment,
  };
}

function canonicalContext(input: Record<string, unknown>): ScheduledTaskContext {
  const inputKeys = Object.keys(input);
  if (
    inputKeys.length !== SCHEDULED_TASK_CONTEXT_KEYS.length ||
    inputKeys.some((key) => !SCHEDULED_TASK_CONTEXT_KEYS.includes(key as ScheduledTaskContextKey))
  ) {
    throw invalidSchedulerContext();
  }

  const context = {} as ScheduledTaskContext;
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) {
    const value = input[key];
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      containsControlCharacter(value) ||
      (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value))
    ) {
      throw invalidSchedulerContext();
    }
    context[key] = value;
  }
  return context;
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function resolveStateDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const override = env.AKM_STATE_DIR?.trim();
  if (override) return override;

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "akm", "state");
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return path.join(userProfile, "AppData", "Local", "akm", "state");
    const appData = env.APPDATA?.trim();
    if (appData) return path.join(appData, "..", "Local", "akm", "state");
    throw new ConfigError(
      "Unable to determine state directory. Set LOCALAPPDATA, USERPROFILE, or APPDATA.",
      "CONFIG_DIR_UNRESOLVABLE",
    );
  }

  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) return path.join(xdgStateHome, "akm");
  const home = env.HOME?.trim();
  return home ? path.join(home, ".local", "state", "akm") : path.join("/tmp", "akm-state");
}

function invalidSchedulerContext(): ConfigError {
  return new ConfigError(
    `Invalid scheduler context; expected exactly ${SCHEDULED_TASK_CONTEXT_KEYS.join(", ")} as absolute paths.`,
    "INVALID_CONFIG_FILE",
  );
}
