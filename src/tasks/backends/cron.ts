// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// crontab backend for `akm task` (Linux default).
//
// Each akm-owned entry is wrapped in markers so a hand-edited crontab keeps
// its other lines untouched:
//
//     # akm:task <id> BEGIN
//     [SCHED] /abs/akm task run <id> > /home/.../tasks/logs/<id>.log 2>&1
//     # akm:task <id> END
//
// The backend reads/writes the user's crontab via `crontab -l` and
// `crontab -`. Disabling a task comments the entry with `# akm:disabled `
// rather than removing it, so re-enabling preserves the original schedule.
//
// Platform notes:
//   • Operates on the *per-user* crontab — system-wide /etc/cron.d entries
//     are out of scope.
//   • Cron runs jobs with a stripped environment (`SHELL`, `PATH`, `HOME`,
//     `LOGNAME`/`USER` only). The cron line uses an absolute akm path
//     resolved at install time so it doesn't rely on the inherited PATH.
//   • BSD `crontab -l` returns exit 1 with "no crontab for <user>" on a
//     fresh user; a supercronic-managed PATH shim (#910, e.g. OpenPalm's
//     `/tmp/openpalm-bin/crontab` before any spool exists) does the same
//     with empty stdout instead. Both mean "empty crontab", not "broken
//     install" — only a genuinely missing binary (ENOENT from the spawn
//     itself) gets the "install crontab" remedy.
//
// Tests inject a fake exec so unit tests don't touch the real crontab.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { parseSchedule, translateToCron } from "../schedule";
import {
  assertSchedulerExecutionEvidenceDigest,
  assertSchedulerExpectationIdentity,
  assertSchedulerMutationArtifact,
  assertSchedulerNativeArtifactCardinality,
  assertSchedulerNativeArtifactOwner,
  assertSchedulerRemovalArtifact,
  assertSchedulerRollbackArtifactCardinality,
  type SchedulerBackendInspection,
  type SchedulerBinding,
  type SchedulerMutationExpectation,
  type SchedulerNativeArtifact,
  type SchedulerRemovalExpectation,
  type SchedulerRollbackExpectation,
  schedulerBindingNativeId,
  schedulerLogicalBindingId,
  schedulerLogicalBindingOwner,
  schedulerNativeArtifactKey,
} from "../scheduler-binding";
import {
  buildScheduledBindingInvocation,
  type ParsedScheduledBindingInvocation,
  parsePublicSchedulerInvocation,
  parseScheduledBindingArgv,
  resolveScheduledTaskContext,
  SCHEDULER_CONTEXT_ARG,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../scheduler-invocation";
import { type NodeFs, nodeFs, throwIfNotOk } from "./exec-utils";
import type { InstalledSchedulerBinding, SchedulerBackend, SchedulerInstallOptions } from "./types";

export type CronExecResult = {
  status: number;
  stdout: string;
  stderr: string;
  /** True when the `crontab` binary itself could not be spawned (ENOENT), not merely a nonzero exit. */
  enoent?: boolean;
};

export interface CronExec {
  /** Read the user's current crontab. Empty string when none is installed. */
  read(): CronExecResult;
  /** Replace the user's crontab with the given content. */
  write(content: string): CronExecResult;
}

export type CronFs = Pick<NodeFs, "ensureDir"> & Partial<Pick<NodeFs, "writeFile">>;

export interface CronBackendOptions {
  exec?: CronExec;
  fs?: CronFs;
  /** Override the absolute log directory. Defaults to {@link getTaskLogDir}. */
  logDir?: string;
  /** Override the akm invocation argv. Tests use this to skip resolution. */
  akmArgv?: string[];
  /** Override the PATH captured for the scheduled process. Set to false to omit it. */
  envPath?: string | false;
  /** Override the resolved non-secret AKM directory context. */
  scheduledContext?: ScheduledTaskContext;
}

const BEGIN = (id: string) => `# akm:task ${assertCronValue(id)} BEGIN`;
const END = (id: string) => `# akm:task ${assertCronValue(id)} END`;
const DISABLED_PREFIX = "# akm:disabled ";
const BLOCK_RE = /^# akm:task ([\w.@:_-]+) BEGIN$/;
const BLOCK_END_RE = /^# akm:task ([\w.@:_-]+) END$/;
export const PORTABLE_CRON_LINE_LIMIT = 1000;
const CRON_SNAPSHOT = Symbol("akm-cron-binding-snapshot");

interface CronBindingSnapshot {
  readonly kind: typeof CRON_SNAPSHOT;
  readonly nativeIds: readonly string[];
  readonly artifacts: readonly SchedulerNativeArtifact[];
  readonly crontab: string;
}

export function CRON_BACKEND(options: CronBackendOptions = {}): SchedulerBackend {
  const exec = options.exec ?? defaultCronExec();
  const fsLike = options.fs ?? nodeFs();
  const logDir = options.logDir ?? getTaskLogDir();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const envPath = options.envPath === false ? undefined : (options.envPath ?? process.env.PATH);
  const scheduledContext = options.scheduledContext ?? resolveScheduledTaskContext();
  const defaultContextPath = schedulerContextPath(schedulerContextDescriptor(scheduledContext, envPath ?? ""));

  return {
    name: "cron",
    install(task: SchedulerBinding, opts?: SchedulerInstallOptions, expected?: SchedulerMutationExpectation) {
      if (expected) assertSchedulerExpectationIdentity(expected, task);
      // Create the log directory before writing the crontab line — the
      // redirect target's parent directory must exist or the surrounding
      // shell will fail the entire entry.
      const cronLineParts = buildCronLineParts(
        task,
        [...(opts?.binding ?? akmArgv)],
        logDir,
        opts?.contextPath ?? defaultContextPath,
        opts?.target,
      );
      const cronLine = cronLineParts.line;
      assertPortableCronLine(cronLine);
      fsLike.ensureDir(logDir);
      if (cronLineParts.wrapper) {
        if (!fsLike.writeFile) {
          throw new ConfigError(
            "Cron backend needs to write a wrapper script for this task's long invocation, but the configured filesystem cannot write files.",
            "INVALID_CONFIG_FILE",
          );
        }
        fsLike.writeFile(cronLineParts.wrapper.path, cronLineParts.wrapper.content);
      }
      const existing = readCrontab(exec);
      const nativeId = schedulerBindingNativeId(task);
      const blocks = listBlocks(existing);
      const matching = blocks.filter(
        ({ id }) => schedulerNativeArtifactKey(id) === schedulerNativeArtifactKey(nativeId),
      );
      const artifacts = matching.map((block) => cronArtifact(block.id, block.body));
      const priorArtifact = expected
        ? assertSchedulerNativeArtifactCardinality(artifacts, nativeId, expected.state === "absent" ? 0 : 1)
        : matching.length > 1
          ? assertSchedulerNativeArtifactCardinality(artifacts, nativeId, 1)
          : artifacts[0];
      const prior = priorArtifact ? matching.find((block) => block.id === priorArtifact.nativeId) : undefined;
      if (expected) {
        assertSchedulerMutationArtifact(priorArtifact, expected);
      } else if (prior) {
        assertSchedulerNativeArtifactOwner(prior.id, task, extractCronInvocation(prior.body)?.invocation);
      }
      const block = renderBlock(nativeId, cronLine, task.enabled, task.executionEvidenceDigest);
      const next = upsertBlock(existing, nativeId, block);
      replaceCrontab(exec, existing, next);
    },
    uninstall(nativeId: string, expected?: SchedulerRemovalExpectation) {
      if (expected) assertSchedulerExpectationIdentity({ ...expected, state: "present" });
      const existing = readCrontab(exec);
      const matching = listBlocks(existing).filter(
        ({ id }) => schedulerNativeArtifactKey(id) === schedulerNativeArtifactKey(nativeId),
      );
      const priorArtifact = expected
        ? assertSchedulerNativeArtifactCardinality(
            matching.map((block) => cronArtifact(block.id, block.body)),
            nativeId,
            1,
          )
        : undefined;
      const prior = expected
        ? matching.find((block) => block.id === priorArtifact?.nativeId)
        : matching.find(({ id }) => id === nativeId);
      if (!prior) return;
      if (expected) {
        assertSchedulerRemovalArtifact(
          nativeId,
          expected,
          extractCronInvocation(prior.body)?.invocation,
          normalizeSignature(prior.body),
        );
      }
      const next = removeBlock(existing, nativeId);
      replaceCrontab(exec, existing, next);
    },
    setEnabled(nativeId: string, enabled: boolean) {
      const existing = readCrontab(exec);
      const next = toggleBlock(existing, nativeId, enabled);
      replaceCrontab(exec, existing, next);
    },
    list(): InstalledSchedulerBinding[] {
      return [...inspectCronState(readCrontab(exec), defaultContextPath).installed] as InstalledSchedulerBinding[];
    },
    listForRebind() {
      const existing = readCrontab(exec);
      return listBlocks(existing).map(({ id, body }) => {
        const installed = extractCronInvocation(body);
        const ref = {
          id: installed ? schedulerLogicalBindingId(id, installed.invocation) : id,
          signature: normalizeSignature(body),
          ...(installed?.target !== undefined ? { target: installed.target } : {}),
        };
        Object.defineProperty(ref, "nativeId", { value: id });
        if (installed) Object.defineProperty(ref, "invocation", { value: Object.freeze([...installed.invocation]) });
        return ref;
      });
    },
    listNativeArtifacts() {
      return [...inspectCronState(readCrontab(exec), defaultContextPath).artifacts];
    },
    inspectBindings() {
      return inspectCronState(readCrontab(exec), defaultContextPath);
    },
    snapshotBindings(ids: readonly string[]): CronBindingSnapshot {
      const crontab = readCrontab(exec);
      const inspection = inspectCronState(crontab, defaultContextPath);
      const keys = new Set(ids.map(schedulerNativeArtifactKey));
      return Object.freeze({
        kind: CRON_SNAPSHOT,
        nativeIds: Object.freeze([...ids]),
        artifacts: Object.freeze(
          inspection.artifacts.filter((artifact) => keys.has(schedulerNativeArtifactKey(artifact.nativeId))),
        ),
        crontab,
      });
    },
    restoreBindings(snapshot: unknown, expectedCurrent?: readonly SchedulerRollbackExpectation[]) {
      if (!isCronBindingSnapshot(snapshot)) {
        throw new ConfigError("Invalid cron scheduler snapshot.", "INVALID_CONFIG_FILE");
      }
      const existing = readCrontab(exec);
      const current = inspectCronState(existing, defaultContextPath);
      const safeNativeIds: string[] = [];
      const errors: unknown[] = [];
      if (expectedCurrent) {
        for (const nativeId of snapshot.nativeIds) {
          try {
            const expected = expectedCurrent.find((candidate) => candidate.nativeId === nativeId);
            if (!expected) {
              throw new ConfigError(
                `Missing cron rollback expectation for ${JSON.stringify(nativeId)}.`,
                "INVALID_CONFIG_FILE",
              );
            }
            assertSchedulerRollbackArtifactCardinality(current.artifacts, expected);
            safeNativeIds.push(nativeId);
          } catch (error) {
            errors.push(error);
          }
        }
      } else {
        safeNativeIds.push(...snapshot.nativeIds);
      }
      const priorBlocks = new Map(listBlocks(snapshot.crontab).map((block) => [block.id, block] as const));
      let restored = existing;
      for (const nativeId of safeNativeIds) {
        const prior = priorBlocks.get(nativeId);
        restored = prior
          ? upsertBlock(restored, nativeId, [BEGIN(nativeId), prior.body, END(nativeId)].join("\n"))
          : removeBlock(restored, nativeId);
      }
      if (restored !== existing) {
        try {
          replaceCrontab(exec, existing, restored);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Cron rollback CAS rejected one or more changed native artifacts.");
      }
    },
    expectedSignature(task: SchedulerBinding, opts?: SchedulerInstallOptions): string {
      const cronLine = buildCronLine(
        task,
        [...(opts?.binding ?? akmArgv)],
        logDir,
        opts?.contextPath ?? defaultContextPath,
        opts?.target,
      );
      assertPortableCronLine(cronLine);
      return normalizeSignature(cronBlockBody(cronLine, task.enabled, task.executionEvidenceDigest));
    },
  };
}

function inspectCronState(crontab: string, fallbackContextPath: string): SchedulerBackendInspection {
  const installed: InstalledSchedulerBinding[] = [];
  const artifacts: SchedulerNativeArtifact[] = [];
  for (const { id, body } of listBlocks(crontab)) {
    const parsed = extractCronInvocation(body);
    const fingerprint = normalizeSignature(body);
    const artifact = cronArtifact(id, body);
    artifacts.push(artifact);
    if (!parsed) continue;
    const ref: InstalledSchedulerBinding = {
      id: schedulerLogicalBindingId(id, parsed.invocation),
      signature: fingerprint,
      ...(parsed.target !== undefined ? { target: parsed.target } : {}),
      binding: parsed.binding,
      // A legacy (pre-`--scheduler-context`) row has no real descriptor
      // path to report — `extractLegacyCronInvocation` leaves it "". Fall
      // back to the current default so downstream consumers (context
      // validation in `akm task prune`/`explain`, `sync`'s reuse of an
      // existing binding's contextPath) see a real, resolvable descriptor
      // rather than an empty path, since the row is about to be reconciled
      // to a current one anyway (#881).
      contextPath: parsed.contextPath || fallbackContextPath,
    };
    Object.defineProperty(ref, "nativeId", { value: id });
    Object.defineProperty(ref, "invocation", { value: Object.freeze([...parsed.invocation]) });
    installed.push(ref);
  }
  return Object.freeze({ installed: Object.freeze(installed), artifacts: Object.freeze(artifacts) });
}

function cronArtifact(nativeId: string, body: string): SchedulerNativeArtifact {
  const parsed = extractCronInvocation(body);
  const owner = parsed ? schedulerLogicalBindingOwner(nativeId, parsed.invocation) : undefined;
  const artifact: SchedulerNativeArtifact = parsed
    ? {
        nativeId,
        ...(owner !== undefined ? { bindingId: owner } : {}),
        invocation: Object.freeze([...parsed.invocation]),
      }
    : { nativeId };
  Object.defineProperty(artifact, "fingerprint", { value: normalizeSignature(body) });
  return artifact;
}

function isCronBindingSnapshot(value: unknown): value is CronBindingSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === CRON_SNAPSHOT &&
    typeof (value as { crontab?: unknown }).crontab === "string"
  );
}

