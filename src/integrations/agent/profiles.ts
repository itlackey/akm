/**
 * Built-in profile registry for external agent CLIs (v1 spec §12.1).
 *
 * A `AgentProfile` is the minimum metadata required to shell-out to a
 * coding-agent CLI. The profile is intentionally tiny — there is no
 * vendor SDK in scope. Users can override or extend any field via
 * `agent.profiles[<name>]` in `config.json`.
 *
 * The wrapper that uses these profiles is in `./spawn.ts`. The config
 * parser that merges user overrides on top of the built-ins is in
 * `./config.ts`.
 */
export type AgentStdioMode = "captured" | "interactive";
export type AgentParseMode = "text" | "json";

/**
 * Concrete profile used by the spawn wrapper. Built-ins are immutable;
 * resolved profiles (after merging user overrides) are also `Readonly`.
 */
export interface AgentProfile {
  /** Profile name (key in `agent.profiles`). */
  readonly name: string;
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
  /** Per-profile timeout override (ms). Falls back to `agent.timeoutMs`. */
  readonly timeoutMs?: number;
  /** How the wrapper should attempt to parse stdout. */
  readonly parseOutput: AgentParseMode;
}

const COMMON_PASSTHROUGH = ["HOME", "PATH", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR"] as const;

/**
 * Built-in profiles for the five agent CLIs the v1 spec calls out
 * explicitly. The fields here are conservative defaults — every value is
 * overridable from user config.
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
};

/** Names of every built-in profile. Stable, sorted. */
export const BUILTIN_AGENT_PROFILE_NAMES: readonly string[] = Object.freeze(Object.keys(BUILTINS).sort());

/** Returns the built-in profile by name, or `undefined` if not built-in. */
export function getBuiltinAgentProfile(name: string): AgentProfile | undefined {
  return BUILTINS[name];
}

/**
 * Return a deep copy of every built-in profile keyed by name. Callers
 * should not assume reference equality with subsequent calls.
 */
export function listBuiltinAgentProfiles(): Record<string, AgentProfile> {
  const out: Record<string, AgentProfile> = {};
  for (const [name, profile] of Object.entries(BUILTINS)) {
    out[name] = { ...profile };
  }
  return out;
}
