// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { resolveStashDir } from "../core/common";
import { ConfigError } from "../core/errors";
import { getTaskContextDir } from "../core/paths";
import { INPUT_NAME_PATTERN } from "../execution/input-contract";
import { normaliseTaskConceptId } from "./task-id";

export const SCHEDULED_TASK_CONTEXT_KEYS = [
  "AKM_BUNDLE_DIR",
  "AKM_CONFIG_DIR",
  "AKM_DATA_DIR",
  "AKM_CACHE_DIR",
  "AKM_STATE_DIR",
] as const;

type ScheduledTaskContextKey = (typeof SCHEDULED_TASK_CONTEXT_KEYS)[number];

/**
 * Directories a descriptor carries ONLY when the process that ran `task sync`
 * had them set explicitly in its environment. They are never resolved from
 * defaults: a descriptor written from inside an app whose environment pointed
 * `$STATE` somewhere private (an OpenCode desktop session, 2026-08 → 2026-09)
 * froze that directory into eight cron rows, and the scheduled improve runs
 * then held their locks in a `locks/` directory no interactive command could
 * see. At fire time an absent key resolves exactly as it does for an
 * interactive command on the same host.
 */
const EXPLICIT_CONTEXT_KEYS = ["AKM_CONFIG_DIR", "AKM_DATA_DIR", "AKM_CACHE_DIR", "AKM_STATE_DIR"] as const;

/**
 * The AKM directory context currently restored from a scheduler descriptor.
 * Child environments that are built from an allowlist must forward this
 * closed set explicitly so nested AKM commands stay in the same installation.
 */
export function scheduledTaskContextEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * `AKM_BUNDLE_DIR` is always present — it is how sync attributes an installed
 * row to the installation that wrote it (#846). Every other key is an
 * explicit override only ({@link EXPLICIT_CONTEXT_KEYS}).
 */
export type ScheduledTaskContext = { AKM_BUNDLE_DIR: string } & Partial<
  Record<(typeof EXPLICIT_CONTEXT_KEYS)[number], string>
>;

export interface ScheduledTaskContextDescriptor {
  version: 1;
  /**
   * `PATH` appears only in descriptors written before 0.9.17, which froze the
   * syncing shell's PATH. The reader still applies it, so a row an older
   * release wrote keeps working until `akm task sync` rewrites it. Current
   * writers put PATH in the native artifact instead: a `PATH=` line in the
   * crontab's akm section, `EnvironmentVariables` in a launchd plist.
   */
  environment: ScheduledTaskContext & { PATH?: string };
}

export interface ScheduledTaskInvocation {
  argv: string[];
}

export interface ParsedScheduledBindingInvocation {
  binding: string[];
  contextPath: string;
  invocation: string[];
  target?: string;
}

export const SCHEDULER_CONTEXT_ARG = "--scheduler-context";

/**
 * The directory context a scheduler descriptor carries: the resolved bundle
 * path, plus whichever `AKM_*_DIR` overrides the syncing process had set
 * explicitly. Resolved defaults are deliberately not captured — see
 * {@link EXPLICIT_CONTEXT_KEYS}.
 */
export function resolveScheduledTaskContext(env: NodeJS.ProcessEnv = process.env): ScheduledTaskContext {
  const context: Record<string, string> = { AKM_BUNDLE_DIR: path.resolve(resolveStashDir(env)) };
  for (const key of EXPLICIT_CONTEXT_KEYS) {
    const value = env[key]?.trim();
    if (value) context[key] = path.resolve(value);
  }
  return canonicalContext(context);
}

/** Build an installed argv from one already-validated public scheduler tail. */
export function buildScheduledBindingInvocation(
  akmArgv: readonly string[],
  contextPath: string,
  invocation: readonly string[],
): ScheduledTaskInvocation {
  const parsed = parsePublicSchedulerInvocation(invocation);
  if (!parsed) throw invalidSchedulerInvocation();
  return {
    argv: [...akmArgv, SCHEDULER_CONTEXT_ARG, assertAbsolutePath(contextPath), ...parsed.invocation],
  };
}

export function schedulerContextDescriptor(
  context: ScheduledTaskContext = resolveScheduledTaskContext(),
): ScheduledTaskContextDescriptor {
  return { version: 1, environment: canonicalContext(context) };
}

export function schedulerContextPath(descriptor: ScheduledTaskContextDescriptor): string {
  const bytes = serializeDescriptor(descriptor);
  const digest = createHash("sha256").update(bytes).digest("hex");
  // The descriptor lives under the data directory it names when it names
  // one, otherwise under this process's own.
  return path.join(getTaskContextDir({ ...process.env, ...descriptor.environment }), `${digest}.json`);
}

/** Write a content-addressed descriptor without ever replacing existing content. */
export function writeSchedulerContextDescriptor(
  descriptor: ScheduledTaskContextDescriptor = schedulerContextDescriptor(),
): string {
  const file = schedulerContextPath(descriptor);
  const bytes = serializeDescriptor(descriptor);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(path.dirname(file), 0o700);
  }
  if (lstatIfExists(file)) {
    if (serializeDescriptor(validateSchedulerContextDescriptor(file)) !== bytes) throw invalidSchedulerContext();
    return file;
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      if (!lstatIfExists(file) || serializeDescriptor(validateSchedulerContextDescriptor(file)) !== bytes) throw error;
    }
    restrictDescriptor(file);
    validateSchedulerContextDescriptor(file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return file;
}

export function loadSchedulerContextDescriptor(file: string, env: NodeJS.ProcessEnv = process.env): void {
  const descriptor = validateSchedulerContextDescriptor(file);
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) {
    const value = descriptor.environment[key];
    if (value !== undefined) env[key] = value;
  }
  if (descriptor.environment.PATH !== undefined) env.PATH = descriptor.environment.PATH;
}