// ── helpers (exported for tests) ────────────────────────────────────────────

export interface CronWrapperScript {
  readonly path: string;
  readonly content: string;
}

export interface CronLineResult {
  readonly line: string;
  readonly wrapper?: CronWrapperScript;
}

function buildCronLineParts(
  task: SchedulerBinding,
  akmArgv: string[],
  logDir: string,
  contextPath: string,
  _target?: string,
): CronLineResult {
  const spec = parseSchedule(task.cron, "cron");
  const cronExpr = translateToCron(spec);
  const nativeId = schedulerBindingNativeId(task);
  const logPath = path.join(logDir, `${nativeId}.log`);
  const invocation = buildScheduledBindingInvocation(akmArgv, contextPath, task.invocation);
  const cmd = invocation.argv.map((part) => quoteForCron(part)).join(" ");
  // #951: truncate (not append) so this bootstrap safety-net file always
  // holds exactly the latest run's raw output rather than growing forever.
  // akm's own per-run log (src/tasks/run/task-log.ts) already keeps history.
  const directLine = `${cronExpr} ${cmd} > ${quoteForCron(logPath)} 2>&1`;
  if (Buffer.byteLength(directLine, "utf8") <= PORTABLE_CRON_LINE_LIMIT) {
    return { line: directLine };
  }
  const content = cronWrapperScriptContent(invocation.argv);
  const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const wrapperPath = path.join(logDir, `${CRON_WRAPPER_PREFIX}${nativeId}-${contentHash}.sh`);
  const line = `${cronExpr} sh ${quoteForCron(wrapperPath)} > ${quoteForCron(logPath)} 2>&1`;
  return { line, wrapper: { path: wrapperPath, content } };
}

