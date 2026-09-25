// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig } from "../../core/config/config-types";
import { UsageError } from "../../core/errors";
import {
  createInlineResolvedCommand,
  createResolvedCommand,
  createResolvedPersona,
  type LoweringNotice,
  type ResolvedCommandContent,
} from "../../execution/resolved-request";
import {
  type AdapterRenderedCommandSource,
  type AdapterRenderedExecutionSource,
  type AdapterRenderedPersonaSource,
  isPortableExecutionAgentSelector,
  type UnresolvedExecutionDefaults,
} from "../../execution/source";
import { recordIndexedShowUsage } from "../../indexer/usage/show-usage";
import { resolveUsageEventSource, type UsageEventSource } from "../../indexer/usage/usage-events";
import { fallbackAnnouncement } from "../../integrations/agent/engine-fallback";
import {
  buildExecution,
  type ExecutionFieldProvenance,
  type ResolvedExecution,
  resolveExecution,
} from "../../integrations/agent/execution";
import type { ResolvedModelMapV1 } from "../../integrations/agent/model-map";
import { type RunExecutionOptions, runExecution } from "../../integrations/agent/runner-dispatch";
import type { AgentRunResult } from "../../integrations/agent/spawn";
import { parseBuiltinCommandAction } from "./builtin-action";
import {
  type ExecutionSourceLookup,
  type LoadAdapterExecutionSourceOptions,
  loadAdapterExecutionSource,
} from "./execution-source-loader";
import { applyPortableCommandArguments } from "./portable-template";

export type CommandExecutionSourceLoader = (
  ref: string,
  kind: "command" | "persona",
  options?: LoadAdapterExecutionSourceOptions,
) => Promise<AdapterRenderedExecutionSource>;

export interface PrepareCommandInvocationOptions {
  readonly action: unknown;
  readonly config: AkmConfig;
  readonly modelMap?: ResolvedModelMapV1;
  readonly sourceLoader?: CommandExecutionSourceLoader;
  /** Optional index lookup capability; dry-run supplies a read-only isolated snapshot lookup. */
  readonly sourceLookup?: ExecutionSourceLookup;
  readonly invocationDefaults?: UnresolvedExecutionDefaults;
  readonly current?: UnresolvedExecutionDefaults;
  /** Authored workflow prose is already classified as literal by source IR and must bypass portable templating. */
  readonly inlineContentMode?: "portable-template" | "literal";
}

export type PreparedCommandInvocation = ResolvedExecution;

export interface CommandDispatchResult {
  readonly schemaVersion: 2;
  readonly ok: boolean;
  readonly shape: "agent-result";
  readonly engine: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error?: string;
  readonly reason?: string;
  readonly warnings?: readonly string[];
  readonly notices?: readonly Readonly<LoweringNotice>[];
}

export interface CommandDiagnosticProvenance {
  readonly field: string;
  readonly layer: string;
  readonly kind: ExecutionFieldProvenance["kind"];
  readonly via: ExecutionFieldProvenance["via"];
}

export interface CommandDiagnosticNotice {
  readonly code: string;
  readonly severity: "info" | "warning";
  readonly adapter: string;
  readonly field?: string;
  readonly message: string;
}

export interface CommandDryRunResult {
  readonly schemaVersion: 1;
  readonly shape: "command-dry-run";
  readonly ok: true;
  readonly dryRun: true;
  readonly engine: string;
  readonly provenance: readonly Readonly<CommandDiagnosticProvenance>[];
  readonly notices: readonly Readonly<CommandDiagnosticNotice>[];
}

