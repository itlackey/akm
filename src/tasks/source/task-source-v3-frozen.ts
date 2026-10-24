// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The frozen task-v3 reader (spec docs/plans/specs/p4-deletions-closeout.md
 * §3.2.4, P4-N1).
 *
 * `src/` no longer accepts task v3; this copy exists so the migrator can
 * still READ what it converts. It is frozen: it is never extended, and a
 * change to task source v4 never propagates here. It deliberately
 * duplicates code that used to live in `src/tasks/source-v3.ts` — moved
 * body-intact, verbatim, from that file as it stood at the parent of P4's
 * commit 2 (`refactor(p4): remove github-action locator grammar from
 * native classification`) — i.e. INCLUDING the GitHub Action locator
 * grammar that commit deleted from native classification.
 * `src/tasks/source/task-to-v4.ts`'s `github-action-target-removed`
 * blocked reason needs this migrator to still be able to CLASSIFY a
 * locator (not merely detect its shape) so it can name the target
 * explicitly rather than guess (`tests/migrate/task-v3-to-v4.test.ts`'s
 * `github-action-target-removed` case).
 *
 * This is the ONLY place the task v3 grammar survives. The frozen-migrator
 * rule runs one way — this file may import from `src/`, `src/` may never
 * import from `scripts/`:
 * `rg -n 'from "\.\./\.\./scripts|from "\.\./scripts|scripts/akm-migrate' src/`
 * returns zero hits, before and after this file exists.
 *
 * Do not "fix" a bug found here by porting a task source v4 change, and do
 * not add a task source v4 feature here. A behavior change to what this
 * file accepts is a behavior change to what the migrator can read FROM —
 * exactly the drift a frozen migrator exists to prevent. Two things this
 * file does NOT carry over from the original, because no migrator module
 * needs them: the bounded-document re-export block (D2-N4's own comment
 * explained that block existed only so OTHER `src/` consumers did not need
 * to import `./source/bounded-document` directly — every consumer here
 * already imports what it needs from `../../tasks/source/bounded-document`
 * on its own), and `taskExtensionDetail`/`TASK_EXTENSION`/
 * `TASK_NEAR_MISS_EXTENSION`/`taskV3SourceErrorDetail` (presentation
 * helpers for `src/`-side consumers, not part of reading a document).
 */

import { type ParsedBuiltinCommandAction, parseBuiltinCommandAction } from "../../commands/command/builtin-action";
import { bundleRefToString, parseBundleRef } from "../../core/asset/asset-ref";
import { UsageError } from "../../core/errors";
import { checkJsonSchemaDefinition } from "../../core/json-schema";
import type { ExecutionJsonObject, ExecutionJsonValue } from "../../execution/json";
import { WORKFLOW_ENV_VAR_NAME_PATTERN } from "../../workflows/resource-limits";
import {
  asRecord,
  type BoundedDocumentContext,
  checkKeys,
  cloneBoundedJson,
  noGithubExpression,
  own,
  parseEnvironment,
  parseStringArray,
  parseTimeout,
  parseTools,
  presentJsonValue,
  readBoundedTaskSourceYaml,
  sourceError,
  stringField,
  TASK_V3_MAX_REDACT_NAMES,
  TASK_V3_MAX_SCHEDULES,
  validateWorkingDirectory,
} from "./bounded-document";

export const TASK_V3_SCHEMA_VERSION = 3 as const;

/** Closed authoring vocabulary. Arbitrary GitHub `{0}` shell templates are not accepted. */
export const TASK_V3_HOST_SHELLS = ["bash", "sh", "zsh", "pwsh", "powershell", "cmd"] as const;
export type TaskV3HostShell = (typeof TASK_V3_HOST_SHELLS)[number];

export const TASK_V2_MIGRATION_HINT =
  "Run `akm migrate apply --dry-run` to preview the task-v2 to task-v3 conversion, then run `akm migrate apply`.";