const CRON_WRAPPER_PREFIX = ".akm-cron-wrapper-";

function quoteForShellScript(part: string): string {
  if (/^[A-Za-z0-9_\-./@:=+,]+$/.test(part)) return part;
  return `'${part.replace(/'/g, `'\\''`)}'`;
}

function cronWrapperScriptContent(argv: string[]): string {
  const cmd = argv.map(quoteForShellScript).join(" ");
  return `#!/bin/sh\nexec ${cmd}\n`;
}

export function buildCronLine(
  task: SchedulerBinding,
  akmArgv: string[],
  logDir: string,
  contextPath: string,
  _target?: string,
): string {
  return buildCronLineParts(task, akmArgv, logDir, contextPath, _target).line;
}

/** The crontab line as it appears inside a block — commented when disabled. */
export function cronBlockBody(cronLine: string, enabled: boolean, executionEvidenceDigest?: string): string {
  const lines = [
    cronLine,
    ...(executionEvidenceDigest === undefined
      ? []
      : [`# akm:workflow-evidence ${assertSchedulerExecutionEvidenceDigest(executionEvidenceDigest)}`]),
  ];
  return (enabled ? lines : lines.map((line) => `${DISABLED_PREFIX}${line}`)).join("\n");
}

export function renderBlock(id: string, cronLine: string, enabled: boolean, executionEvidenceDigest?: string): string {
  return [BEGIN(id), cronBlockBody(cronLine, enabled, executionEvidenceDigest), END(id)].join("\n");
}

