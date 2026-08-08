// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The orchestration-graph vocabulary shared by the unified workflow frontmatter
 * parser (`../parser.ts`) and compiler (`../ir/compile.ts`) — adopted from the
 * pre-unification YAML program's vocabulary (workflow-format-unification, spec
 * §2.2) with these changes: `version`/`name` are gone (identity is the ref);
 * `instructions:` is gone from `ProgramUnit` (prose lives only in the markdown
 * body, bound by step id); `gate.criteria` is gone (the rubric lives in the
 * body under a `### gate` sub-heading); no `title` anywhere (a step is its
 * id). `ProgramStep` gained `inputs` — prior-step artifacts a unit/map step
 * declares as reference strings (§2.3).
 *
 * Naming: YAML keys are snake_case (`on_error`, `max_loops`); the parsed
 * document uses the repo's camelCase convention (`onError`, `maxLoops`).
 * `timeout` strings ("10m", "30s", "500ms", "none") are parsed into
 * `timeoutMs` (`null` = explicitly no timeout) — the same representation the
 * IR uses.
 *
 * Enum vocabularies here are the single TypeScript source of truth —
 * `tests/integration/workflows/program-parser.test.ts` pins the JSON Schema's
 * enums against these constants so the two cannot drift.
 */

// SourceRef / LlmInvocationOverrides / AgentFailureReason referenced via
// inline `import("...")` TYPE QUERIES (WI-9.8 KILL 3) rather than top-level
// `import type` statements. `SourceRef` lives in `../schema`, which now
// itself imports THIS file's step-vocabulary types (the unified document
// shape embeds `ProgramUnit`/`ProgramMap`/`ProgramRoute`/`ProgramGate`) — a
// top-level `import type { SourceRef } from "../schema"` here would close a
// two-file cycle the import-cycle ratchet counts (it counts `import type`,
// unlike this inline form). `LlmInvocationOverrides`/`AgentFailureReason` are
// self-contained, zero-dependency shapes living in the (heavy) agent-runtime
// modules, and this file is reached from `output/renderers.ts` (via
// `workflows/renderer.ts`) — a top-level import here would route the
// renderers hub straight back into the agent-runtime / harness-barrel
// cluster KILL 3 severs.
type SourceRef = import("../schema").SourceRef;
type LlmInvocationOverrides = import("../../integrations/agent/engine-resolution").LlmInvocationOverrides;
type AgentFailureReason = import("../../integrations/agent/spawn").AgentFailureReason;

/** How a map step folds its per-item unit results into the step artifact. */
export const PROGRAM_REDUCERS = ["collect", "vote"] as const;
export type ProgramReducer = (typeof PROGRAM_REDUCERS)[number];

/** Failure policy: fail the step on first unit failure, or record and go on. */
export const PROGRAM_ON_ERROR = ["fail", "continue"] as const;
export type ProgramOnError = (typeof PROGRAM_ON_ERROR)[number];

/** Filesystem isolation for file-mutating units. */
export const PROGRAM_ISOLATION_KINDS = ["none", "worktree"] as const;
export type ProgramIsolation = (typeof PROGRAM_ISOLATION_KINDS)[number];

/**
 * `retry.on` vocabulary — exactly the persisted `AgentFailureReason` taxonomy
 * from `src/integrations/agent/spawn.ts`. The `satisfies` clause fails the
 * typecheck if spawn.ts adds/renames a reason without this list (and the JSON
 * Schema, via the drift test) being updated.
 */
const RETRY_REASON_SET = {
  timeout: true,
  spawn_failed: true,
  non_zero_exit: true,
  parse_error: true,
  cooldown: true,
  llm_rate_limit: true,
  llm_content_filter: true,
  llm_invalid_json: true,
  content_policy_reject: true,
  unsupported_type: true,
  no_change: true,
  aborted: true,
} as const satisfies Record<AgentFailureReason, true>;

export const PROGRAM_RETRY_REASONS = Object.keys(RETRY_REASON_SET) as readonly AgentFailureReason[];

/**
 * Step ids: `[A-Za-z_][A-Za-z0-9_-]*` (also pinned in the JSON Schema) — the
 * ONE id grammar for the unified format (workflow-format-unification, spec
 * §2.2). This is EXACTLY the `<ident>` grammar `readIdent` accepts in
 * `program/expressions.ts` for `steps.<id>.output` references: a
 * letter/underscore first char, then letters/digits/underscores/dashes, and
 * NO dots (the expression parser treats `.` as the `.output` path separator,
 * so a dotted id could never be addressed). Keeping step ids inside the
 * addressable grammar guarantees every step can be referenced from map
 * inputs, routes, and `inputs:` without renaming.
 *
 * Forbidding dots additionally keeps the engine's internal gate-row node id
 * `<stepId>.gate` collision-free: no user step id can contain a dot, so it can
 * never equal another step's `<stepId>.gate` synthetic id.
 */
export const PROGRAM_STEP_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Param names must be `params.<ident>`-addressable, so they are plain
 * identifiers (no dots/dashes).
 */
export const PROGRAM_PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Bounded retry on transient failures, keyed on the persisted taxonomy. */
export interface ProgramRetry {
  max: number;
  on: AgentFailureReason[];
}

