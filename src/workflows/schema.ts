// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Validated JSON shape for a workflow asset.
 *
 * `parseWorkflow` (parser.ts) converts a workflow markdown file into a
 * `WorkflowDocument` plus a list of `WorkflowError`s. The document is the
 * single source of truth consumed by the renderer, the indexer (cached
 * into `workflow_documents` in `index.db`), and the run engine. Source
 * markdown is referenced by `SourceRef` line spans so editors and agents
 * can rewrite content in place without a full re-parse.
 */

export const WORKFLOW_SCHEMA_VERSION = 1;

/** 1-indexed inclusive line range in a markdown file. */
export interface LineSpan {
  start: number;
  end: number;
}

/** A line span anchored to a specific source file (relative to the source root). */
export interface SourceRef extends LineSpan {
  path: string;
}

export interface WorkflowParameter {
  name: string;
  description: string;
  source: SourceRef;
}

export interface WorkflowInstructionBlock {
  text: string;
  source: SourceRef;
}

export interface WorkflowCompletionCriterion {
  text: string;
  source: SourceRef;
}

/** Execution backend for a step's units. `inherit` defers to the run default. */
export type WorkflowRunnerKind = "llm" | "agent" | "sdk" | "inherit";

/** How a fan-out step's unit results are combined into the step evidence. */
export type WorkflowFanOutReducer = "collect" | "vote";

/**
 * Fan-out declaration (`### Fan-out`): run the step's instructions once per
 * item of a list named by `over` (a run param or a prior step's evidence key).
 */
export interface WorkflowFanOut {
  over: string;
  /** Max concurrent units for this step; capped by the engine's global limit. */
  concurrency?: number;
  /** Result reducer. Default: collect. */
  reducer?: WorkflowFanOutReducer;
}

/**
 * Optional orchestration declared on a step (P1 extended grammar). Steps that
 * declare none behave exactly as before — a single manual/agent-driven step.
 */
export interface WorkflowStepOrchestration {
  /** Execution backend (`### Runner`, first line). Default: inherit. */
  runner?: WorkflowRunnerKind;
  /** Agent/LLM profile name (`### Runner`, `profile:` line). */
  profile?: string;
  /** Model alias or exact id (`### Model`), resolved per-harness at dispatch. */
  model?: string;
  /** Per-unit timeout in ms (`### Timeout`); null = explicitly no timeout. */
  timeoutMs?: number | null;
  /** Fan-out declaration (`### Fan-out`). */
  fanOut?: WorkflowFanOut;
  /** JSON Schema each unit result must validate against (`### Schema`). */
  schema?: Record<string, unknown>;
  /** Env asset refs injected into the dispatched unit env (`### Env`). */
  env?: string[];
  /** Non-linear ordering edges (`### Depends On`), validated against step ids. */
  dependsOn?: string[];
  /** Anchor of the first orchestration subsection, for editor jumps. */
  source: SourceRef;
}

export interface WorkflowStep {
  id: string;
  title: string;
  sequenceIndex: number;
  instructions: WorkflowInstructionBlock;
  completionCriteria?: WorkflowCompletionCriterion[];
  /** Present only when the step declares orchestration subsections. */
  orchestration?: WorkflowStepOrchestration;
  source: SourceRef;
}

export interface WorkflowDocument {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  title: string;
  description?: string;
  tags?: string[];
  parameters?: WorkflowParameter[];
  steps: WorkflowStep[];
  source: { path: string; lineCount: number };
}

/**
 * A single problem in the source markdown. CLI and indexer format these
 * uniformly as `path:line — message`. The fix is baked into the message
 * itself; there is no separate hint field, code, or severity.
 */
export interface WorkflowError {
  /** 1-indexed line in the source markdown the problem refers to. */
  line: number;
  /** Human-readable message including the offending value and how to fix it. */
  message: string;
}

export type WorkflowParseResult = { ok: true; document: WorkflowDocument } | { ok: false; errors: WorkflowError[] };
