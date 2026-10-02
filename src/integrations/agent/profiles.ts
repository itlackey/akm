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
  /** Exact model selected for this dispatch. */
  readonly model?: string;
  /**
   * Inference the engine or the dispatch selected, kept so a journaled runner
   * resolves to the same defaults again. A harness reads the request's own.
   */
  readonly inference?: ExecutionJsonObject;
}

// AKM_EVENT_SOURCE carries usage-event provenance (improve/task) so that akm
// invocations a spawned agent makes are recorded as machine traffic, not user
// demand (DRIFT-6). Without it in the passthrough whitelist, buildChildEnv drops
// the stamp at the agent boundary — e.g. `akm wiki ingest` spawns an agent whose
// `akm curate/show/search` tool-calls then log source='user', silently inflating
// every lane's read-back (GRR). It is a provenance tag, never a secret.
const COMMON_PASSTHROUGH = COMMON_SPAWN_ENV_PASSTHROUGH;

/**
 * Built-in profiles for the agent CLIs akm knows out of the box: the five the
 * v1 spec calls out explicitly, plus the P2 harness adapters (copilot, pi,
 * amazonq, openhands — plan §"Capability matrix"). The fields here are
 * conservative defaults — every value is overridable from user config.
 *
 * Engine lowering selects captured stdio for unattended dispatch.
 */
const BUILTINS: Record<string, AgentProfile> = {
  opencode: {
    name: "opencode",
    bin: "opencode",
    args: ["run"],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH, "OPENCODE_API_KEY", "OPENCODE_CONFIG"],
    parseOutput: "text",
  },
  claude: {
    name: "claude",
    bin: "claude",
    args: [],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH, "ANTHROPIC_API_KEY", "CLAUDE_CONFIG"],
    parseOutput: "text",
  },
  codex: {
    name: "codex",
    bin: "codex",
    args: [],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH, "OPENAI_API_KEY", "CODEX_CONFIG"],
    parseOutput: "text",
  },
  gemini: {
    name: "gemini",
    bin: "gemini",
    args: [],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH, "GEMINI_API_KEY", "GOOGLE_API_KEY"],
    parseOutput: "text",
  },
  aider: {
    name: "aider",
    bin: "aider",
    args: ["--no-auto-commits"],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH, "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    parseOutput: "text",
  },
  // ── P2 harness-adapter profiles (plan §"Capability matrix") ────────────────
  copilot: {
    name: "copilot",
    bin: "copilot",
    args: [],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH, "GH_TOKEN", "GITHUB_TOKEN"],
    parseOutput: "text",
  },
  pi: {
    name: "pi",
    bin: "pi",
    args: [],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH, "PI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    parseOutput: "text",
  },
  amazonq: {
    name: "amazonq",
    bin: "q",
    args: [],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH, "AWS_PROFILE", "AWS_REGION"],
    parseOutput: "text",
  },
  openhands: {
    name: "openhands",
    bin: "openhands",
    args: [],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH, "LLM_MODEL", "LLM_API_KEY", "LLM_BASE_URL"],
    parseOutput: "text",
  },
};

/**
 * Binary the `opencode-sdk` harness needs on PATH.
 *
 * The embedded SDK is not self-contained, and that is the SDK's own design
 * rather than a consequence of how akm drives it: `@opencode-ai/sdk` ships
 * with `"dependencies": {}` and its `createOpencodeServer` is itself a
 * `spawn("opencode", ["serve", ...])`. akm's runner spawns the same binary
 * directly and talks HTTP to it (see `harnesses/opencode-sdk/sdk-runner.ts`),
 * so the `opencode` binary gates the SDK path exactly as it gates the CLI
 * path — a host with the npm package but no binary can dispatch neither.
 * `opencode-sdk` deliberately has no {@link BUILTINS} entry — it dispatches
 * without argv construction — so this is the one place that pairing lives.
 */
export const OPENCODE_SDK_SERVER_BIN = "opencode";

/** Names of the canonical built-in harness descriptors. Stable, sorted. */
export const BUILTIN_AGENT_PROFILE_NAMES: readonly string[] = Object.freeze(Object.keys(BUILTINS).sort());

/** Returns the built-in descriptor for a canonical harness id. */
export function getBuiltinAgentProfile(name: string): AgentProfile | undefined {
  return BUILTINS[name];
}

/**
 * Return a copy of every canonical built-in descriptor keyed by harness id.
 * Callers should not assume reference equality with subsequent calls.
 */
export function listBuiltinAgentProfiles(): Record<string, AgentProfile> {
  const out: Record<string, AgentProfile> = {};
  for (const [name, profile] of Object.entries(BUILTINS)) {
    out[name] = { ...profile };
  }
  return out;
}