/**
 * A deterministic shell command run as a workflow unit (`unit.exec`).
 *
 * `command` is an ARGV ARRAY, never a shell string: the child is spawned
 * directly, so no shell ever parses the words. `;`, `|`, `&&`, `$(…)`, `>`
 * and friends are inert literal argument bytes — the entire quoting/injection
 * class that a `sh -c "<string>"` surface would open simply does not exist.
 * A workflow that genuinely wants a pipeline writes the interpreter itself
 * (`["bash", "-lc", "a | b"]`) and thereby makes that choice reviewable in the
 * frontmatter diff instead of hiding it behind a convenience spelling.
 *
 * `cwd` is a RELATIVE path resolved inside the unit's working directory (the
 * run's work dir, or the unit's fresh worktree under `isolation: worktree`).
 * Absolute paths and `..` segments are rejected at parse time and containment
 * is re-checked against the resolved base at dispatch, so an exec unit can
 * never step outside the tree its isolation promised.
 *
 * The child's environment is an ALLOWLIST by default (see
 * `EXEC_DEFAULT_ENV_PASSTHROUGH` in `exec/exec-unit.ts`). `pass_env` extends it
 * with a few named variables; `inherit_env` opts all the way back into the akm
 * process's whole environment. Both live inside `exec:` because the unit-level
 * `env:` key already means something else — a list of env asset binding REFS.
 */
export interface ProgramExec {
  /** argv; `command[0]` is the program, resolved through PATH. Never shell-parsed. */
  command: string[];
  /** Optional relative working directory inside the unit's base directory. */
  cwd?: string;
  /** Extra parent-process env var NAMES copied through on top of the default allowlist. */
  passEnv?: string[];
  /** `true` = give the child akm's whole environment instead of the allowlist. */
  inheritEnv?: boolean;
}

/**
 * The optional dispatch-override bag for a unit/map step. Absent entirely
 * (bare `{ id: validate }`) means the step still IS a unit step — it just
 * carries the run's engine/model/timeout defaults verbatim.
 */
export interface ProgramUnit {
  /**
   * Run a shell command instead of dispatching to an engine. Mutually
   * exclusive with `engine`/`model`/`llm` — an exec unit has no engine, so it
   * never reaches an LLM or an agent harness.
   */
  exec?: ProgramExec;
  /** Named engine override. Absent = workflow then config default. */
  engine?: string;
  /** Model alias (tier) or exact id; resolved per-harness at dispatch. */
  model?: string;
  /** LLM-only invocation settings; validated after the engine is selected. */
  llm?: LlmInvocationOverrides;
  /** Parsed per-unit timeout in ms; `null` = explicitly "none"; absent = default. */
  timeoutMs?: number | null;
  retry?: ProgramRetry;
  onError?: ProgramOnError;
  /** JSON Schema the unit's structured result must validate against. */
  output?: Record<string, unknown>;
  /** Env asset refs injected into the dispatched unit env. */
  env?: string[];
  /**
   * Worktree isolation. The native executor (`src/workflows/exec/native-executor.ts`)
   * runs each journaled attempt of an isolated agent/sdk unit in a fresh
   * detached git worktree and rejects the pairing outright for llm units.
   */
  isolation?: ProgramIsolation;
  source: SourceRef;
}

/** Fan the step out over a reference-addressed list. */
export interface ProgramMap {
  /** Reference string naming the producer of the item list (e.g. `steps.discover.output.files`). */
  over: string;
  /** Max concurrent units for this step; capped by the engine's global limit. */
  concurrency?: number;
  /** Result reducer. Default: collect. */
  reducer?: ProgramReducer;
  /** Optional per-item dispatch-override bag. */
  unit?: ProgramUnit;
}

/** One `when` branch: match value → target step id. */
export interface ProgramRouteBranch {
  match: string;
  stepId: string;
}

/** Route on an explicit reference input to a later step. */
export interface ProgramRoute {
  input: string;
  branches: ProgramRouteBranch[];
  defaultStepId?: string;
}

/**
 * Gate CONTROL fields only (workflow-format-unification, spec §2.4) — the
 * rubric lives in the markdown body under a `### gate` sub-heading inside the
 * step's section, bound to this step by id at parse time.
 */
export interface ProgramGate {
  maxLoops?: number;
}

/** One step of the gated spine. At most one of map | route. */
export interface ProgramStep {
  id: string;
  /** Optional dispatch-override bag; present on unit/map steps only. */
  unit?: ProgramUnit;
  map?: ProgramMap;
  route?: ProgramRoute;
  /**
   * Prior-step artifacts this unit/map step declares as reference strings
   * (sub-paths legal). Attached to the dispatched unit as structured
   * context; replaces prose splicing and gives replay hashing its exact
   * input set (workflow-format-unification, spec §2.3).
   */
  inputs?: string[];
  /** Step artifact schema (JSON Schema). */
  output?: Record<string, unknown>;
  gate?: ProgramGate;
  source: SourceRef;
}

/**
 * Run-level budget ceilings (frontmatter `budget:` block). Enforced by the
 * engine per run: `maxUnits` caps total dispatched units (journal-seeded), and
 * `maxTokens` caps total reported token usage (journal-seeded from
 * `workflow_run_units.tokens`). Hitting a ceiling fails the step hard,
 * regardless of `on_error`.
 */
export interface ProgramBudget {
  maxTokens?: number;
  maxUnits?: number;
}

/** Run-level defaults, overridable per unit. */
export interface ProgramDefaults {
  engine?: string;
  model?: string;
  llm?: LlmInvocationOverrides;
  /** Parsed default timeout in ms; `null` = explicitly "none". */
  timeoutMs?: number | null;
  onError?: ProgramOnError;
}
