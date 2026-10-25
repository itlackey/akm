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

import type { LoweringNotice } from "../../execution/resolved-request";
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
  /** User task / prompt to execute. Absent: launch the program interactively, with nothing to run. */
  prompt?: string;
  /** Exact harness-native agent name selected by a bare agent selector. Never alias-resolved. */
  agent?: string;
  /** System prompt body, for a harness that takes one. */
  systemPrompt?: string;
  /** Exact model ID resolved before harness lowering. */
  model?: string;
  /** Run under the model-work tool policy: the builder confines the run itself. */
  modelWork?: boolean;
}

/** A harness's view of one resolved request, before argv/SDK dispatch. */
export interface LoweredAgentDispatch {
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
   * Whether the program installed on this machine can run model work read-only, for a harness whose `confinable`
   * depends on the install (OpenCode: only version 2). Setup asks it; absent, `confinable` is the answer.
   */
  readonly confinableInstalled?: () => boolean;
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
  /** Turn one request into the command to spawn. */
  build(spawn: HarnessSpawn, request: AgentDispatchRequest): BuiltCommand;
}

/** The `build` of a harness, kept apart from the rest of its descriptor. */
export type HarnessBuilder = Pick<AkmHarness, "build">;

/**
 * The model the config's own `args` select, as `--model X` or `--model=X` (the
 * last one wins).
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

/** `args` without any `--model X` or `--model=X`, for a builder that adds the request's model itself, so it is passed once. */
export function withoutModelFlag(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--model") index += 1;
    else if (!arg.startsWith("--model=")) kept.push(arg);
  }
  return kept;
}

/** `args` less a leading `subcommand` the builder writes itself, so an authored one is not doubled. */
export function withoutLeading(args: readonly string[], subcommand: string): string[] {
  return args[0] === subcommand ? args.slice(1) : [...args];
}
