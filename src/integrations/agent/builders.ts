/**
 * Agent command builder strategy (v1 spec §12.2).
 *
 * Each supported agent CLI platform has its own `AgentCommandBuilder` that
 * translates a platform-agnostic `AgentDispatchRequest` into the exact argv
 * the CLI expects. This keeps all per-platform arg differences out of the
 * spawn wrapper and profiles.
 *
 * Adding a new platform: implement `AgentCommandBuilder`, add to
 * `BUILTIN_BUILDERS`. Nothing else changes.
 */

import { UsageError } from "../../core/errors";
import type { ShowResponse } from "../../sources/types";
import { resolveModel } from "./model-aliases";
import type { AgentProfile } from "./profiles";

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Platform-agnostic description of what the caller wants to dispatch.
 * Fields come from the resolved agent asset and/or CLI flags.
 * Builders translate this into platform-specific argv.
 */
export interface AgentDispatchRequest {
  /** User task / prompt to execute. */
  prompt: string;
  /** System prompt body — from agent asset content field. */
  systemPrompt?: string;
  /**
   * Raw model alias ("opus", "sonnet") or exact platform model ID.
   * May come from agent asset frontmatter `model:` OR the --model CLI flag
   * (flag wins). Builders resolve the alias to a platform-specific string via
   * resolveModel() — never resolved before reaching the builder.
   */
  model?: string;
  /** Tool policy — from agent asset frontmatter `tools:`. */
  tools?: ShowResponse["toolPolicy"];
  /** Working directory for the subprocess. */
  cwd?: string;
}

/** Concrete command ready to hand to the spawn wrapper. */
export interface BuiltCommand {
  /** Full argv: [bin, ...flags, prompt]. */
  readonly argv: readonly string[];
  /** Extra env vars to merge alongside profile env (platform-specific credentials, etc.). */
  readonly env?: Readonly<Record<string, string>>;
  /** Payload to write to stdin (honoured only in captured stdio mode). */
  readonly stdin?: string;
}

/** Strategy for building the argv for one agent CLI platform. */
export interface AgentCommandBuilder {
  /** Platform identifier — matches profile.name or profile.commandBuilder. */
  readonly platform: string;
  /**
   * Build the concrete command for this platform.
   * Receives the fully-resolved profile (with user overrides merged in) and
   * the abstract dispatch request. Returns argv + optional env/stdin overrides.
   */
  build(profile: AgentProfile, request: AgentDispatchRequest): BuiltCommand;
}

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Guard against values that start with `--`, which would be mis-interpreted as
 * CLI flags by the spawned process when used as flag values (model, systemPrompt).
 * Bun.spawn uses array argv so there is no shell injection, but a `--`-prefixed
 * value passed as the argument to `--model` or `--system-prompt` can still
 * confuse the CLI parser of the target process.
 */
function assertNotFlag(value: string | undefined, field: string): void {
  if (value?.trimStart().startsWith("--")) {
    throw new UsageError(
      `${field} must not start with "--": ${JSON.stringify(value.slice(0, 60))}`,
      "INVALID_FLAG_VALUE",
    );
  }
}

// ── Tool normalization ────────────────────────────────────────────────────────

/**
 * Normalize a toolPolicy value to a comma-separated string suitable for a
 * CLI flag. Structured policy objects are JSON-serialized.
 */
function normalizeTools(tools: ShowResponse["toolPolicy"]): string {
  if (typeof tools === "string") return tools;
  if (Array.isArray(tools)) return tools.join(",");
  return JSON.stringify(tools);
}

// ── Platform builders ─────────────────────────────────────────────────────────

/**
 * OpenCode builder.
 * Command shape: opencode run [--system-prompt "..."] [--model <m>] "<prompt>"
 *
 * Tool policy is omitted — opencode manages tool access through its own agent
 * config files, not via CLI flags.
 */
const opencodeBuilder: AgentCommandBuilder = {
  platform: "opencode",
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    const args: string[] = [...profile.args]; // starts with ["run"]
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.model) {
      const resolved = resolveModel(req.model, "opencode", profile.modelAliases);
      args.push("--model", resolved);
    }
    args.push("--");
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};

/**
 * Claude Code builder.
 * Command shape: claude [--system-prompt "..."] [--model <m>] [--allowedTools <t>] --print "<prompt>"
 *
 * --print switches Claude Code to non-interactive captured output mode.
 */
const claudeBuilder: AgentCommandBuilder = {
  platform: "claude",
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    const args: string[] = [...profile.args];
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.model) {
      const resolved = resolveModel(req.model, "claude", profile.modelAliases);
      args.push("--model", resolved);
    }
    if (req.tools) {
      args.push("--allowedTools", normalizeTools(req.tools));
    }
    // --print = non-interactive, outputs to stdout — required for captured mode
    args.push("--print");
    args.push("--");
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};

/**
 * Default builder — used for custom profiles and any platform without a
 * dedicated builder. Passes systemPrompt and model via the same flags as
 * the builtin builders so custom profiles benefit from agent asset metadata.
 * Tools are omitted — no standard cross-platform flag exists.
 */
const defaultBuilder: AgentCommandBuilder = {
  platform: "default",
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    const args: string[] = [...profile.args];
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.model) {
      const resolved = resolveModel(req.model, profile.name, profile.modelAliases);
      args.push("--model", resolved);
    }
    args.push("--");
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────

const BUILTIN_BUILDERS: Readonly<Record<string, AgentCommandBuilder>> = {
  opencode: opencodeBuilder,
  "opencode-headless": opencodeBuilder,
  claude: claudeBuilder,
  "claude-headless": claudeBuilder,
};

/**
 * Return the builder for the given platform name, falling back to the default
 * builder for unknown platforms. Custom builders injected via tests can be
 * passed as `registry`.
 */
export function getCommandBuilder(
  platform: string,
  registry: Record<string, AgentCommandBuilder> = BUILTIN_BUILDERS,
): AgentCommandBuilder {
  return registry[platform] ?? defaultBuilder;
}