export function taskV2UnsupportedError(filePath: string, id?: string): UsageError {
  const label = id ? `Task "${id}"` : "Task";
  return new UsageError(
    `TASK_SCHEMA_VERSION_UNSUPPORTED: ${label} uses task schema version 2, which normal execution does not accept. File: ${filePath}`,
    "TASK_SCHEMA_VERSION_UNSUPPORTED",
    TASK_V2_MIGRATION_HINT,
  );
}

export type TaskV3UsesTarget =
  | Readonly<{ kind: "builtin-command"; ref: "akm/command" }>
  | Readonly<{ kind: "command" | "workflow" | "script"; ref: string }>
  | Readonly<{
      kind: "github-action";
      ref: string;
      owner: string;
      repository: string;
      path?: string;
      revision: string;
    }>;

export type TaskV3Environment = Readonly<Record<string, string | number | boolean>>;

export interface TaskV3AkmOptions {
  readonly schedule?: string;
  readonly enabled?: boolean;
  readonly description?: string;
  readonly when_to_use?: string;
  readonly tags?: readonly string[];
  readonly agent?: string | null;
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly outputSchema?: ExecutionJsonObject | null;
  readonly tools?: string | readonly string[] | ExecutionJsonObject | null;
  readonly timeout?: string | number | null;
  readonly redact?: readonly string[];
  readonly maxSteps?: number;
  readonly maxRetries?: number;
}

export type TaskV3Target =
  | Readonly<{
      kind: "uses";
      uses: TaskV3UsesTarget;
      with?: ExecutionJsonObject;
      command?: ParsedBuiltinCommandAction;
    }>
  | Readonly<{
      kind: "run";
      run: string;
      shell?: TaskV3HostShell;
      workingDirectory?: string;
    }>;

export interface TaskV3ScheduleBinding {
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
}

export interface TaskV3TriggerPlan {
  readonly manual: boolean;
  readonly schedules: readonly TaskV3ScheduleBinding[];
}

export interface TaskV3SourceDocument {
  readonly version: typeof TASK_V3_SCHEMA_VERSION;
  readonly name?: string;
  readonly target: TaskV3Target;
  readonly env?: TaskV3Environment;
  readonly akm?: Readonly<TaskV3AkmOptions>;
  readonly triggers: TaskV3TriggerPlan;
  readonly source: Readonly<{ path: string }>;
}

export interface ParseTaskV3DocumentOptions {
  readonly filePath: string;
  /** Required when `working-directory` is authored so symlinks can be contained physically. */
  readonly workspaceRoot?: string;
  /** Internal line lookup supplied by the YAML adapter. */
  readonly lineAt?: (path: readonly (string | number)[]) => number | undefined;
}

export interface ParseTaskV3YamlInput extends Omit<ParseTaskV3DocumentOptions, "lineAt"> {
  readonly yaml: string;
}

export interface ClassifyTaskV3TriggersOptions {
  readonly filePath: string;
  readonly lineAt?: (path: readonly (string | number)[]) => number | undefined;
}

/** This file's own parse context is exactly a `BoundedDocumentContext`. */
type ParseContext = BoundedDocumentContext;

const SOURCE_LABEL = "task v3 source";

/** Build the shared `BoundedDocumentContext` from this file's own (narrower) options shapes. */
function ctxFrom(options: ParseTaskV3DocumentOptions): ParseContext {
  return {
    filePath: options.filePath,
    sourceLabel: SOURCE_LABEL,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.lineAt ? { lineAt: options.lineAt } : {}),
  };
}

const TOP_LEVEL_KEYS = ["version", "name", "uses", "run", "with", "env", "shell", "working-directory", "akm", "on"];
const AKM_KEYS = [
  "schedule",
  "enabled",
  "description",
  "when_to_use",
  "tags",
  "agent",
  "engine",
  "model",
  "inference",
  "outputSchema",
  "tools",
  "timeout",
  "redact",
  "maxSteps",
  "maxRetries",
];
const ON_KEYS = ["schedule", "workflow_dispatch"];
const SHELL_SET = new Set<string>(TASK_V3_HOST_SHELLS);
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+$/;
const GITHUB_ACTION_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const GITHUB_REF_FORBIDDEN = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

function hasForbiddenGithubRefCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || GITHUB_REF_FORBIDDEN.has(character)) return true;
  }
  return false;
}

function nullableSelector(value: unknown, ctx: ParseContext, key: string): string | null {
  const selector = stringField(value, ctx, ["akm", key], { nullable: true });
  if (selector !== null && selector.trim().length === 0)
    sourceError(ctx, ["akm", key], "must be null or a non-empty string.");
  return selector;
}

function parseAkm(value: ExecutionJsonValue, ctx: ParseContext): Readonly<TaskV3AkmOptions> {
  const input = asRecord(value, ctx, ["akm"]);
  checkKeys(input, AKM_KEYS, ctx, ["akm"]);
  const out: Record<string, unknown> = {};
  if (own(input, "schedule")) {
    const schedule = stringField(input.schedule, ctx, ["akm", "schedule"], { nonempty: true }) as string;
    noGithubExpression(schedule, ctx, ["akm", "schedule"]);
    out.schedule = schedule;
  }
  if (own(input, "enabled")) {
    if (typeof input.enabled !== "boolean") sourceError(ctx, ["akm", "enabled"], "must be a boolean.");
    out.enabled = input.enabled;
  }
  for (const key of ["description", "when_to_use"] as const) {
    if (own(input, key)) out[key] = stringField(input[key], ctx, ["akm", key]);
  }
  if (own(input, "tags")) out.tags = parseStringArray(input.tags, ctx, ["akm", "tags"]);
  for (const key of ["agent", "engine", "model"] as const) {
    if (own(input, key)) out[key] = nullableSelector(input[key], ctx, key);
  }
  if (own(input, "inference")) {
    const inference = presentJsonValue(input.inference, ctx, ["akm", "inference"]);
    out.inference = inference === null ? null : asRecord(inference, ctx, ["akm", "inference"]);
  }
  if (own(input, "outputSchema")) {
    const outputSchema = presentJsonValue(input.outputSchema, ctx, ["akm", "outputSchema"]);
    if (outputSchema === null) out.outputSchema = null;
    else {
      const schema = asRecord(outputSchema, ctx, ["akm", "outputSchema"]);
      const issue = checkJsonSchemaDefinition(schema as Record<string, unknown>)[0];
      if (issue) sourceError(ctx, ["akm", "outputSchema"], `is not a supported JSON schema: ${issue.message}`);
      out.outputSchema = schema;
    }
  }
  if (own(input, "tools")) out.tools = parseTools(presentJsonValue(input.tools, ctx, ["akm", "tools"]), ctx);
  if (own(input, "timeout")) out.timeout = parseTimeout(input.timeout, ctx);
  if (own(input, "redact")) {
    const names = parseStringArray(input.redact, ctx, ["akm", "redact"], {
      max: TASK_V3_MAX_REDACT_NAMES,
      pattern: WORKFLOW_ENV_VAR_NAME_PATTERN,
    });
    if (new Set(names).size !== names.length) sourceError(ctx, ["akm", "redact"], "must not contain duplicate names.");
    out.redact = names;
  }
  if (own(input, "maxSteps")) {
    if (!Number.isSafeInteger(input.maxSteps) || (input.maxSteps as number) < 1) {
      sourceError(ctx, ["akm", "maxSteps"], "must be a positive safe integer.");
    }
    out.maxSteps = input.maxSteps;
  }
  if (own(input, "maxRetries")) {
    if (!Number.isSafeInteger(input.maxRetries) || (input.maxRetries as number) < 0) {
      sourceError(ctx, ["akm", "maxRetries"], "must be a non-negative safe integer.");
    }
    out.maxRetries = input.maxRetries;
  }
  return Object.freeze(out) as Readonly<TaskV3AkmOptions>;
}

