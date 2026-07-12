// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * X3 — the ONE dispatch seam for the {@link RunnerSpec} tagged union.
 *
 * The improve slice dispatches a `RunnerSpec` (`llm | agent | sdk`) in several
 * places (`reflect.ts`, `proposal/drain.ts`, …). Before this module each site
 * re-rolled the identical 3-arm switch and re-declared its own per-kind test
 * seams (`chat`, `runAgentFn`, `runSdkFn`). `executeRunner` collapses that into
 * one switch + one {@link RunnerSeams} object.
 *
 * Scoping (behavior-preserving):
 *   - The `agent` and `sdk` arms are byte-identical across call sites: invoke
 *     the profile runner (`runAgent` / `runOpencodeSdk`) with the per-call
 *     `RunAgentOptions` the caller passes. Those default runners live here so
 *     callers stop importing `runAgent` / `runOpencodeSdk` for dispatch. The
 *     `opts` (incl. any `timeoutMs`) is constructed by the caller and passed
 *     through unchanged, so each site keeps its exact option set.
 *   - The `llm` arm is irreducibly caller-specific (reflect wraps
 *     `runReflectViaLlm`, which returns reflect's iteration shape; drain wraps a
 *     plain `chatCompletion`). It is therefore a REQUIRED seam — there is no
 *     default `llm` handler — so neither caller's bespoke behavior is changed.
 *   - The `assertNever` exhaustiveness arm is kept so a 4th `RunnerSpec` kind is
 *     a compile error here instead of a silent runtime fall-through.
 *
 * The return type is {@link AgentRunResult} so a later `callStructured` layer
 * (X2) can wrap `executeRunner` without changing this contract.
 */

import { assertNever } from "../../core/assert";
import { type LlmConnectionConfig, resolveSecret } from "../../core/config/config";
import { ENV_PASSTHROUGH_REDACTION_ALLOWLIST, redactSensitiveText, redactSensitiveValue } from "../../core/redaction";
import { closeServer as disposeOpencodeSdkServers, runOpencodeSdk } from "../harnesses/opencode-sdk";
import type { AgentProfile } from "./profiles";
import type { RunnerSpec } from "./runner";
import { type AgentRunResult, type RunAgentOptions, runAgent } from "./spawn";

/**
 * Release every long-lived resource the dispatch runners CACHE for reuse, so a
 * one-shot process (the CLI) can exit cleanly once dispatching is done.
 *
 * The `sdk` runner keeps a per-material registry of `opencode serve` CHILD
 * PROCESSES (see `opencode-sdk/sdk-runner.ts`), started lazily and reused
 * across units within a process. Each live child is an OS handle that keeps
 * Bun's event loop open — and the registry's own teardown is wired ONLY to
 * `process.once('exit')`, which never fires while such a child holds the loop
 * open. That is a deadlock: a successful `akm workflow run` that dispatched via
 * the SDK path would hang the CLI (owner finding 4) because the process is
 * never idle enough for the exit hook to run and close the children it is
 * waiting on.
 *
 * The CLI composition root and workflow engine call this in `finally` blocks to
 * drain the registry deterministically before relying on the event loop. Started
 * servers close synchronously; in-flight starts are awaited and closed on
 * arrival. When no SDK server was started this is an idempotent no-op.
 */
export async function disposeDispatchResources(): Promise<void> {
  await disposeOpencodeSdkServers();
}

/** Collect every materialized value that can reach one runner dispatch. */
export function collectDispatchSensitiveValues(
  spec: RunnerSpec,
  opts: RunAgentOptions,
  envSource: NodeJS.ProcessEnv = opts.envSource ?? process.env,
): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0) values.add(value);
  };
  const addConnection = (connection: LlmConnectionConfig | undefined): void => add(connection?.apiKey);

  if (spec.kind === "llm") addConnection(spec.connection);
  if (spec.kind === "sdk") addConnection(spec.fallbackConnection);
  if (spec.kind !== "llm") {
    add(resolveSecret(spec.profile.apiKey));
    for (const value of Object.values(spec.profile.env ?? {})) add(value);
    for (const name of spec.profile.envPassthrough) {
      if (!ENV_PASSTHROUGH_REDACTION_ALLOWLIST.has(name)) add(envSource[name]);
    }
  }
  for (const value of Object.values(opts.env ?? {})) add(value);
  return [...values];
}

