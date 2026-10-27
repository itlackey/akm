// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task explain <ref> [input flags]` — read-only task introspection.
 *
 * Prints the task source path and owning bundle, its input declarations with
 * defaults, the supplied values WITH PROVENANCE (`default` | `flag` |
 * `schedule-binding`), the resolved target kind + ref, effective execution
 * settings with field-level provenance, and schedule bindings.
 *
 * Read-only, by construction: this module never reserves a durable attempt
 * (`src/tasks/run/attempt-lifecycle.ts` is never imported here), never writes
 * history or a log (`src/tasks/run/task-history.ts` /
 * `src/tasks/run/task-log.ts` are never imported here), never touches the
 * scheduler (`src/tasks/scheduler-*.ts` are never imported here), and reads a
 * composed command/persona REF only through the read-only lookup `akm command
 * run --dry-run` uses (an isolated snapshot of the index, never the live one).
 * A command or persona that cannot be read is reported as the envelope's
 * `execution.problem`, not thrown: the task the caller just wrote is the thing
 * being explained.
 *
 * SECRET-FREE BY CONSTRUCTION for the structural bans below — these hold
 * regardless of any value's shape, because the excluded data never reaches
 * this module in the first place:
 *
 *   - a resolved `env:` value never reaches this module at all — the task's
 *     OWN `env:` map is deliberately never read from the parsed document;
 *   - the composed target's ref is read STRUCTURALLY from the already-parsed
 *     document (`document.target.uses.ref` / `"akm/command"`), never from a
 *     rendered command/persona source — so a `run:` command string,
 *     `with.content`, an inline `akm/command` prompt body, or a stored
 *     command's own rendered content is never read, let alone printed;
 *   - effective execution settings (engine/model/timeout) come from the SAME
 *     entry point `akm command run` uses (`prepareCommandInvocation`), so a
 *     stored command's own frontmatter (its `harness:`, `model:`, `agent:`) and
 *     the persona it names contribute their layers and the target named is the
 *     target `command run --dry-run` names. An inline `akm/command` prompt has
 *     no frontmatter: it goes through `resolveExecution` with a BLANK inline
 *     command. The cascade's "current" layer is built from the TASK's own
 *     `execution` overrides ONLY — connection/harness/engine/model/agent/inference/
 *     outputSchema/timeout, deliberately never `environment`/`workspace`, so no
 *     `runtime.environment` value is ever near this module. Only
 *     `engine`/`model`/`runtime.timeoutMs` and the cascade's own
 *     `{layer,kind,via}` provenance map are read back — never
 *     `request.command`, `request.persona`, `request.conversation`, or
 *     `request.runtime.environment`/`.workspace`.
 *
 * BEST-EFFORT, NOT A GUARANTEE, for input VALUES: a secret-shaped input
 * value is redacted only when `detectSecretShapedParams`
 * (`src/workflows/exec/param-secrets.ts`) recognizes its shape, and that
 * detector is an explicitly best-effort heuristic — its own doc comment
 * acknowledges expected false negatives (a short, low-entropy, or
 * unusually-named credential prints unredacted). A recognized value prints
 * as the literal string `"<redacted>"`, with its row marked
 * `redacted: true`, instead of the real value — applied uniformly across
 * every place a declared or supplied VALUE can appear in this envelope: a
 * declaration's own `default`, each entry of a declaration's own `enum`
 * list (checked per-entry, not as one blanked list), a `suppliedInputs` entry
 * regardless of provenance, and a `schedule[].inputs` entry (the declaration
 * row alone would leave the identical value printed verbatim one section over,
 * in `suppliedInputs`). Do not paste this command's output into an untrusted
 * place on the assumption that it can never contain a credential.
 *
 * Field-level execution provenance is READ from `resolveExecution`'s own
 * `provenance` — this module is a CONSUMER of the one common resolver, never a
 * second resolver: it never re-derives connection, harness or model precedence itself.
 */