export interface DispatchPreparedCommandOptions {
  readonly runAgent?: RunExecutionOptions["runAgent"];
  readonly runSdk?: RunExecutionOptions["runSdk"];
  readonly runOptions?: RunExecutionOptions["runOptions"];
  readonly chat?: RunExecutionOptions["chat"];
  /**
   * F-1 (spec docs/plans/specs/p1b-model-extraction.md §5.2 point 3, R-07
   * fix): task-runner provenance. When present, it (a) becomes the FALLBACK
   * for `resolveUsageEventSource` — an ambient `AKM_EVENT_SOURCE` still wins
   * — used for the usage events recorded against any consumed command/persona
   * ref, and (b) stamps `AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ??
   * eventSource` into the child env handed to the dispatched engine (the
   * `env` bag `runAgent`/`runSdk` receive), matching the native arm. Absent
   * (every non-task caller: `akm command run`, `akm agent`, …) this function
   * is byte-identical to before P1b.
   */
  readonly eventSource?: UsageEventSource;
}

/**
 * The ambient `AKM_EVENT_SOURCE` wins over the task runner's provenance; it
 * rides `runExecution`'s single-purpose `eventSource`, never `runOptions.env`,
 * so a caller cannot replace the request's own environment.
 */
function runOptionsFor(options: DispatchPreparedCommandOptions): RunExecutionOptions {
  const { eventSource, ...rest } = options;
  if (eventSource === undefined) return rest;
  return { ...rest, eventSource: process.env.AKM_EVENT_SOURCE ?? eventSource };
}

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function selectAgent(
  command: UnresolvedExecutionDefaults,
  invocationDefaults: UnresolvedExecutionDefaults | undefined,
  current: UnresolvedExecutionDefaults | undefined,
): { present: boolean; value?: string | null; source: "command" | "invocation" | "current" } {
  let selected: { present: boolean; value?: string | null; source: "command" | "invocation" | "current" } = {
    present: false,
    source: "command",
  };
  for (const [source, values] of [
    ["command", command],
    ["invocation", invocationDefaults],
    ["current", current],
  ] as const) {
    if (values && own(values, "agent")) selected = { present: true, value: values.agent, source };
  }
  return selected;
}

function defaultSourceLoader(
  ref: string,
  kind: "command" | "persona",
  options?: LoadAdapterExecutionSourceOptions,
): Promise<AdapterRenderedExecutionSource> {
  return kind === "command"
    ? loadAdapterExecutionSource(ref, "command", options)
    : loadAdapterExecutionSource(ref, "persona", options);
}

function qualifyCommandSelectedPersona(selector: string, command: AdapterRenderedCommandSource | undefined): string {
  if (!command || selector.includes("//")) return selector;
  return `${command.identity.bundle}//${selector}`;
}