function redactResult(result: AgentRunResult, sensitiveValues: readonly string[]): AgentRunResult {
  return {
    ...result,
    stdout: redactSensitiveText(result.stdout, sensitiveValues),
    stderr: redactSensitiveText(result.stderr, sensitiveValues),
    ...(result.error !== undefined ? { error: redactSensitiveText(result.error, sensitiveValues) } : {}),
    ...(result.parsed !== undefined ? { parsed: redactSensitiveValue(result.parsed, sensitiveValues) } : {}),
  };
}

/**
 * Per-kind dispatch overrides. The `llm` handler is required at every real call
 * site (no in-tree default); `runAgent` / `runSdk` default to the real profile
 * runners and exist primarily as test seams.
 */
export interface RunnerSeams {
  /**
   * Handler for the `llm` runner kind. Required — the LLM path differs per
   * caller (reflect's `runReflectViaLlm` vs drain's `chatCompletion`), so it is
   * supplied rather than defaulted. Receives the narrowed `llm` spec and prompt.
   */
  llm?: (spec: Extract<RunnerSpec, { kind: "llm" }>, prompt: string, opts: RunAgentOptions) => Promise<AgentRunResult>;
  /** Override for the `agent` runner kind. Defaults to {@link runAgent}. */
  runAgent?: (profile: AgentProfile, prompt: string, opts: RunAgentOptions) => Promise<AgentRunResult>;
  /** Override for the `sdk` runner kind. Defaults to {@link runOpencodeSdk}. */
  runSdk?: (
    profile: AgentProfile,
    prompt: string,
    opts: RunAgentOptions,
    fallbackConnection?: LlmConnectionConfig,
  ) => Promise<AgentRunResult>;
}

/**
 * Dispatch a {@link RunnerSpec} to its runner and return the raw
 * {@link AgentRunResult}. `opts` is the {@link RunAgentOptions} for the profile
 * (`agent` / `sdk`) arms; it is passed through unchanged so each caller keeps
 * its exact option set (incl. any `timeoutMs` the caller chose to apply).
 */
export async function executeRunner(
  spec: RunnerSpec,
  prompt: string,
  opts: RunAgentOptions,
  seams: RunnerSeams = {},
): Promise<AgentRunResult> {
  const withSpecOptions = (timeoutMs: number | null | undefined, workspace?: string): RunAgentOptions => ({
    ...opts,
    ...(Object.hasOwn(opts, "timeoutMs") ? {} : timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(opts.cwd === undefined && workspace ? { cwd: workspace } : {}),
  });
  let result: AgentRunResult;
  switch (spec.kind) {
    case "llm": {
      if (!seams.llm) {
        throw new Error("executeRunner: an `llm` runner requires a `seams.llm` handler (no default LLM dispatch).");
      }
      result = await seams.llm(spec, prompt, withSpecOptions(spec.timeoutMs));
      break;
    }
    case "agent": {
      const run = seams.runAgent ?? runAgent;
      result = await run(spec.profile, prompt, withSpecOptions(spec.timeoutMs, spec.profile.workspace));
      break;
    }
    case "sdk": {
      const run = seams.runSdk ?? runOpencodeSdk;
      result = await run(
        spec.profile,
        prompt,
        withSpecOptions(spec.timeoutMs, spec.profile.workspace),
        spec.fallbackConnection,
      );
      break;
    }
    default:
      // Exhaustiveness arm: a 4th RunnerSpec kind becomes a compile error here.
      return assertNever(spec);
  }
  return redactResult(result, collectDispatchSensitiveValues(spec, opts));
}