import fs from "node:fs";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { SHIPPED_ALIAS } from "../../core/config/model-aliases";
import { ConfigError, NotFoundError } from "../../core/errors";
import {
  applyInputDefaults,
  type InputContract,
  type InputDeclaration,
  type InputFlag,
  materializeInputFlags,
} from "../../execution/input-contract";
import { createInlineResolvedCommand } from "../../execution/resolved-request";
import { isPortableExecutionAgentSelector, type UnresolvedExecutionDefaults } from "../../execution/source";
import { lookupBundleRefReadonly } from "../../indexer/indexer";
import { resolveAdapterConceptOwner } from "../../indexer/lookup/adapter-concept-owner";
import {
  currentLayer,
  type ResolvedExecution,
  resolveExecution,
  shippedAlias,
} from "../../integrations/agent/execution";
import { isSchedulerRefEnabled } from "../../tasks/activation-config";
import type { PreparableTaskDocument } from "../../tasks/prepare/prepared-execution";
import { parseTaskSource } from "../../tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../tasks/source/project-v4";
import { TASK_INPUT_DIAGNOSTICS } from "../../tasks/source/task-input-diagnostics";
import { validateTaskConceptId, validateTaskId } from "../../tasks/task-id";
import { detectSecretShapedParams } from "../../workflows/exec/param-secrets";
import { prepareCommandInvocation } from "../command/command-execution";
import { parseTaskRef, resolveTaskReadBundle, taskIdForAdapter } from "./tasks";

export interface TaskExplainOptions {
  readonly target?: string;
  readonly inputFlags?: readonly InputFlag[];
}

type SuppliedValueProvenance = "default" | "flag";

interface SuppliedInputRow {
  readonly value: unknown;
  readonly provenance: SuppliedValueProvenance;
  readonly redacted?: boolean;
}

interface ScheduleInputRow {
  readonly value: unknown;
  readonly provenance: "schedule-binding";
  readonly redacted?: boolean;
}

interface InputDeclarationRow {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly required: boolean;
  readonly default?: unknown;
  readonly redacted?: boolean;
}

interface ScheduleBindingRow {
  readonly ordinal: number;
  readonly cron: string;
  readonly enabled: boolean;
  readonly source: string;
  readonly inputs: Readonly<Record<string, ScheduleInputRow>>;
}

interface ExecutionSettingsSection {
  readonly engine?: Readonly<{ name: string; kind: string; platform?: string | null }>;
  readonly model?: unknown;
  readonly timeoutMs?: number | null;
  readonly provenance: Readonly<Record<string, Readonly<{ layer: string; kind: string; via: string }>>>;
  /** The command or persona the task names could not be read, so these settings are the defaults without it. */
  readonly problem?: string;
}

export interface TaskExplainEnvelope {
  readonly ref: string;
  readonly taskId: string;
  readonly bundleName: string;
  readonly sourcePath: string;
  readonly sourceVersion: 3 | 4;
  readonly name?: string;
  readonly description?: string;
  readonly target: Readonly<{ kind: string; ref?: string }>;
  readonly inputDeclarations: Readonly<Record<string, InputDeclarationRow>>;
  readonly suppliedInputs: Readonly<Record<string, SuppliedInputRow>>;
  readonly execution: ExecutionSettingsSection;
  readonly schedule: readonly ScheduleBindingRow[];
}

function isSecretShapedValue(name: string, value: unknown): boolean {
  return detectSecretShapedParams({ [name]: value }).length > 0;
}

/**
 * `buildInputDeclarations` redacts a secret-shaped DEFAULT, so
 * `buildSuppliedInputs` (and a v4 schedule entry's own `inputs`, printed
 * verbatim from the source) must redact the identical value too, or a
 * `sk-live-…` default would appear in full in the same envelope. Applied to
 * every supplied/schedule-binding row regardless of provenance, so the same
 * best-effort redaction (see this file's header) applies uniformly across the
 * whole envelope, not just the declaration row.
 */
