// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Built-in profile registry for external agent CLIs (v1 spec §12.1).
 *
 * A `AgentProfile` is the minimum metadata required to shell-out to a
 * coding-agent CLI. A harness lowers canonical harness metadata into this
 * intentionally small internal shape. The wrapper is in `./spawn.ts`.
 */
import { COMMON_SPAWN_ENV_PASSTHROUGH } from "../../core/spawn-env";
import { HARNESS_REGISTRY } from "../harnesses";
import type { AkmHarness } from "../harnesses/harness";
import type { ConnectionRunner, HarnessRunner } from "./runner";

export type AgentStdioMode = "captured" | "interactive";

/**
 * Concrete profile used by the spawn wrapper. Built-ins are immutable;
 * resolved profiles (after merging user overrides) are also `Readonly`.
 */
export interface AgentProfile {
  /** Profile name (key in `agent.profiles`). */
  readonly name: string;
  /** Canonical harness platform. */
  readonly platform?: string;
  /** Command to spawn (looked up on PATH). */
  readonly bin: string;
  /** Base args prepended to caller args. */
  readonly args: readonly string[];
  /** Default stdio mode. Callers may override per-call. */
  readonly stdio: AgentStdioMode;
  /**
   * Names of environment variables that should be passed through to the
   * child even if the caller scrubs the env (e.g. for credential vars
   * the agent CLI needs). Always-passed for built-in profiles; user
   * overrides may extend the list.
   */
  readonly envPassthrough: readonly string[];
  /** Exact model selected for this dispatch. */
  readonly model?: string;
}

/**
 * Built-in profiles for the agent CLIs akm knows out of the box, DERIVED from
 * the harness registry: each harness that declares `profile` defaults gets one,
 * named by its id. The fields are conservative defaults, overridable from user
 * config. Request lowering selects captured stdio for unattended dispatch.
 *
 * Built lazily: the registry transitively imports this module, so it cannot be
 * read at module load.
 */
let builtins: Record<string, AgentProfile> | undefined;

function builtinProfiles(): Record<string, AgentProfile> {
  if (builtins) return builtins;
  builtins = {};
  for (const harness of HARNESS_REGISTRY as readonly AkmHarness[]) {
    builtins[harness.id] = {
      name: harness.id,
      bin: harness.profile.bin,
      args: harness.profile.args,
      stdio: "interactive",
      // AKM_EVENT_SOURCE (in the common set) carries usage-event provenance so akm
      // invocations a spawned agent makes are recorded as machine traffic; it is a
      // provenance tag, never a secret.
      envPassthrough: [...COMMON_SPAWN_ENV_PASSTHROUGH, ...harness.profile.envPassthrough],
    };
  }
  return builtins;
}

/**
 * The OpenCode CLI binary: the opencode harness runs it for OpenCode 1 and asks
 * it for its major, and plugin upgrades refresh OpenCode's plugin caches with it.
 * akm's own runtime and OpenCode 2 run embedded and need no binary.
 */
export const OPENCODE_BIN = "opencode";

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

/** The profile a harness runner spawns: its platform's built-in defaults under what the config set. */
export function harnessProfile(runner: HarnessRunner): AgentProfile {
  return {
    name: runner.name,
    platform: runner.platform,
    bin: runner.bin,
    args: runner.args,
    stdio: "captured",
    envPassthrough: getBuiltinAgentProfile(runner.platform)?.envPassthrough ?? [],
    ...(runner.model ? { model: runner.model } : {}),
  };
}

/** The profile of akm's own runtime, the embedded OpenCode that runs agent work over a connection. It spawns nothing. */
export function runtimeProfile(connection: ConnectionRunner): AgentProfile {
  return {
    name: connection.name,
    bin: "",
    args: [],
    stdio: "captured",
    envPassthrough: [],
    model: connection.model,
  };
}