function validGithubRevision(revision: string): boolean {
  if (
    revision.length === 0 ||
    hasForbiddenGithubRefCharacter(revision) ||
    revision.startsWith("/") ||
    revision.endsWith("/") ||
    revision.includes("..") ||
    revision.includes("@{") ||
    revision.includes("@")
  ) {
    return false;
  }
  return revision
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith(".") &&
        !segment.endsWith(".") &&
        !segment.endsWith(".lock"),
    );
}

/** Classify one exact `uses` string. This function never resolves or guesses. */
export function classifyTaskV3Uses(value: string): TaskV3UsesTarget {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /\s/.test(value) ||
    value.includes("${{")
  ) {
    throw new UsageError(
      "Task v3 uses must be one exact, non-empty executable ref without expressions.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (value === "akm/command") return Object.freeze({ kind: "builtin-command" as const, ref: "akm/command" as const });

  try {
    const parsed = parseBundleRef(value);
    if (parsed.fragment === undefined && bundleRefToString(parsed) === value) {
      const slash = parsed.conceptId.indexOf("/");
      const family = slash < 0 ? "" : parsed.conceptId.slice(0, slash);
      const name = slash < 0 ? "" : parsed.conceptId.slice(slash + 1);
      if (name.length > 0 && (family === "commands" || family === "workflows" || family === "scripts")) {
        const kind = family === "commands" ? "command" : family === "workflows" ? "workflow" : "script";
        return Object.freeze({ kind, ref: value });
      }
      if (family === "agents") {
        throw new UsageError(
          "An agent ref selects a persona and is not executable through task v3 uses.",
          "INVALID_FLAG_VALUE",
        );
      }
      if (family === "tasks") {
        throw new UsageError("A task ref is not an executable task-v3 uses target.", "INVALID_FLAG_VALUE");
      }
    }
  } catch (error) {
    if (error instanceof UsageError && /agent ref|task ref/i.test(error.message)) throw error;
  }

  const at = value.lastIndexOf("@");
  if (at > 0 && at === value.indexOf("@")) {
    const locator = value.slice(0, at);
    const revision = value.slice(at + 1);
    const segments = locator.split("/");
    const [owner, repository, ...actionPath] = segments;
    if (
      owner &&
      repository &&
      GITHUB_OWNER.test(owner) &&
      GITHUB_REPOSITORY.test(repository) &&
      repository !== "." &&
      repository !== ".." &&
      actionPath.every((segment) => GITHUB_ACTION_PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..") &&
      validGithubRevision(revision)
    ) {
      const action = {
        kind: "github-action" as const,
        ref: value,
        owner,
        repository,
        ...(actionPath.length > 0 ? { path: actionPath.join("/") } : {}),
        revision,
      };
      return Object.freeze(action);
    }
  }
  throw new UsageError(
    "Task v3 uses must be akm/command, a canonical commands/, workflows/, or scripts/ asset ref, or owner/repo[/path]@ref. Agent/task/local/Docker/ambiguous targets are not executable.",
    "INVALID_FLAG_VALUE",
  );
}

function parseOn(value: ExecutionJsonValue, ctx: ParseContext): TaskV3TriggerPlan {
  const input = asRecord(value, ctx, ["on"]);
  const keys = Object.keys(input);
  if (keys.length === 0) sourceError(ctx, ["on"], "must declare schedule and/or workflow_dispatch.");
  const unsupported = keys.find((key) => !ON_KEYS.includes(key));
  if (unsupported)
    sourceError(ctx, ["on", unsupported], "is an unsupported local service event; no scheduler binding was created.");
  const schedules: TaskV3ScheduleBinding[] = [];
  if (own(input, "schedule")) {
    if (!Array.isArray(input.schedule) || input.schedule.length === 0) {
      sourceError(ctx, ["on", "schedule"], "must be a non-empty list of {cron: string} records.");
    }
    if (input.schedule.length > TASK_V3_MAX_SCHEDULES) {
      sourceError(ctx, ["on", "schedule"], `accepts at most ${TASK_V3_MAX_SCHEDULES} entries.`);
    }
    for (const [index, raw] of input.schedule.entries()) {
      const entry = asRecord(raw, ctx, ["on", "schedule", index]);
      checkKeys(entry, ["cron"], ctx, ["on", "schedule", index]);
      if (!own(entry, "cron")) sourceError(ctx, ["on", "schedule", index, "cron"], "is required.");
      const cron = stringField(entry.cron, ctx, ["on", "schedule", index, "cron"], { nonempty: true }) as string;
      noGithubExpression(cron, ctx, ["on", "schedule", index, "cron"]);
      schedules.push(Object.freeze({ cron, source: `on.schedule[${index}].cron`, ordinal: index }));
    }
  }
  let manual = false;
  if (own(input, "workflow_dispatch")) {
    const dispatch = input.workflow_dispatch;
    if (dispatch !== null) {
      const mapping = asRecord(presentJsonValue(dispatch, ctx, ["on", "workflow_dispatch"]), ctx, [
        "on",
        "workflow_dispatch",
      ]);
      if (Object.keys(mapping).length > 0) {
        sourceError(ctx, ["on", "workflow_dispatch"], "must be null or an empty mapping; inputs are unsupported.");
      }
    }
    manual = true;
  }
  return Object.freeze({ manual, schedules: Object.freeze(schedules) });
}

function compileTriggers(
  input: ExecutionJsonObject,
  akm: Readonly<TaskV3AkmOptions> | undefined,
  ctx: ParseContext,
): TaskV3TriggerPlan {
  const hasSchedule = akm !== undefined && own(akm, "schedule");
  const hasOn = own(input, "on");
  if (hasSchedule === hasOn) {
    sourceError(ctx, [], "must declare exactly one scheduling source: akm.schedule or on.");
  }
  if (hasOn) return parseOn(presentJsonValue(input.on, ctx, ["on"]), ctx);
  return Object.freeze({
    manual: false,
    schedules: Object.freeze([Object.freeze({ cron: akm?.schedule as string, source: "akm.schedule", ordinal: 0 })]),
  });
}

interface ParsedTaskV3TriggerFields {
  readonly akm?: Readonly<TaskV3AkmOptions>;
  readonly triggers: TaskV3TriggerPlan;
}

function parseTaskV3TriggerFields(input: ExecutionJsonObject, ctx: ParseContext): ParsedTaskV3TriggerFields {
  const akm = own(input, "akm") ? parseAkm(presentJsonValue(input.akm, ctx, ["akm"]), ctx) : undefined;
  return Object.freeze({ ...(akm ? { akm } : {}), triggers: compileTriggers(input, akm, ctx) });
}

/**
 * Classify the strict trigger fragment `{akm?, on?}` into deterministic local
 * scheduler bindings. Unused by the migrator today (the three migrator
 * modules only call `parseTaskV3Yaml`) — vendored anyway for fidelity with
 * the original file this was moved body-intact from, and because
 * `parseTaskV3Document` shares its trigger-parsing helpers
 * (`parseTaskV3TriggerFields`/`compileTriggers`/`parseOn`/`parseAkm`) with
 * it. The LIVE, `src`-side `on:` parser is `parseTriggers`
 * (`src/workflows/github-yaml.ts`, P4-N3) — that one, not this frozen copy,
 * is what workflow compilation uses.
 */
export function classifyTaskV3Triggers(value: unknown, options: ClassifyTaskV3TriggersOptions): TaskV3TriggerPlan {
  const ctx = ctxFrom(options);
  const cloned = cloneBoundedJson(value, ctx, [], { nodes: 0 });
  const input = asRecord(cloned, ctx, []);
  checkKeys(input, ["akm", "on"], ctx, []);
  return parseTaskV3TriggerFields(input, ctx).triggers;
}

export function parseTaskV3Document(value: unknown, options: ParseTaskV3DocumentOptions): TaskV3SourceDocument {
  const ctx = ctxFrom(options);
  const cloned = cloneBoundedJson(value, ctx, [], { nodes: 0 });
  const input = asRecord(cloned, ctx, []);
  if (!own(input, "version")) sourceError(ctx, ["version"], "is required and must be 3.");
  if (input.version === 2) throw taskV2UnsupportedError(options.filePath);
  if (input.version !== TASK_V3_SCHEMA_VERSION) sourceError(ctx, ["version"], "must be exactly 3.");
  checkKeys(input, TOP_LEVEL_KEYS, ctx, []);

  const hasUses = own(input, "uses");
  const hasRun = own(input, "run");
  if (hasUses === hasRun) sourceError(ctx, [], "requires exactly one executable selector: uses or run.");

  const name = own(input, "name") ? (stringField(input.name, ctx, ["name"]) as string) : undefined;
  const env = own(input, "env") ? parseEnvironment(presentJsonValue(input.env, ctx, ["env"]), ctx) : undefined;
  const { akm, triggers } = parseTaskV3TriggerFields(input, ctx);
  let target: TaskV3Target;

  if (hasUses) {
    if (own(input, "shell")) sourceError(ctx, ["shell"], "is legal only with run.");
    if (own(input, "working-directory")) sourceError(ctx, ["working-directory"], "is legal only with run.");
    const usesText = stringField(input.uses, ctx, ["uses"], { nonempty: true }) as string;
    let uses: TaskV3UsesTarget;
    try {
      uses = classifyTaskV3Uses(usesText);
    } catch (cause) {
      sourceError(ctx, ["uses"], cause instanceof Error ? cause.message : String(cause));
    }
    let withValues: ExecutionJsonObject | undefined;
    if (own(input, "with")) withValues = asRecord(presentJsonValue(input.with, ctx, ["with"]), ctx, ["with"]);
    if (uses.kind === "builtin-command") {
      let command: ParsedBuiltinCommandAction;
      try {
        command = parseBuiltinCommandAction(withValues);
      } catch (cause) {
        sourceError(ctx, ["with"], cause instanceof Error ? cause.message : String(cause));
      }
      target = Object.freeze({ kind: "uses", uses, ...(withValues ? { with: withValues } : {}), command });
    } else {
      target = Object.freeze({ kind: "uses", uses, ...(withValues ? { with: withValues } : {}) });
    }
  } else {
    if (own(input, "with")) sourceError(ctx, ["with"], "is legal only with uses.");
    const run = stringField(input.run, ctx, ["run"], { nonempty: true }) as string;
    let shell: TaskV3HostShell | undefined;
    if (own(input, "shell")) {
      const rawShell = stringField(input.shell, ctx, ["shell"], { nonempty: true }) as string;
      if (!SHELL_SET.has(rawShell)) {
        sourceError(ctx, ["shell"], `must be one of the closed host-shell table: ${TASK_V3_HOST_SHELLS.join(", ")}.`);
      }
      shell = rawShell as TaskV3HostShell;
    }
    let workingDirectory: string | undefined;
    if (own(input, "working-directory")) {
      workingDirectory = stringField(input["working-directory"], ctx, ["working-directory"], {
        nonempty: true,
      }) as string;
      validateWorkingDirectory(workingDirectory, ctx);
    }
    target = Object.freeze({
      kind: "run",
      run,
      ...(shell ? { shell } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
    });
  }

  return Object.freeze({
    version: TASK_V3_SCHEMA_VERSION,
    ...(name !== undefined ? { name } : {}),
    target,
    ...(env !== undefined ? { env } : {}),
    ...(akm !== undefined ? { akm } : {}),
    triggers,
    source: Object.freeze({ path: options.filePath }),
  });
}

/**
 * Parse hostile YAML without aliases/tags/merges, then enter the canonical
 * object parser. The bounded-YAML front end itself is
 * `readBoundedTaskSourceYaml` (`src/tasks/source/bounded-document.ts`) —
 * this is a thin wrapper passing `sourceLabel: "task v3 source"`.
 */
export function parseTaskV3Yaml(input: ParseTaskV3YamlInput): TaskV3SourceDocument {
  const { root, lineAt } = readBoundedTaskSourceYaml(input, { sourceLabel: SOURCE_LABEL });
  return parseTaskV3Document(root, {
    filePath: input.filePath,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    lineAt,
  });
}