function redactIfSecretShaped(name: string, value: unknown): Readonly<{ value: unknown; redacted?: boolean }> {
  if (!isSecretShapedValue(name, value)) return { value };
  return { value: "<redacted>", redacted: true };
}

function declarationType(schema: Readonly<Record<string, unknown>>): string | undefined {
  return typeof schema.type === "string" ? schema.type : undefined;
}

function declarationEnum(schema: Readonly<Record<string, unknown>>): readonly unknown[] | undefined {
  return Array.isArray(schema.enum) ? schema.enum : undefined;
}

/**
 * `buildInputDeclarations` redacts a secret-shaped `default` via
 * {@link redactIfSecretShaped} applied to the WHOLE default value, but the
 * identical value appearing in that same declaration's JSON-Schema `enum:`
 * list would print unredacted one key over. Apply the SAME per-value check
 * ({@link isSecretShapedValue}) to each entry independently, replacing only
 * the secret-shaped ones with `"<redacted>"` — deliberately NOT collapsing
 * the whole list to one `"<redacted>"` sentinel the way a single `default`
 * value is, since an `enum` list's non-secret alternatives are useful
 * provenance in their own right and dropping them would over-redact.
 */
function redactEnum(
  name: string,
  values: readonly unknown[],
): Readonly<{ enum: readonly unknown[]; redacted: boolean }> {
  let redacted = false;
  const out = values.map((value) => {
    if (!isSecretShapedValue(name, value)) return value;
    redacted = true;
    return "<redacted>";
  });
  return { enum: out, redacted };
}

function buildInputDeclarations(contract: InputContract): Record<string, InputDeclarationRow> {
  const out: Record<string, InputDeclarationRow> = {};
  for (const [name, declaration] of Object.entries(contract)) {
    const typedDeclaration = declaration as InputDeclaration;
    const hasDefault = Object.hasOwn(typedDeclaration, "default");
    const secretDefault = hasDefault && isSecretShapedValue(name, typedDeclaration.default);
    const enumValues = declarationEnum(typedDeclaration.schema);
    const enumRedaction = enumValues !== undefined ? redactEnum(name, enumValues) : undefined;
    out[name] = {
      ...(declarationType(typedDeclaration.schema) !== undefined
        ? { type: declarationType(typedDeclaration.schema) }
        : {}),
      ...(enumRedaction !== undefined ? { enum: enumRedaction.enum } : {}),
      required: typedDeclaration.required,
      ...(hasDefault ? { default: secretDefault ? "<redacted>" : typedDeclaration.default } : {}),
      ...(secretDefault || enumRedaction?.redacted ? { redacted: true } : {}),
    };
  }
  return out;
}

function buildSuppliedInputs(
  defaultedInputs: Readonly<Record<string, unknown>>,
  materializedInputs: Readonly<Record<string, unknown>>,
): Record<string, SuppliedInputRow> {
  const out: Record<string, SuppliedInputRow> = {};
  for (const [name, value] of Object.entries(defaultedInputs)) {
    const provenance: SuppliedValueProvenance = Object.hasOwn(materializedInputs, name) ? "flag" : "default";
    const redaction = redactIfSecretShaped(name, value);
    out[name] = { value: redaction.value, provenance, ...(redaction.redacted ? { redacted: true } : {}) };
  }
  return out;
}

/** The composed target's kind + ref, read STRUCTURALLY off the already-parsed document — never from a rendered command/persona source. */
function targetSection(document: PreparableTaskDocument): Readonly<{ kind: string; ref?: string }> {
  if (document.target.kind === "run") return { kind: "shell" };
  const uses = document.target.uses;
  return { kind: uses.kind, ref: uses.ref };
}

