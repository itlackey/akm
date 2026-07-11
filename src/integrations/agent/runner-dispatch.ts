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
import type { LlmConnectionConfig } from "../../core/config/config";
import { closeServer as disposeOpencodeSdkServers, runOpencodeSdk } from "../harnesses/opencode-sdk";
import type { AgentProfile } from "./profiles";
import type { RunnerSpec } from "./runner";
import { type AgentRunResult, type RunAgentOptions, runAgent } from "./spawn";

/**
 * Release every long-lived resource the dispatch runners CACHE for reuse, so a
 * one-shot process (the CLI) can exit cleanly once dispatching is done.
 *
 * The `sdk` runner keeps a per-env registry of `opencode serve` CHILD
 * PROCESSES (see `opencode-sdk/sdk-runner.ts`), started lazily and reused
 * across units within a process. Each live child is an OS handle that keeps
 * Bun's event loop open — and the registry's own teardown is wired ONLY to
 * `process.once('exit')`, which never fires while such a child holds the loop
 * open. That is a deadlock: a successful `akm workflow run` that dispatched via
 * the SDK path would hang the CLI (owner finding 4) because the process is
 * never idle enough for the exit hook to run and close the children it is
 * waiting on.
 *
 * The engine therefore calls this in its run `finally` (every exit path —
 * success, gate rejection, failure, abort) to drain the registry deterministically
 * BEFORE relying on the event loop to drain. The close is synchronous and
 * idempotent; when no SDK server was ever started it is a no-op, so the `agent`
 * / `llm` dispatch paths pay nothing. Servers are re-created lazily on the next
 * dispatch, so calling this between independent dispatch invocations is safe.
 */
export function disposeDispatchResources(): void {
  disposeOpencodeSdkServers();
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
  switch (spec.kind) {
    case "llm": {
      if (!seams.llm) {
        throw new Error("executeRunner: an `llm` runner requires a `seams.llm` handler (no default LLM dispatch).");
      }
      return seams.llm(spec, prompt, withSpecOptions(spec.timeoutMs));
    }
    case "agent": {
      const run = seams.runAgent ?? runAgent;
      return run(spec.profile, prompt, withSpecOptions(spec.timeoutMs, spec.profile.workspace));
    }
    case "sdk": {
      const run = seams.runSdk ?? runOpencodeSdk;
      return run(
        spec.profile,
        prompt,
        withSpecOptions(spec.timeoutMs, spec.profile.workspace),
        spec.fallbackConnection,
      );
    }
    default:
      // Exhaustiveness arm: a 4th RunnerSpec kind becomes a compile error here.
      return assertNever(spec);
  }
}