export function validateSchedulerContextDescriptor(file: string): ScheduledTaskContextDescriptor {
  const absolute = assertAbsolutePath(file);
  let linkStat: fs.Stats;
  try {
    linkStat = fs.lstatSync(absolute);
  } catch (error) {
    throw schedulerContextFileError(absolute, error instanceof Error ? error.message : String(error));
  }
  if (linkStat.isSymbolicLink()) throw schedulerContextFileError(absolute, "symbolic links are not allowed");
  if (!linkStat.isFile()) throw schedulerContextFileError(absolute, "path is not a regular file");

  let descriptorBytes: Buffer;
  let fd: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw schedulerContextFileError(absolute, "path is not a regular file");
    if (process.platform !== "win32") {
      if (typeof process.getuid !== "function") {
        throw schedulerContextFileError(absolute, "current uid is unavailable for ownership verification");
      }
      const uid = process.getuid();
      if (stat.uid !== uid)
        throw schedulerContextFileError(absolute, `file owner ${stat.uid} does not match uid ${uid}`);
      if ((stat.mode & 0o077) !== 0) {
        throw schedulerContextFileError(absolute, "group or other permissions must be disabled");
      }
    }
    descriptorBytes = fs.readFileSync(fd);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw schedulerContextFileError(absolute, error instanceof Error ? error.message : String(error));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  const filename = path.basename(absolute);
  const match = /^([a-f0-9]{64})\.json$/.exec(filename);
  const digest = createHash("sha256").update(descriptorBytes).digest("hex");
  if (!match || match[1] !== digest) {
    throw schedulerContextFileError(absolute, "content SHA-256 does not match the descriptor filename");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(descriptorBytes.toString("utf8"));
  } catch (error) {
    throw schedulerContextFileError(absolute, error instanceof Error ? error.message : String(error));
  }
  return canonicalDescriptor(parsed);
}