/** True only for the two `uses:` kinds an execution cascade (connection, harness and model resolution) actually applies to. */
function isCommandTarget(document: PreparableTaskDocument): boolean {
  return (
    document.target.kind === "uses" &&
    (document.target.uses.kind === "builtin-command" || document.target.uses.kind === "command")
  );
}

/**
 * The task's own top-level execution overrides (`document.akm`, D2-N7's
 * home for both a v3 document's authored `akm.*` and a v4 document's
 * projected `execution` block) as a cascade "current" layer — the exact
 * non-secret subset `src/tasks/prepare/prepare-support.ts`'s
 * `currentExecutionValues` also forwards, minus `workspace`/`environment`
 * (this module never reads `env:`, see this file's header).
 */
function currentExecutionValues(document: PreparableTaskDocument, bundleName: string): Record<string, unknown> {
  const akm = document.akm;
  if (!akm) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["connection", "harness", "engine", "model", "inference", "outputSchema", "timeout"] as const) {
    if (Object.hasOwn(akm, key)) out[key] = akm[key];
  }
  if (Object.hasOwn(akm, "agent")) {
    const agent = akm.agent;
    out.agent =
      typeof agent === "string" && isPortableExecutionAgentSelector(agent) ? qualifyInBundle(agent, bundleName) : agent;
  }
  return out;
}

/** A ref the task wrote, relative to its own bundle unless it names one. */
function qualifyInBundle(ref: string, bundleName: string): string {
  const parsed = parseBundleRef(ref);
  return makeBundleRef(parsed.bundle ?? bundleName, parsed.conceptId);
}

/** The stored command the task runs, if it runs one; an inline `akm/command` prompt has none. */
function storedCommandRef(document: PreparableTaskDocument): string | undefined {
  if (document.target.kind !== "uses") return undefined;
  if (document.target.uses.kind === "command") return document.target.uses.ref;
  const command = document.target.command;
  return command?.kind === "stored" ? command.ref : undefined;
}

/**
 * Effective execution settings + field-level provenance for a command-kind
 * target. A stored command is prepared the way `akm command run --dry-run`
 * prepares it; one that cannot be (a missing command or persona) falls back to
 * the cascade without it, with the reason in `problem`.
 */
async function resolveExecutionSettings(
  document: PreparableTaskDocument,
  bundleName: string,
): Promise<ExecutionSettingsSection> {
  if (!isCommandTarget(document)) return { provenance: {} };
  const config = loadConfig();
  const current = currentExecutionValues(document, bundleName);
  const ref = storedCommandRef(document);
  let problem: string | undefined;
  let prepared: ResolvedExecution | undefined;
  if (ref !== undefined) {
    try {
      prepared = await prepareCommandInvocation({
        action: { ref: qualifyInBundle(ref, bundleName) },
        config,
        current: current as UnresolvedExecutionDefaults,
        sourceLookup: lookupBundleRefReadonly,
      });
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      problem = error instanceof Error ? error.message : String(error);
    }
  }
  prepared ??= resolveExecution({
    command: createInlineResolvedCommand({ template: "", content: "" }),
    config,
    layers: [
      shippedAlias(SHIPPED_ALIAS.agent),
      { id: "task-explain", kind: "command", values: {} },
      ...(Object.keys(current).length > 0 ? [currentLayer(current)] : []),
    ],
  });
  const target = prepared.request.target;
  return {
    engine: {
      name: target.name,
      kind: target.kind,
      ...(target.platform !== undefined ? { platform: target.platform } : {}),
    },
    ...(prepared.request.model !== undefined ? { model: prepared.request.model } : {}),
    ...(prepared.request.runtime.timeoutMs !== undefined ? { timeoutMs: prepared.request.runtime.timeoutMs } : {}),
    provenance: prepared.provenance,
    ...(problem !== undefined ? { problem } : {}),
  };
}

/**
 * Resolve, parse, and project one task asset into an explain envelope with
 * every secret-shaped value redacted on a best-effort basis (see this
 * file's header). Read-only: no history write, no scheduler touch, no
 * execution spawn.
 */