export async function prepareCommandInvocation(
  options: PrepareCommandInvocationOptions,
): Promise<PreparedCommandInvocation> {
  const action = parseBuiltinCommandAction(options.action);
  const sourceLoader = options.sourceLoader ?? defaultSourceLoader;
  let renderedCommand: AdapterRenderedCommandSource | undefined;
  let commandDefaults: UnresolvedExecutionDefaults = Object.freeze({});
  let command: ResolvedCommandContent;
  if (action.kind === "stored") {
    const rendered = await sourceLoader(action.ref, "command", {
      config: options.config,
      ...(options.sourceLookup ? { lookup: options.sourceLookup } : {}),
    });
    if (rendered.kind !== "command") throw new TypeError("command source loader returned a non-command source");
    renderedCommand = rendered;
    commandDefaults = rendered.defaults;
    const applied = applyPortableCommandArguments(rendered.content, action.arguments, rendered.identity.ref);
    command = createResolvedCommand({
      source: rendered,
      ...(own(applied, "argumentInput") ? { argumentInput: applied.argumentInput } : {}),
      content: applied.content,
    });
  } else {
    if (options.inlineContentMode === "literal") {
      if (action.arguments !== undefined) {
        throw new UsageError("Literal inline command content cannot declare portable arguments.", "INVALID_FLAG_VALUE");
      }
      command = createInlineResolvedCommand({ template: action.content, content: action.content });
    } else {
      const applied = applyPortableCommandArguments(action.content, action.arguments, "inline command");
      command = createInlineResolvedCommand({
        template: applied.template,
        ...(own(applied, "argumentInput") ? { argumentInput: applied.argumentInput } : {}),
        content: applied.content,
      });
    }
  }

  const selectedAgent = selectAgent(commandDefaults, options.invocationDefaults, options.current);
  let renderedPersona: AdapterRenderedPersonaSource | undefined;
  if (
    selectedAgent.present &&
    typeof selectedAgent.value === "string" &&
    isPortableExecutionAgentSelector(selectedAgent.value)
  ) {
    const lookupRef =
      selectedAgent.source === "command"
        ? qualifyCommandSelectedPersona(selectedAgent.value, renderedCommand)
        : selectedAgent.value;
    const rendered = await sourceLoader(lookupRef, "persona", {
      config: options.config,
      ...(options.sourceLookup ? { lookup: options.sourceLookup } : {}),
    });
    if (rendered.kind !== "persona") throw new TypeError("persona source loader returned a non-persona source");
    renderedPersona = rendered;
  }
  const persona = renderedPersona ? createResolvedPersona(renderedPersona) : selectedAgent.present ? null : undefined;

  return resolveExecution({
    command,
    config: options.config,
    ...(persona !== undefined ? { persona } : {}),
    ...(renderedPersona ? { agentLayer: { id: renderedPersona.identity.ref, values: renderedPersona.defaults } } : {}),
    commandLayer: {
      id: renderedCommand?.identity.ref ?? "inline-command",
      values: commandDefaults,
    },
    ...(options.invocationDefaults ? { invocationDefaults: options.invocationDefaults } : {}),
    ...(options.current ? { current: options.current } : {}),
    ...(options.modelMap ? { modelMap: options.modelMap } : {}),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const DIAGNOSTIC_PROVENANCE_FIELDS = new Set([
  "/inference",
  "agent",
  "authorization",
  "command",
  "engine",
  "engine.requested",
  "model",
  "outputSchema",
  "persona",
  "runtime.environment",
  "runtime.settings",
  "runtime.timeoutMs",
  "runtime.workspace",
  "tools",
]);

const DIAGNOSTIC_NOTICE_FIELDS = new Set([
  "agent",
  "command.content",
  "command.extensions",
  "conversation",
  "engine",
  "engine.extensions",
  "extensions",
  "inference",
  "model",
  "outputSchema",
  "persona",
  "persona.extensions",
  "runtime.environment",
  "runtime.extensions",
  "runtime.settings",
  "runtime.timeoutMs",
  "runtime.workspace",
  "tools",
]);

function canonicalDiagnosticProvenanceField(field: string): string | undefined {
  if (field.startsWith("/inference/")) return "/inference/*";
  return DIAGNOSTIC_PROVENANCE_FIELDS.has(field) ? field : undefined;
}

function canonicalDiagnosticNoticeField(field: string | null | undefined): string | undefined {
  if (typeof field !== "string") return undefined;
  if (field.startsWith("inference.")) return "inference.*";
  return DIAGNOSTIC_NOTICE_FIELDS.has(field) ? field : undefined;
}

function diagnosticProvenance(
  provenance: ResolvedExecution["provenance"],
): readonly Readonly<CommandDiagnosticProvenance>[] {
  const canonical = new Map<string, Readonly<CommandDiagnosticProvenance>>();
  for (const [field, source] of Object.entries(provenance)) {
    const safeField = canonicalDiagnosticProvenanceField(field);
    if (!safeField) continue;
    const candidate = Object.freeze({ field: safeField, layer: source.layer, kind: source.kind, via: source.via });
    const previous = canonical.get(safeField);
    if (!previous || compareText(JSON.stringify(candidate), JSON.stringify(previous)) < 0) {
      canonical.set(safeField, candidate);
    }
  }
  return Object.freeze([...canonical.values()].sort((left, right) => compareText(left.field, right.field)));
}

function safeDiagnosticToken(value: string): boolean {
  return value.length <= 128 && /^[a-z][a-z0-9-]*$/.test(value);
}

/** Rebuild a known lowerer notice instead of forwarding its optional details or arbitrary message bytes. */
function safeDiagnosticNotice(notice: Readonly<LoweringNotice>): Readonly<CommandDiagnosticNotice> | undefined {
  if (!safeDiagnosticToken(notice.adapter)) return undefined;
  switch (notice.code) {
    case "untranslated-field": {
      const field = canonicalDiagnosticNoticeField(notice.field);
      if (!field) return undefined;
      return Object.freeze({
        code: "untranslated-field",
        severity: "warning",
        adapter: notice.adapter,
        field,
        message: `The ${notice.adapter} lowerer does not translate resolved field ${field}; dispatch will continue optimistically.`,
      });
    }
    case "conversation-prompt-composed":
      return Object.freeze({
        code: "conversation-prompt-composed",
        severity: "warning",
        adapter: notice.adapter,
        field: "conversation",
        message: `The ${notice.adapter} transport has no native multi-message channel; AKM composed the conversation prefix into one deterministic JSON prompt block.`,
      });
    case "persona-prompt-composed":
      return Object.freeze({
        code: "persona-prompt-composed",
        severity: "info",
        adapter: notice.adapter,
        field: "persona",
        message: "The selected engine has no native persona channel; AKM composed the persona into the prompt.",
      });
    default:
      return undefined;
  }
}

function diagnosticNotices(notices: readonly Readonly<LoweringNotice>[]): readonly Readonly<CommandDiagnosticNotice>[] {
  const canonical = new Map<string, Readonly<CommandDiagnosticNotice>>();
  for (const notice of notices) {
    const safe = safeDiagnosticNotice(notice);
    if (safe) canonical.set(JSON.stringify(safe), safe);
  }
  return Object.freeze(
    [...canonical.values()].sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right))),
  );
}