/** Load and remove the hidden descriptor argument before citty parses argv. */
export function consumeSchedulerContextArg(argv: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const separator = argv.indexOf("--");
  const index = argv.slice(0, separator === -1 ? argv.length : separator).indexOf(SCHEDULER_CONTEXT_ARG);
  if (index === -1) return argv;
  const file = argv[index + 1];
  if (!file) {
    throw new ConfigError(`${SCHEDULER_CONTEXT_ARG} requires an absolute descriptor path.`, "INVALID_CONFIG_FILE");
  }
  loadSchedulerContextDescriptor(file, env);
  return [...argv.slice(0, index), ...argv.slice(index + 2)];
}

/** Parse either the public scheduled task or qualified workflow invocation. */
export function parseScheduledBindingArgv(argv: readonly string[]): ParsedScheduledBindingInvocation | undefined {
  const contextIndex = argv.indexOf(SCHEDULER_CONTEXT_ARG);
  if (contextIndex < 1 || argv.indexOf(SCHEDULER_CONTEXT_ARG, contextIndex + 1) !== -1) return undefined;
  const contextPath = argv[contextIndex + 1];
  if (!contextPath) return undefined;
  const publicInvocation = parsePublicSchedulerInvocation(argv.slice(contextIndex + 2));
  if (!publicInvocation) return undefined;
  return {
    binding: [...argv.slice(0, contextIndex)],
    contextPath: assertAbsolutePath(contextPath),
    invocation: publicInvocation.invocation,
    ...(publicInvocation.target !== undefined ? { target: publicInvocation.target } : {}),
  };
}

/**
 * Parse just the public `task run …` / `workflow run …` tail, with no
 * `--scheduler-context` wrapper. Exported so a backend can recognize a
 * pre-`--scheduler-context` invocation still sitting inside akm's own
 * ownership-marked block (see `extractCronInvocation` in
 * `src/tasks/backends/cron.ts`) without re-implementing this grammar.
 */
export function parsePublicSchedulerInvocation(
  invocation: readonly string[],
): { invocation: string[]; target?: string } | undefined {
  if (invocation[0] === "task" && invocation[1] === "run" && invocation[2]) {
    try {
      if (normaliseTaskConceptId(invocation[2]) !== invocation[2]) return undefined;
    } catch {
      return undefined;
    }
    let index = 3;
    let target: string | undefined;
    if (invocation[index] === "--bundle") {
      target = invocation[index + 1];
      if (!target) return undefined;
      index += 2;
    }
    if (invocation[index] !== "--scheduled") return undefined;
    // P2b Lane B (spec §4.4, §1.7 B-N3): zero or more `--<name> <value>`
    // schedule-supplied input flags may follow `--scheduled` — the same
    // trailing tail `compileTaskSchedulerBindings` compiles from
    // `schedule[i].inputs`. Absent/empty is the pre-P2b shape, byte-identical
    // (B-03).
    if (!isValidSchedulerInputFlagTail(invocation.slice(index + 1))) return undefined;
    return { invocation: [...invocation], ...(target !== undefined ? { target } : {}) };
  }
  if (invocation[0] !== "workflow" || invocation[1] !== "run" || invocation.length !== 3) {
    return undefined;
  }
  const ref = invocation[2];
  if (!ref) return undefined;
  try {
    const parsed = parseBundleRef(ref);
    if (!parsed.bundle || parsed.fragment !== undefined || bundleRefToString(parsed) !== ref) return undefined;
    return { invocation: [...invocation], target: parsed.bundle };
  } catch {
    return undefined;
  }
}

/**
 * Validate an OPTIONAL trailing schedule-input flag tail (spec §1.7 B-N3):
 * empty is valid (the pre-P2b shape). Otherwise the tail is a sequence of
 * entries, each EITHER:
 *
 *   - a single inline `--<name>=<value>` token (code-review finding,
 *     scheduler-binding.ts:536 — the ONLY encoding a dash-leading value's
 *     exact text can round-trip through, since `<value>` here is everything
 *     after the first `=`, whatever its leading character); or
 *   - a `(--<name>, <value>)` pair, where `<value>` is a single non-flag
 *     token (does not start with `-`) — the pre-P2b shape.
 *
 * In both forms `<name>` matches {@link INPUT_NAME_PATTERN} and no name
 * repeats. A bare flag, a repeated name, a flag-shaped value in the pair
 * form, or a malformed token are all refused. This validates SHAPE only;
 * the real materialization against the task's declared contract happens
 * through the same `parseTaskInputFlags` + `materializeInputFlags` path
 * `akm task run --<name>` already uses (B-48) — `parseTaskInputFlags`
 * accepts both forms natively (its inline-`=` branch never inspects the
 * value's leading character).
 */
