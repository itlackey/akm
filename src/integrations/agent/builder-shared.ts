// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared agent-command-builder types and helpers (#563).
 *
 * Extracted from `agent/builders.ts` so per-harness builders (e.g.
 * `harnesses/claude/agent-builder.ts`) can depend on the common
 * types/validation WITHOUT creating an import cycle back through
 * `builders.ts` (which imports the per-harness builders into its registry).
 * This module is a dependency-graph LEAF for the builder subsystem.
 *
 * Behaviour-preserving: the type shapes and helper bodies are unchanged from
 * their previous home in `builders.ts`.
 */

import { UsageError } from "../../core/errors";
import type { ShowResponse } from "../../sources/types";
import type { AgentProfile } from "./profiles";

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

/**
 * Guard against values that start with `--`, which would be mis-interpreted as
 * CLI flags by the spawned process when used as flag values (model, systemPrompt).
 * Bun.spawn uses array argv so there is no shell injection, but a `--`-prefixed
 * value passed as the argument to `--model` or `--system-prompt` can still
 * confuse the CLI parser of the target process.
 */
export function assertNotFlag(value: string | undefined, field: string): void {
  if (value?.trimStart().startsWith("--")) {
    throw new UsageError(
      `${field} must not start with "--": ${JSON.stringify(value.slice(0, 60))}`,
      "INVALID_FLAG_VALUE",
    );
  }
}

/**
 * Normalize a toolPolicy value to a comma-separated string suitable for a
 * CLI flag. Structured policy objects are JSON-serialized.
 */
export function normalizeTools(tools: ShowResponse["toolPolicy"]): string {
  if (typeof tools === "string") return tools;
  if (Array.isArray(tools)) return tools.join(",");
  return JSON.stringify(tools);
}