/**
 * Build a prepared invocation and project only safe structural diagnostics.
 * Reads no credential, records no usage, and exposes no request values.
 */
export function inspectPreparedCommandInvocation(prepared: PreparedCommandInvocation): CommandDryRunResult {
  const built = buildExecution(prepared.request, prepared.runner);
  return Object.freeze({
    schemaVersion: 1,
    shape: "command-dry-run",
    ok: true,
    dryRun: true,
    engine: prepared.request.engine.name,
    provenance: diagnosticProvenance(prepared.provenance),
    notices: diagnosticNotices(built.notices),
  });
}

function resultEnvelope(
  result: AgentRunResult,
  engine: string,
  warnings: readonly string[],
  notices: readonly Readonly<LoweringNotice>[],
): CommandDispatchResult {
  return {
    schemaVersion: 2,
    ok: result.ok,
    shape: "agent-result",
    engine,
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: result.durationMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}

export async function dispatchPreparedCommandInvocation(
  prepared: PreparedCommandInvocation,
  options: DispatchPreparedCommandOptions = {},
): Promise<CommandDispatchResult> {
  const { request } = prepared;
  const built = buildExecution(request, prepared.runner);
  const selectedEngine = request.engine.name;
  const result = await runExecution(built, runOptionsFor(options));
  const consumedRefs = new Set<string>();
  if (request.command.source) consumedRefs.add(request.command.source.ref);
  if (request.persona) consumedRefs.add(request.persona.source.ref);
  // F-1 (spec §5.2 point 3): options.eventSource is only a FALLBACK — an
  // ambient AKM_EVENT_SOURCE still wins (D5 clause d). Absent, this is
  // byte-identical to the pre-P1b bare resolveUsageEventSource() call (P-07's
  // own default is "user").
  const eventSource = resolveUsageEventSource(process.env, options.eventSource ?? "user");
  for (const ref of consumedRefs) recordIndexedShowUsage(ref, eventSource);
  const announcement = fallbackAnnouncement(prepared.fallbackEngineName, selectedEngine);
  return resultEnvelope(result, selectedEngine, announcement ? [announcement] : [], built.notices);
}

export async function executeCommandInvocation(
  options: PrepareCommandInvocationOptions,
  dispatchOptions: DispatchPreparedCommandOptions = {},
): Promise<CommandDispatchResult> {
  return dispatchPreparedCommandInvocation(await prepareCommandInvocation(options), dispatchOptions);
}
