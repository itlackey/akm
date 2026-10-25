// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a harness is: an agent program the user already has, which akm runs
 * non-interactively. Each harness is one folder under `harnesses/<id>/` and one
 * line in `HARNESS_REGISTRY` (`./index.ts`); the config schema, built-in
 * profiles, request lowering, setup and the docs table derive from it.
 *
 * A harness is a thin shell. It names the program (`profile`), says what akm may
 * ask of it (`confinable`, `nativeAgent`, `systemPrompt`, `models`) and turns one
 * request into argv, env and stdin (`build`). Everything else (spawning,
 * timeouts, credentials, redaction) is the same for every harness and lives in
 * `agent/`.
 *
 * Registry-reachable modules must not import `core/config` at runtime (the
 * config schema derives its platform enum from the registry).
 */

import type { ExecutionJsonObject } from "../../execution/json";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { AgentProfile } from "../agent/profiles";
import type { AgentRunResult, RunAgentOptions } from "../agent/spawn";
import type { SessionLogHarness } from "../session-logs/types";

/** What a request is lowered for: a harness, or akm's own runtime. */
export interface LowerTarget {
  /** Names the target in lowering notices. */
  readonly id: string;
  /** The program takes a system prompt, so a persona is delivered there; otherwise it is composed into the prompt. */
  readonly systemPrompt: boolean;
  /** Can run a named agent of its own (`opencode run --agent`, `claude --agent`). */
  readonly nativeAgent: boolean;
  /** akm can run model work read-only on it. Otherwise model work runs unrestricted, with a notice. */
  readonly confinable: boolean;
  /** Inference keys it carries; any other key is reported untranslated. Absent: none. */
  readonly inference?: readonly string[];
}

/** The part of a profile a builder reads: the program, and the args the config gave it. */
export interface HarnessSpawn {
  readonly bin: string;
  readonly args: readonly string[];
}

/** One request, as a builder sees it. */
export interface AgentDispatchRequest {
  /** User task / prompt to execute. */
  prompt: string;
  /** Exact harness-native agent name selected by a bare agent selector. Never alias-resolved. */
  agent?: string;
  /** System prompt body, for a harness that takes one. */
  systemPrompt?: string;
  /** Exact model ID resolved before harness lowering. */
  model?: string;
  /** Run under the model-work tool policy: the builder confines the run itself. */
  modelWork?: boolean;
  /** Exact resolved inference object. */
  inference?: ExecutionJsonObject | null;
  /** JSON Schema the output must validate against; the prompt already carries it as an instruction. */
  schema?: Record<string, unknown>;
}

/** A harness's view of one resolved request, before argv/SDK dispatch. */
export interface LoweredAgentDispatch {
  readonly prompt: string;
  readonly dispatch: Readonly<AgentDispatchRequest>;
  readonly notices: readonly Readonly<LoweringNotice>[];
}

/** Concrete command ready to hand to the spawn wrapper. */
export interface BuiltCommand {
  /** Full argv: [bin, ...flags, prompt]. */
  readonly argv: readonly string[];
  /** Extra env vars for the child (a harness that takes its model from the environment, say). */
  readonly env?: Readonly<Record<string, string>>;
  /** Payload to write to stdin (honoured only in captured stdio mode). */
  readonly stdin?: string;
}

/** The program a harness runs, and the env names it needs beyond the common set. */
export interface HarnessProfileDefaults {
  /** Command looked up on PATH. */
  readonly bin: string;
  /** Base args prepended to the dispatch args. */
  readonly args: readonly string[];
  /** Env var names passed through to the child on top of the common set. */
  readonly envPassthrough: readonly string[];
}

export interface AkmHarness extends LowerTarget {
  /** The only config, dispatch, runtime-attribution and session-log id. */
  readonly id: string;
  readonly displayName: string;
  /**
   * Home-relative config directory `akm setup` scans to offer this harness as a
   * stash source (e.g. `.claude`). Only a harness with a session-log provider
   * has one: selecting one without would be a silent no-op.
   */
  readonly setupDetectionDir?: string;
  readonly profile: HarnessProfileDefaults;
  /**
   * The aliases (`fast`, `balanced`, `reasoning`) this harness's models answer
   * to, which a `harnesses.<name>.models` entry overrides. Absent: no model is
   * passed for an alias and the harness picks its own.
   */
  readonly models?: Readonly<Record<string, string>>;
  /**
   * Env vars that carry this harness's session id when a process runs under it
   * (workflow agent-identity detection reads them). Only session-id-bearing
   * names belong here: the value is persisted as `workflow_runs.agent_session_id`.
   */
  readonly identityEnv?: readonly string[];
  /**
   * Env vars whose presence alone says a process runs under this harness
   * (`CODEX_SANDBOX`, `GEMINI_CLI`). Used only to infer the harness; the value is
   * never a session id, and a harness's own user-profile config vars do not
   * belong here (they would stamp identity onto manual runs).
   */
  readonly presenceEnv?: readonly string[];
  readonly sessionLogProvider?: () => SessionLogHarness;
  /**
   * Runs a captured request inside akm's process when the installed harness
   * supports that (OpenCode 2, embedded); `undefined` means spawn its CLI.
   */
  readonly runInProcess?: (
    profile: AgentProfile,
    prompt: string,
    opts: RunAgentOptions,
  ) => Promise<AgentRunResult> | undefined;
  readonly resultExtractor?: AgentResultExtractor;
  /** Turn one request into the command to spawn. */
  build(spawn: HarnessSpawn, request: AgentDispatchRequest): BuiltCommand;
}

/**
 * Normalized payload extracted from one raw harness run: the final answer with
 * transport framing stripped, and the harness's session id when the output
 * reveals one.
 */
export interface AgentResultExtraction {
  text: string;
  sessionId?: string;
}

/** Per-harness result extractor: a raw `AgentRunResult` to `{ text, sessionId? }`. */
export type AgentResultExtractor = (result: AgentRunResult) => AgentResultExtraction;

/** The `build` of a harness, kept apart from the rest of its descriptor. */
export type HarnessBuilder = Pick<AkmHarness, "build">;

/**
 * The model an engine's own `args` select, as `--model X` or `--model=X` (the
 * last one wins), for a builder that writes its own argv in place of those args.
 */
export function modelFromArgs(args: readonly string[]): string | undefined {
  let model: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") model = args[index + 1];
    else if (arg?.startsWith("--model=")) model = arg.slice("--model=".length);
  }
  return model;
}