/**
 * Parse the akm-owned blocks out of a crontab, returning each task id with the
 * raw body line(s) between its BEGIN/END markers. Used by `list()` to build a
 * drift signature, and exported for tests.
 */
export function listBlocks(existing: string): Array<{ id: string; body: string }> {
  return parseBlocks(existing).map(({ id, body }) => ({ id, body }));
}

interface ParsedCronBlock {
  id: string;
  body: string;
  start: number;
  end: number;
}

function parseBlocks(existing: string): ParsedCronBlock[] {
  const out: ParsedCronBlock[] = [];
  const lines = existing.split(/\r?\n/);
  let currentId: string | null = null;
  let start = -1;
  let body: string[] = [];
  for (const [index, line] of lines.entries()) {
    const begin = line.match(BLOCK_RE);
    if (begin) {
      if (currentId !== null) throw malformedBlockError(currentId);
      currentId = begin[1]!;
      start = index;
      body = [];
      continue;
    }
    const end = line.match(BLOCK_END_RE);
    if (end) {
      if (currentId === null || end[1] !== currentId) throw malformedBlockError(currentId ?? end[1]!);
      out.push({ id: currentId, body: body.join("\n"), start, end: index });
      currentId = null;
      start = -1;
      body = [];
      continue;
    }
    if (currentId !== null) body.push(line);
  }
  if (currentId !== null) throw malformedBlockError(currentId);
  return out;
}

