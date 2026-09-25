// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * File-private helpers prepareTaskV3Execution depends on, moved body-intact
 * out of the pre-P1b src/tasks/runtime-v3.ts (spec
 * docs/plans/specs/p1b-model-extraction.md §4.1, Lane B / D4 module map).
 * None of these was exported at head either; only the subset prepare.ts's
 * moved function body calls is exported here.
 */

import path from "node:path";
import type { PreparedCommandInvocation } from "../../commands/command/command-execution";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { COMPOSITION_INVALID_MULTI_JOB_HINT, ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import { isPortableExecutionAgentSelector, type UnresolvedExecutionDefaults } from "../../execution/source";
import { buildExecution } from "../../integrations/agent/execution";
import { resolveAssetPath } from "../../sources/resolve";
import { detectSecretShapedParams } from "../../workflows/exec/param-secrets";
import { compileWorkflowPlan } from "../../workflows/ir/compile";
import { compileWorkflowSource } from "../../workflows/source-ir/compile";
import { isInferredSecretName } from "../log-redaction";
import { SCHEDULED_TASK_CONTEXT_KEYS } from "../scheduler-invocation";
import type { TaskV3Environment, TaskV3HostShell, TaskV3SourceDocument } from "../source-v3";
import type { PrepareTaskV3ExecutionContext, TaskV3PreparedBase } from "./prepared-execution";

function own(value: object | undefined, key: PropertyKey): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

export function environmentSnapshot(environment: TaskV3Environment | undefined): Readonly<Record<string, string>> {
  const out = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(environment ?? {}).sort()) {
    const raw = environment?.[key];
    if (raw === undefined) continue;
    const value = String(raw);
    if (isInferredSecretName(key) || detectSecretShapedParams({ [key]: value }).length > 0) {
      throw new UsageError(
        `Task env.${key} is a secret-shaped literal env value. Store credentials in a secret/env binding rather than durable task source.`,
        "TASK_SOURCE_INVALID",
      );
    }
    Object.defineProperty(out, key, { value, enumerable: true, configurable: false, writable: false });
  }
  return Object.freeze(out);
}

/** Merge source env with the authoritative, closed scheduler directory context. */
export function commandEnvironmentSnapshot(
  environment: Readonly<Record<string, string>>,
  schedulerContext: PrepareTaskV3ExecutionContext["schedulerContext"],
): Readonly<Record<string, string>> {
  const out = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(environment)) {
    Object.defineProperty(out, key, { value: environment[key], enumerable: true, configurable: true, writable: true });
  }
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) {
    const value = schedulerContext?.[key];
    if (!value) continue;
    Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return Object.freeze(out);
}

function normalizeTimeout(value: string | number | null | undefined): number | null | undefined {
  if (value === undefined || value === null || typeof value === "number") return value;
  const parsed = parseDuration(value, DURATION_UNITS);
  if (parsed === null) throw new UsageError(`Invalid task timeout ${JSON.stringify(value)}.`, "TASK_SOURCE_INVALID");
  return parsed;
}

export function qualifyOwnedRef(
  ref: string,
  context: PrepareTaskV3ExecutionContext,
): { parsed: BundleRef; qualified: string } {
  const parsed = parseBundleRef(ref);
  const bundle = parsed.bundle ?? context.bundleName;
  return { parsed, qualified: makeBundleRef(bundle, parsed.conceptId) };
}

export function currentExecutionValues(
  document: TaskV3SourceDocument,
  context: PrepareTaskV3ExecutionContext,
  environment: Readonly<Record<string, string>>,
): UnresolvedExecutionDefaults {
  const akm = document.akm;
  const agent = akm?.agent;
  return Object.freeze({
    ...(own(akm, "agent")
      ? {
          agent:
            typeof agent === "string" && isPortableExecutionAgentSelector(agent)
              ? qualifyOwnedRef(agent, context).qualified
              : agent,
        }
      : {}),
    ...(own(akm, "engine") ? { engine: akm?.engine } : {}),
    ...(own(akm, "model") ? { model: akm?.model } : {}),
    ...(own(akm, "inference") ? { inference: akm?.inference } : {}),
    ...(own(akm, "outputSchema") ? { outputSchema: akm?.outputSchema } : {}),
    ...(own(akm, "tools") ? { tools: akm?.tools } : {}),
    ...(own(akm, "timeout") ? { timeout: akm?.timeout } : {}),
    workspace: context.bundleRoot,
    environment,
  }) as UnresolvedExecutionDefaults;
}