function isValidSchedulerInputFlagTail(tail: readonly string[]): boolean {
  if (tail.length === 0) return true;
  const seen = new Set<string>();
  let index = 0;
  while (index < tail.length) {
    const token = tail[index];
    if (!token || !token.startsWith("--")) return false;
    const body = token.slice(2);
    const equalsAt = body.indexOf("=");
    if (equalsAt !== -1) {
      const name = body.slice(0, equalsAt);
      if (!INPUT_NAME_PATTERN.test(name) || seen.has(name)) return false;
      seen.add(name);
      index += 1;
      continue;
    }
    if (!INPUT_NAME_PATTERN.test(body) || seen.has(body)) return false;
    const value = tail[index + 1];
    if (value === undefined || value.startsWith("-")) return false;
    seen.add(body);
    index += 2;
  }
  return true;
}

function canonicalContext(input: Record<string, unknown>): ScheduledTaskContext {
  if (Object.keys(input).some((key) => !SCHEDULED_TASK_CONTEXT_KEYS.includes(key as ScheduledTaskContextKey))) {
    throw invalidSchedulerContext();
  }
  const context: Record<string, string> = {};
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) {
    const value = input[key];
    if (value === undefined) {
      if (key === "AKM_BUNDLE_DIR") throw invalidSchedulerContext();
      continue;
    }
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
  return context as ScheduledTaskContext;
}

function canonicalDescriptor(input: unknown): ScheduledTaskContextDescriptor {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalidSchedulerContext();
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 1) throw invalidSchedulerContext();
  const rawEnvironment = record.environment;
  if (typeof rawEnvironment !== "object" || rawEnvironment === null || Array.isArray(rawEnvironment)) {
    throw invalidSchedulerContext();
  }
  const { PATH, ...rawContext } = rawEnvironment as Record<string, unknown>;
  const context = canonicalContext(rawContext);
  return {
    version: 1,
    environment: PATH === undefined ? context : { ...context, PATH: validatePathValue(PATH) },
  };
}

function serializeDescriptor(descriptor: ScheduledTaskContextDescriptor): string {
  return `${JSON.stringify(canonicalDescriptor(descriptor))}\n`;
}

function validatePathValue(value: unknown): string {
  if (typeof value !== "string" || containsControlCharacter(value)) throw invalidSchedulerContext();
  return value;
}

function assertAbsolutePath(value: string): string {
  if (containsControlCharacter(value) || (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value))) {
    throw invalidSchedulerContext();
  }
  return value;
}

function restrictDescriptor(file: string): void {
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function lstatIfExists(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function schedulerContextFileError(file: string, reason: string): ConfigError {
  return new ConfigError(`Invalid scheduler context descriptor "${file}": ${reason}.`, "INVALID_CONFIG_FILE");
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function invalidSchedulerContext(): ConfigError {
  return new ConfigError(
    "Invalid scheduler context; expected AKM_BUNDLE_DIR as an absolute path, " +
      `optionally with ${EXPLICIT_CONTEXT_KEYS.join(", ")} as absolute paths.`,
    "INVALID_CONFIG_FILE",
  );
}

function invalidSchedulerInvocation(): ConfigError {
  return new ConfigError(
    "Invalid scheduler invocation; expected public " +
      "`task run <id> [--bundle <bundle>] --scheduled [--<input> <value>…]` or `workflow run <qualified-ref>` argv.",
    "INVALID_CONFIG_FILE",
  );
}