function malformedBlockError(id: string): ConfigError {
  return new ConfigError(
    `Crontab contains a malformed akm task block for "${id}"; refusing to modify it.`,
    "INVALID_CONFIG_FILE",
  );
}

/**
 * Recover the bundle name from an installed cron block body by reading the
 * `--bundle <bundle>` token embedded in the scheduled `akm task run …`
 * invocation. Returns undefined for the byte-identical primary/default form
 * (no `--bundle`). Bundle slugs never contain whitespace (config-schema
 * `isBundleSlug`), so the quoted token is a single whitespace-delimited field
 * even when cron-quoted — a plain field split recovers it, and
 * the shell-word parser below reverses the quoting.
 */
export function extractInstalledTarget(body: string): string | undefined {
  return extractCronInvocation(body)?.target;
}

export function extractCronInvocation(body: string): ReturnType<typeof parseScheduledBindingArgv> {
  const line = body.startsWith(DISABLED_PREFIX) ? body.slice(DISABLED_PREFIX.length) : body;
  const fields = splitCronShellWords(line);
  if (fields.length < 6) return undefined;
  let commandStart = 5;
  while (commandStart < fields.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(fields[commandStart]!)) commandStart += 1;
  // #951: newly-installed rows redirect with `>` (truncate); tolerate `>>`
  // (append) too, since that's what every row written before this change —
  // including ones a still-running older akm binary installs during a
  // rolling upgrade — looks like on disk.
  const redirectIndex = fields.findIndex((field, index) => index >= commandStart && (field === ">" || field === ">>"));
  if (redirectIndex === -1) return undefined;
  const tail = fields.slice(commandStart, redirectIndex);
  const parsed = parseScheduledBindingArgv(tail);
  if (parsed) return parsed;
  // Rows written by akm < 0.9.2 (before `--scheduler-context` existed) have
  // no context argument at all — just the akm argv immediately followed by
  // the public `task run …` / `workflow run …` tail. `extractCronInvocation`
  // only ever runs on a body already isolated between this backend's own
  // `# akm:task … BEGIN/END` sentinels (see `parseBlocks`), so recognizing
  // this older shape here doesn't extend trust to any unmarked crontab
  // line — it only lets sync see and reconcile a row akm already owns
  // instead of treating it as absent and colliding with the still-present
  // artifact (#881). Guarded on the marker's absence so a row that DOES
  // carry `--scheduler-context` but fails to parse for some other reason
  // is never silently reinterpreted as legacy.
  if (tail.includes(SCHEDULER_CONTEXT_ARG)) return undefined;
  return extractLegacyCronInvocation(tail);
}