export async function akmTaskExplain(ref: string, options: TaskExplainOptions = {}): Promise<TaskExplainEnvelope> {
  const parsedRef = parseTaskRef(ref);
  const bundle = resolveTaskReadBundle(parsedRef.bundle, options.target);
  const adapterId = bundle.source.adapterId ?? detectAdapterId(bundle.source.path);
  const id = taskIdForAdapter(parsedRef.id, adapterId);
  if (adapterId === "akm-task") validateTaskConceptId(id);
  else validateTaskId(id);
  const taskConceptId = adapterId === "akm" ? `tasks/${id}` : id;
  const owner = resolveAdapterConceptOwner(bundle.source.path, adapterId, taskConceptId);
  if (!owner) {
    throw new NotFoundError(
      `Task ${JSON.stringify(ref)} was not found in the configured ${JSON.stringify(adapterId)} component.`,
      "ASSET_NOT_FOUND",
    );
  }
  const sourcePath = owner.path;
  const yaml = fs.readFileSync(sourcePath, "utf8");
  const parsed = parseTaskSource({ yaml, filePath: sourcePath });

  const inputContract: InputContract = parsed.v4.inputs ?? {};
  // `akm task run`'s
  // load-task.ts copies this same materialize -> applyInputDefaults ->
  // validateInputs ladder, but its own trailing `validateInputs` +
  // `contractViolation` throw is load-task's OWN enforcement that a task
  // about to actually EXECUTE never dispatches with a required input still
  // unmet. `explain` never dispatches anything (this file's header) — it is
  // read-only introspection, and a task's declared-but-unsupplied required
  // input is exactly the fact `explain` exists to surface, not a condition
  // that should make the command refuse to print. Deliberately NOT calling
  // `validateInputs` here: `materializeInputFlags` above still runs its own
  // per-flag validation (an unknown flag name still fails UNKNOWN_FLAG; a
  // supplied value failing its own declared schema still fails
  // here), so only the "required and never supplied at all" case is left
  // unenforced. `buildSuppliedInputs` below naturally renders that case as a
  // declaration row (always present, carrying `required: true`) with no
  // corresponding `suppliedInputs` entry, since `defaultedInputs` has no key
  // for an input with neither a default nor a supplied value.
  const materializedInputs = materializeInputFlags(inputContract, options.inputFlags ?? [], TASK_INPUT_DIAGNOSTICS);
  const defaultedInputs = applyInputDefaults(inputContract, materializedInputs);

  const document: PreparableTaskDocument = projectTaskSourceV4(parsed.v4);
  const enabled = isSchedulerRefEnabled(loadConfig(), makeBundleRef(bundle.source.name, taskConceptId));

  const schedule: ScheduleBindingRow[] = parsed.v4.schedule.map((entry) => ({
    ordinal: entry.ordinal,
    cron: entry.cron,
    enabled,
    source: entry.source,
    inputs: Object.fromEntries(
      Object.entries(entry.inputs).map(([name, value]) => {
        const redaction = redactIfSecretShaped(name, value);
        return [
          name,
          {
            value: redaction.value,
            provenance: "schedule-binding" as const,
            ...(redaction.redacted ? { redacted: true } : {}),
          },
        ];
      }),
    ),
  }));

  return {
    ref,
    taskId: id,
    bundleName: bundle.source.name,
    sourcePath,
    sourceVersion: parsed.version,
    ...(parsed.v4.name !== undefined ? { name: parsed.v4.name } : {}),
    ...(parsed.v4.description !== undefined ? { description: parsed.v4.description } : {}),
    target: targetSection(document),
    inputDeclarations: buildInputDeclarations(inputContract),
    suppliedInputs: buildSuppliedInputs(defaultedInputs, materializedInputs),
    execution: await resolveExecutionSettings(document, bundle.source.name),
    schedule,
  };
}
