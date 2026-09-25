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

import type { ExecutionJsonObject } from "../../execution/json";
import type { LoweringNotice, ResolvedExecutionRequestV1 } from "../../execution/resolved-request";
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
  /** Exact harness-native agent name selected by a bare agent selector. Never alias-resolved. */
  agent?: string;
  /** System prompt body — from agent asset content field. */
  systemPrompt?: string;
  /** Exact model ID resolved before harness lowering. */
  model?: string;
  /** Tool policy — from agent asset frontmatter `tools:`. */
  tools?: ShowResponse["toolPolicy"];
  /**
   * Reasoning-effort hint for harnesses that accept one (reserved for the
   * workflow engine's IR `effort` field; no builder consumes it yet).
   */
  effort?: string;
  /** Exact resolved inference object. Builders consume only fields their lowerer records as translated. */
  inference?: ExecutionJsonObject | null;
  /**
   * JSON Schema the unit's output must validate against. Reserved for the
   * workflow engine's structured-output normalization: harnesses with native
   * schema flags (e.g. Codex `--output-schema`) will pass it through; others
   * get it injected into the prompt. No builder consumes it yet.
   */
  schema?: Record<string, unknown>;
}

/** A harness's view of one resolved request, before argv/SDK dispatch. */
export interface LoweredAgentDispatch {
  readonly prompt: string;
  readonly dispatch: Readonly<AgentDispatchRequest>;
  readonly notices: readonly Readonly<LoweringNotice>[];
}

/** Models reaching a harness have already crossed the single model-map boundary. */
export function resolveDispatchModel(
  request: Pick<AgentDispatchRequest, "model">,
  _profile: AgentProfile,
  _platform: string,
): string | undefined {
  return request.model;
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

/**
 * Normalized payload extracted from one raw harness run (P2, plan §"The
 * adapter contract" step 3 / §"Structured-output normalization").
 *
 * `text` is the harness's final answer with transport framing stripped
 * (JSONL event streams, SDK envelopes, banner noise) — the input that
 * schema validation / `parseEmbeddedJsonResponse` then runs against.
 * `sessionId` is the harness-native session id when the output reveals one,
 * stored opportunistically on the unit row for resume (`workflow_run_units`
 * stays the source of truth; akm never depends on it).
 */
export interface AgentResultExtraction {
  text: string;
  sessionId?: string;
}

/**
 * Per-harness result extractor — the counterpart of {@link AgentCommandBuilder}
 * on the output side. Registered on the harness descriptor
 * (`AkmHarness.resultExtractor`) so the workflow engine can normalize any
 * harness's raw `AgentRunResult` without a hand-maintained switch.
 *
 * A function type (not an object) because extraction is a pure
 * `raw result → { text, sessionId? }` mapping; schema validation and the
 * retry-until-valid loop stay in the engine, shared across harnesses.
 *
 * `AgentRunResult` is referenced via an inline `import("./spawn")` TYPE QUERY
 * (WI-9.8 KILL 3, D.3 edge C) rather than a top-level `import type` — this
 * file is a dependency-graph LEAF that every harness's agent-builder AND
 * result-extractor import; `./spawn.ts` itself imports `./builders.ts`
 * (`getCommandBuilder`), which imports the harness barrel, which imports
 * every harness — a top-level import here would close that loop right back.
 * An inline type query is erased at compile time (same as `core/config`'s
 * `typeof import("./config-schema")` pattern) so it carries zero runtime
 * footprint and is invisible to the static import graph, unlike a top-level
 * `import type` (which the cycle ratchet DOES count — see trap list).
 */
export type AgentResultExtractor = (result: import("./spawn").AgentRunResult) => AgentResultExtraction;

/** Harness-owned resolved-request projection, shared by CLI and SDK engines. */
export interface AgentRequestLowerer {
  /** Canonical harness platform identifier. */
  readonly platform: string;
  /** Whether this transport has a distinct native persona/system channel. */
  readonly personaChannel: "native" | "prompt";
  /** Map one resolved request onto this harness's dispatch shape. */
  lower(profile: AgentProfile, request: ResolvedExecutionRequestV1): LoweredAgentDispatch;
}

/** Strategy for building the argv for one agent CLI platform. */
export interface AgentCommandBuilder {
  /** Canonical harness platform identifier. */
  readonly platform: string;
  /** Whether this transport has a distinct native persona/system channel. */
  readonly personaChannel: "native" | "prompt";
  /**
   * Production builders register this structural lowerer. It remains optional
   * on the low-level builder test seam, whose tiny fake builders never cross
   * the resolved execution boundary.
   */
  readonly lower?: AgentRequestLowerer["lower"];
  /**
   * Build the concrete command for this platform.
   * Receives the fully-resolved profile (with user overrides merged in) and
   * the abstract dispatch request. Returns argv + optional env/stdin overrides.
   */
  build(profile: AgentProfile, request: AgentDispatchRequest): BuiltCommand;
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