function extractLegacyCronInvocation(tail: readonly string[]): ParsedScheduledBindingInvocation | undefined {
  for (let index = 0; index < tail.length - 1; index += 1) {
    if ((tail[index] === "task" || tail[index] === "workflow") && tail[index + 1] === "run") {
      const publicInvocation = parsePublicSchedulerInvocation(tail.slice(index));
      if (!publicInvocation) return undefined;
      return {
        binding: tail.slice(0, index),
        contextPath: "",
        invocation: publicInvocation.invocation,
        ...(publicInvocation.target !== undefined ? { target: publicInvocation.target } : {}),
      };
    }
  }
  return undefined;
}

/** Reverse {@link quoteForCron} for a single whitespace-free token. */
function splitCronShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "'") {
      quoted = !quoted;
      continue;
    }
    if (char === "\\" && index + 1 < value.length) {
      current += value[index + 1];
      index += 1;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

/** Collapse incidental whitespace so signature comparison ignores it. */
function normalizeSignature(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

export function upsertBlock(existing: string, id: string, block: string): string {
  const trimmed = existing.replace(/\s+$/g, "");
  const removed = removeBlock(trimmed, id);
  const sep = removed.length === 0 ? "" : "\n";
  return `${removed}${sep}${block}\n`;
}

export function removeBlock(existing: string, id: string): string {
  const lines = existing.split(/\r?\n/);
  const blocks = parseBlocks(existing).filter((block) => block.id === id);
  if (blocks.length === 0) return existing;
  const out = lines.filter((_, index) => !blocks.some((block) => index >= block.start && index <= block.end));
  // Collapse trailing blank lines.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

export function toggleBlock(existing: string, id: string, enabled: boolean): string {
  parseBlocks(existing);
  const lines = existing.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock && line === BEGIN(id)) {
      inBlock = true;
      out.push(line);
      continue;
    }
    if (inBlock && line === END(id)) {
      inBlock = false;
      out.push(line);
      continue;
    }
    if (inBlock) {
      const isComment = line.startsWith(DISABLED_PREFIX);
      if (enabled && isComment) {
        out.push(line.slice(DISABLED_PREFIX.length));
      } else if (!enabled && !isComment) {
        out.push(`${DISABLED_PREFIX}${line}`);
      } else {
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function quoteForCron(part: string): string {
  assertCronValue(part);
  // crontab passes the rest of the line to /bin/sh -c, so quote anything that
  // isn't a plain shell-safe token. Single-quote and escape embedded single
  // quotes via the standard shell idiom: `'foo'\''bar'`. Cron interprets `%`
  // before the shell, even inside quotes, so close the quote around its escape.
  if (/^[A-Za-z0-9_\-./@:%=+,]+$/.test(part)) return part.replaceAll("%", "\\%");
  return `'${part.replace(/'/g, `'\\''`).replace(/%/g, `'\\%'`)}'`;
}

function assertCronValue(value: string): string {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new ConfigError("Cron values must not contain control characters.", "INVALID_CONFIG_FILE");
    }
  }
  return value;
}

function assertPortableCronLine(line: string): void {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > PORTABLE_CRON_LINE_LIMIT) {
    throw new ConfigError(
      `Generated cron definition is ${bytes} bytes; portable cron command lines are limited to ${PORTABLE_CRON_LINE_LIMIT} bytes.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

function readCrontab(exec: CronExec): string {
  const result = exec.read();
  if (result.status === 0) return result.stdout ?? "";
  // The spawn itself failed to find the binary (ENOENT) — this is the only
  // case where "install/PATH the crontab binary" is the correct remedy.
  if (result.enoent) {
    throw new ConfigError(
      "crontab -l failed: the `crontab` binary was not found on PATH.",
      "INVALID_CONFIG_FILE",
      "Install the `crontab` binary (e.g. cron/cronie/vixie-cron) or add one to PATH.",
    );
  }
  // #910: a nonzero exit that says nothing at all, or whose stderr says
  // "no crontab" (BSD's "no crontab for <user>"; a supercronic-managed PATH
  // shim like OpenPalm's before any spool exists), is cron's own contract
  // for "empty crontab" — not evidence the binary is missing or broken. A
  // nonzero exit that DID say something else (a permission refusal) is
  // reported as what it said, below.
  const stderr = (result.stderr ?? "").trim();
  if (((result.stdout ?? "").trim() === "" && stderr === "") || /no crontab/i.test(stderr)) return "";
  throw new ConfigError(
    `crontab -l failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
    "INVALID_CONFIG_FILE",
    "The `crontab` binary ran but did not report success; check its output above.",
  );
}

function writeCrontab(exec: CronExec, content: string): void {
  const normalised = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  throwIfNotOk(exec.write(normalised), {
    message: (r) => `crontab - failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
    hint: "Ensure the `crontab` binary is on PATH and your shell can write the user crontab.",
  });
}

function replaceCrontab(exec: CronExec, existing: string, next: string): void {
  try {
    writeCrontab(exec, next);
  } catch (err) {
    try {
      writeCrontab(exec, existing);
    } catch (rollbackError) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AggregateError([err, rollbackError], `${message}; restoring the prior crontab also failed.`);
    }
    throw err;
  }
}

function defaultCronExec(): CronExec {
  return {
    read(): CronExecResult {
      const r = spawnSync("crontab", ["-l"], { encoding: "utf8" });
      return {
        status: r.status ?? 1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        enoent: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
      };
    },
    write(content: string): CronExecResult {
      const r = spawnSync("crontab", ["-"], { encoding: "utf8", input: content });
      return {
        status: r.status ?? 1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        enoent: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
      };
    },
  };
}