export function base(
  document: TaskV3SourceDocument,
  context: PrepareTaskV3ExecutionContext,
  environment: Readonly<Record<string, string>>,
): TaskV3PreparedBase {
  const timeoutMs = normalizeTimeout(document.akm?.timeout);
  return Object.freeze({
    taskId: context.taskId,
    taskRef: context.taskRef,
    environment,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    redact: Object.freeze([...(document.akm?.redact ?? [])]),
  });
}

export async function resolvedOwnedAsset(
  qualified: string,
  type: "workflow" | "script",
  context: PrepareTaskV3ExecutionContext,
): Promise<Readonly<{ file: string; bundleRoot: string }>> {
  const parsed = parseBundleRef(qualified);
  const prefix = `${type}s/`;
  const name = parsed.conceptId.slice(prefix.length);
  if (context.resolveAsset) {
    const resolved = await context.resolveAsset({ bundle: parsed.bundle as string, type, name, ref: qualified });
    return typeof resolved === "string"
      ? Object.freeze({ file: resolved, bundleRoot: context.bundleRoot })
      : Object.freeze({ file: resolved.file, bundleRoot: resolved.bundleRoot });
  }
  if (parsed.bundle !== context.bundleName) {
    throw new NotFoundError(
      `Task target ${JSON.stringify(qualified)} names bundle ${JSON.stringify(parsed.bundle)}, but no bundle resolver was provided.`,
      "ASSET_NOT_FOUND",
    );
  }
  return Object.freeze({
    file: await resolveAssetPath(context.bundleRoot, type, name),
    bundleRoot: context.bundleRoot,
  });
}

export function defaultTaskShell(platform: NodeJS.Platform): TaskV3HostShell {
  return platform === "win32" ? "powershell" : "sh";
}

export function validatePreparedCommand(
  invocation: PreparedCommandInvocation,
  context: PrepareTaskV3ExecutionContext,
): PreparedCommandInvocation {
  const { request } = invocation;
  if (!request.engine.name) {
    throw new ConfigError(
      `Task ${JSON.stringify(context.taskRef)} has no resolved execution engine. Configure defaults.engine or akm.engine before running it.`,
      "INVALID_CONFIG_FILE",
    );
  }
  // Lowering is pure. Running it before the durable-attempt boundary proves
  // the selected target is transport-projectable; dispatch repeats the same
  // deterministic projection from this frozen request/config snapshot.
  buildExecution(request, invocation.runner);
  return invocation;
}

export function validateWorkflowRuntimeSource(
  file: string,
  workspaceRoot: string,
  readFile: (file: string, bundleRoot?: string) => Uint8Array,
): void {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFile(file, workspaceRoot));
  const compiled = compileWorkflowSource(source, { path: file, workspaceRoot });
  if (!compiled.ok) {
    // P4-N2's mapping (docs/plans/specs/p4-deletions-closeout.md §3.3.4): a
    // task-wrapped workflow target's own multi-job source is a composition
    // failure, same as freezing it directly would be; any other compile
    // failure is WORKFLOW_SOURCE_INVALID.
    const detail = compiled.errors.map((error) => `${error.path}:${error.line}: ${error.message}`).join("; ");
    const isMultiJob = compiled.errors.length === 1 && compiled.errors[0]?.code === "multi-job-unsupported";
    const code = isMultiJob ? "COMPOSITION_INVALID" : "WORKFLOW_SOURCE_INVALID";
    throw new UsageError(
      `Task workflow target is not projectable: ${detail}`,
      code,
      isMultiJob ? COMPOSITION_INVALID_MULTI_JOB_HINT : undefined,
    );
  }
  const planned = compileWorkflowPlan(compiled.ir, path.basename(file, path.extname(file)));
  if (!planned.ok) {
    // Same mapping applied for consistency; `compiled.ir` is already
    // guaranteed exactly one job here, so this arm always resolves to
    // WORKFLOW_SOURCE_INVALID in practice.
    const detail = planned.errors.map((error) => `${file}:${error.line}: ${error.message}`).join("; ");
    const isMultiJob = planned.errors.length === 1 && planned.errors[0]?.code === "multi-job-unsupported";
    const code = isMultiJob ? "COMPOSITION_INVALID" : "WORKFLOW_SOURCE_INVALID";
    throw new UsageError(
      `Task workflow target is not projectable: ${detail}`,
      code,
      isMultiJob ? COMPOSITION_INVALID_MULTI_JOB_HINT : undefined,
    );
  }
}
