// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Built-in profile registry for external agent CLIs (v1 spec §12.1).
 *
 * A `AgentProfile` is the minimum metadata required to shell-out to a
 * coding-agent CLI. Named engines lower canonical harness metadata into this
 * intentionally small internal shape. The wrapper is in `./spawn.ts`.
 */
import { COMMON_SPAWN_ENV_PASSTHROUGH } from "../../core/spawn-env";
import type { ExecutionJsonObject } from "../../execution/json";
import { HARNESS_REGISTRY } from "../harnesses";
import type { AkmHarness } from "../harnesses/types";

export type AgentStdioMode = "captured" | "interactive";
export type AgentParseMode = "text" | "json";

/**
 * Concrete profile used by the spawn wrapper. Built-ins are immutable;
 * resolved profiles (after merging user overrides) are also `Readonly`.
 */
export interface AgentProfile {
  /** Profile name (key in `agent.profiles`). */
  readonly name: string;
  /** Canonical harness platform selected by an engine. */
  readonly platform?: string;
  /** Harness-owned lowering contract for persona delivery. */
  readonly personaChannel?: "native" | "prompt";
  /** Normalized workspace used when the caller does not provide a cwd. */
  readonly workspace?: string;
  /** Command to spawn (looked up on PATH). */
  readonly bin: string;
  /** Base args prepended to caller args. */
  readonly args: readonly string[];
  /** Default stdio mode. Callers may override per-call. */
  readonly stdio: AgentStdioMode;
  /** Extra env vars merged on top of process.env at spawn time. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Names of environment variables that should be passed through to the
   * child even if the caller scrubs the env (e.g. for credential vars
   * the agent CLI needs). Always-passed for built-in profiles; user
   * overrides may extend the list.
   */
  readonly envPassthrough: readonly string[];
  /** How the wrapper should attempt to parse stdout. */
  readonly parseOutput: AgentParseMode;
  /** The engine's default native agent, used when a request names none. */
  readonly agent?: string;
  /** Exact model selected for this dispatch. */
  readonly model?: string;
  /**
   * The inference a dispatch resolved (an improve process's `llm` overlay, say),
   * kept so a frozen runner resolves to it again. A harness reads the request's own.
   */
  readonly inference?: ExecutionJsonObject;
}

/**
 * Built-in profiles for the agent CLIs akm knows out of the box, DERIVED from
 * the harness registry: each harness that declares `profile` defaults gets one,
 * named by its id. The fields are conservative defaults, overridable from user
 * config. Engine lowering selects captured stdio for unattended dispatch.
 *
 * Built lazily: the registry transitively imports this module, so it cannot be
 * read at module load.
 */
let builtins: Record<string, AgentProfile> | undefined;

function builtinProfiles(): Record<string, AgentProfile> {
  if (builtins) return builtins;
  builtins = {};
  for (const harness of HARNESS_REGISTRY as readonly AkmHarness[]) {
    if (!harness.profile) continue;
    builtins[harness.id] = {
      name: harness.id,
      bin: harness.profile.bin,
      args: harness.profile.args,
      stdio: "interactive",
      // AKM_EVENT_SOURCE (in the common set) carries usage-event provenance so akm
      // invocations a spawned agent makes are recorded as machine traffic; it is a
      // provenance tag, never a secret.
      envPassthrough: [...COMMON_SPAWN_ENV_PASSTHROUGH, ...harness.profile.envPassthrough],
      parseOutput: "text",
    };
  }
  return builtins;
}

/**
 * Binary the `opencode-sdk` harness needs on PATH.
 *
 * The embedded client is not self-contained, and that is the SDK's own design
 * rather than a consequence of how akm drives it: `@opencode-ai/sdk` (OpenCode 1)
 * ships with `"dependencies": {}` and its `createOpencodeServer` is itself a
 * `spawn("opencode", ["serve", ...])`; `@opencode/client` (OpenCode 2, the
 * default) is an HTTP client only and starts nothing. akm's runner spawns a
 * private `opencode serve` of the engine's detected major (
 * never the v2 background service) and talks HTTP to it through that major's
 * adapter (see `harnesses/opencode-sdk/sdk-runner.ts`, `v1-adapter.ts`, `v2-adapter.ts`),
 * so the `opencode` binary gates the SDK path exactly as it gates the CLI
 * path — a host with the npm package but no binary can dispatch neither.
 * `opencode-sdk` deliberately declares no `profile` — it dispatches
 * without argv construction — so this is the one place that pairing lives.
 */
export const OPENCODE_SDK_SERVER_BIN = "opencode";

/** Returns the built-in descriptor for a canonical harness id. */
export function getBuiltinAgentProfile(name: string): AgentProfile | undefined {
  return builtinProfiles()[name];
}

/**
 * Return a copy of every canonical built-in descriptor keyed by harness id.
 * Callers should not assume reference equality with subsequent calls.
 */
export function listBuiltinAgentProfiles(): Record<string, AgentProfile> {
  const out: Record<string, AgentProfile> = {};
  for (const [name, profile] of Object.entries(builtinProfiles())) {
    out[name] = { ...profile };
  }
  return out;
}
