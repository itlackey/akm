// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * YAML workflow program → `WorkflowProgram` (redesign addendum, R1).
 *
 * Composition over invention: the document is parsed once with the `yaml`
 * package (`parseDocument` + `LineCounter` for best-effort line anchoring),
 * then validated field-by-field, accumulating `WorkflowError`s rather than
 * throwing. Structural rules mirror the published JSON Schema
 * (`schemas/akm-workflow.json`); semantic rules this parser owns:
 *
 *   - duplicate step ids;
 *   - exactly one of `unit` | `map` | `route` per step;
 *   - route targets exist, come AFTER the routing step, never self-route,
 *     and `when` matches are unique (even across YAML key types);
 *   - timeout format (`<n>ms` | `<n>s` | `<n>m` | `none`, positive);
 *   - `retry.on` values within the persisted `AgentFailureReason` taxonomy;
 *   - `params` is a name → JSON-Schema-ish-object map.
 *
 * Expressions (`${{ … }}`) are NOT resolved here — the compiler/validator
 * owns reference checking. This parser only runs a cheap syntactic pass so
 * obviously malformed templates fail at lint time.
 */

import { createRequire } from "node:module";
import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import { formatExtraParamsIssue, validateExtraParams } from "../../core/extra-params";
import {
  jsonBytes,
  utf8Bytes,
  WORKFLOW_MAX_EXTRA_PARAMS_BYTES,
  WORKFLOW_MAX_INSTRUCTION_BYTES,
  WORKFLOW_MAX_MAP_EXPANSION,
  WORKFLOW_MAX_PARAMS,
  WORKFLOW_MAX_ROUTE_BRANCHES,
  WORKFLOW_MAX_SCHEMA_BYTES,
  WORKFLOW_MAX_SOURCE_BYTES,
  WORKFLOW_MAX_STEPS,
} from "../resource-limits";
import type { SourceRef, WorkflowError } from "../schema";
import {
  PROGRAM_ISOLATION_KINDS,
  PROGRAM_ON_ERROR,
  PROGRAM_PARAM_NAME_PATTERN,
  PROGRAM_REDUCERS,
  PROGRAM_RETRY_REASONS,
  PROGRAM_STEP_ID_PATTERN,
  type ProgramBudget,
  type ProgramDefaults,
  type ProgramGate,
  type ProgramIsolation,
  type ProgramMap,
  type ProgramOnError,
  type ProgramReducer,
  type ProgramRetry,
  type ProgramRoute,
  type ProgramStep,
  type ProgramUnit,
  WORKFLOW_PROGRAM_VERSION,
  type WorkflowProgram,
  type WorkflowProgramParseResult,
} from "./schema";

// LlmInvocationOverrides referenced via an inline `import("...")` TYPE QUERY
// (WI-9.8 KILL 3) rather than a top-level `import type` — this file is
// reached from `output/renderers.ts` (via `workflows/renderer.ts`), and a
// top-level import of the agent-runtime here would route the renderers hub
// back into the agent-runtime / harness-barrel cluster KILL 3 severs. Same
// rationale as `./schema.ts`'s identical query.
type LlmInvocationOverrides = import("../../integrations/agent/engine-resolution").LlmInvocationOverrides;

const TOP_LEVEL_KEYS = ["version", "name", "description", "params", "defaults", "budget", "steps"];
const DEFAULTS_KEYS = ["engine", "model", "timeout", "on_error", "llm"];
const BUDGET_KEYS = ["max_tokens", "max_units"];
const STEP_KEYS = ["id", "title", "unit", "map", "route", "output", "gate"];
const UNIT_KEYS = [
  "engine",
  "model",
  "llm",
  "timeout",
  "retry",
  "on_error",
  "instructions",
  "output",
  "env",
  "isolation",
];
const MAP_KEYS = ["over", "concurrency", "reducer", "unit"];
const ROUTE_KEYS = ["input", "when", "default"];
const RETRY_KEYS = ["max", "on"];
const GATE_KEYS = ["criteria", "max_loops", "required"];
const STEP_KINDS = ["unit", "map", "route"] as const;

const TIMEOUT_VALUE = /^(\d+)(ms|s|m)?$/;
const TIMEOUT_HINT = `Use "<n>ms", "<n>s", "<n>m" (e.g. "10m"), or "none"`;

/**
 * Cheap structural probe for the indexer matcher (mirrors `looksLikeWorkflow`
 * in ../parser.ts). Returns true if the text has the unmistakable top-level
 * shape of a YAML workflow program: `version: 2` and a `steps:` key, both at
 * column 0. Used so the matcher and parser cannot drift.
 */
export function looksLikeWorkflowProgram(yamlText: string): boolean {
  return /^version[ \t]*:[ \t]*['"]?(?:1|2)['"]?[ \t]*(#.*)?$/m.test(yamlText) && /^steps[ \t]*:/m.test(yamlText);
}

type Path = Array<string | number>;

/** Yaml AST node surface we rely on for line anchoring (best-effort). */
interface RangedNode {
  range?: [number, number, number] | null;
}

interface Ctx {
  readonly filePath: string;
  readonly errors: WorkflowError[];
  lineAt(path: Path): number;
  lineAtOffset(offset: number): number;
  refAt(path: Path): SourceRef;
  nodeAt(path: Path): unknown;
  err(path: Path, message: string): void;
  errAtLine(line: number, message: string): void;
  checkTemplates(text: string, path: Path, label: string): void;
}

/** Route branch bookkeeping for the post-pass (targets need all step ids). */
interface RouteCheck {
  stepIndex: number;
  stepLabel: string;
  branches: Array<{ match: string; stepId: string; line: number }>;
  defaultTarget?: { stepId: string; line: number };
}

export function parseWorkflowProgram(yamlText: string, source: { path: string }): WorkflowProgramParseResult {
  if (utf8Bytes(yamlText) > WORKFLOW_MAX_SOURCE_BYTES) {
    return {
      ok: false,
      errors: [{ line: 1, message: "Workflow source exceeds the 1 MiB resource limit." }],
    };
  }
  const errors: WorkflowError[] = [];
  const lineCounter = new LineCounter();

  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText, { lineCounter });
  } catch (cause) {
    return { ok: false, errors: [{ line: 1, message: `YAML parse failed: ${describeError(cause)}` }] };
  }

  for (const problem of doc.errors) {
    const offset = Array.isArray(problem.pos) ? problem.pos[0] : 0;
    errors.push({ line: Math.max(1, lineCounter.linePos(offset).line), message: yamlErrorMessage(problem.message) });
  }
  if (errors.length > 0) return { ok: false, errors };

  let root: unknown;
  try {
    root = doc.toJS();
  } catch (cause) {
    // e.g. the alias-expansion bomb guard (maxAliasCount) throwing.
    return { ok: false, errors: [{ line: 1, message: `YAML expansion failed: ${describeError(cause)}` }] };
  }

  const lineAt = (path: Path): number => {
    for (let depth = path.length; depth >= 0; depth--) {
      const node = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true);
      const range = (node as RangedNode | null | undefined)?.range;
      if (range) return Math.max(1, lineCounter.linePos(range[0]).line);
    }
    return 1;
  };

  const ctx: Ctx = {
    filePath: source.path,
    errors,
    lineAt,
    lineAtOffset: (offset) => Math.max(1, lineCounter.linePos(offset).line),
    nodeAt: (path) => (path.length === 0 ? doc.contents : doc.getIn(path, true)),
    refAt: (path) => {
      for (let depth = path.length; depth >= 0; depth--) {
        const node = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true);
        const range = (node as RangedNode | null | undefined)?.range;
        if (range) {
          const start = Math.max(1, lineCounter.linePos(range[0]).line);
          const end = Math.max(start, lineCounter.linePos(Math.max(range[0], range[1] - 1)).line);
          return { path: source.path, start, end };
        }
      }
      return { path: source.path, start: 1, end: 1 };
    },
    err: (path, message) => errors.push({ line: lineAt(path), message }),
    errAtLine: (line, message) => errors.push({ line, message }),
    checkTemplates: (text, path, label) => checkTemplates(ctx, text, path, label),
  };

  if (!isPlainRecord(root)) {
    return {
      ok: false,
      errors: [
        { line: 1, message: `A workflow program must be a YAML mapping with "version: 2", "name", and "steps".` },
      ],
    };
  }

  checkUnknownKeys(ctx, root, [], TOP_LEVEL_KEYS, "top-level");

  if (root.version !== WORKFLOW_PROGRAM_VERSION) {
    if (root.version === 1) {
      ctx.err(
        ["version"],
        `Workflow version 1 retired; version 2 is required. Replace runner/profile selectors with engine.`,
      );
    } else {
      const got = root.version === undefined ? "it is missing" : `got ${JSON.stringify(root.version)}`;
      ctx.err(["version"], `"version: 2" is required at the top level (${got}). Only the number 2 is a valid version.`);
    }
  }

  let name = "";
  if (typeof root.name === "string" && root.name.trim() !== "") {
    name = root.name.trim();
    ctx.checkTemplates(root.name, ["name"], `"name"`);
  } else {
    ctx.err(["name"], `"name" is required and must be a non-empty string.`);
  }

  let description: string | undefined;
  if (root.description !== undefined) {
    if (typeof root.description === "string") {
      description = root.description;
      ctx.checkTemplates(root.description, ["description"], `"description"`);
    } else {
      ctx.err(["description"], `"description" must be a string.`);
    }
  }

  const params = parseParams(ctx, root.params);
  const defaults = parseDefaults(ctx, root.defaults);
  const budget = parseBudget(ctx, root.budget);
  const steps = parseSteps(ctx, root.steps);

  if (errors.length > 0) return { ok: false, errors };

  const program: WorkflowProgram = {
    version: WORKFLOW_PROGRAM_VERSION,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(params !== undefined ? { params } : {}),
    ...(defaults !== undefined ? { defaults } : {}),
    ...(budget !== undefined ? { budget } : {}),
    steps,
    source: { path: source.path },
  };
  return { ok: true, program };
}

// ---------------------------------------------------------------------------
// Top-level sections
// ---------------------------------------------------------------------------

function parseParams(ctx: Ctx, raw: unknown): Record<string, Record<string, unknown>> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw)) {
    ctx.err(
      ["params"],
      `"params" must be a mapping of param name to a JSON Schema object (e.g. changed_files: { type: array }).`,
    );
    return undefined;
  }
  if (Object.keys(raw).length > WORKFLOW_MAX_PARAMS) {
    ctx.err(["params"], `"params" must contain at most ${WORKFLOW_MAX_PARAMS} entries.`);
  }
  const params: Record<string, Record<string, unknown>> = {};
  for (const [paramName, value] of Object.entries(raw)) {
    if (!PROGRAM_PARAM_NAME_PATTERN.test(paramName)) {
      ctx.err(
        ["params", paramName],
        `Param name "${paramName}" is invalid. Use letters, digits, and underscores, starting with a letter or underscore, so "\${{ params.${paramName} }}" can address it.`,
      );
      continue;
    }
    if (!isPlainRecord(value)) {
      ctx.err(["params", paramName], `Param "${paramName}" must be a JSON Schema object (e.g. { type: string }).`);
      continue;
    }
    params[paramName] = value;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

function parseDefaults(ctx: Ctx, raw: unknown): ProgramDefaults | undefined {
  if (raw === undefined) return undefined;
  const path: Path = ["defaults"];
  if (!isPlainRecord(raw)) {
    ctx.err(path, `"defaults" must be a mapping with any of: ${DEFAULTS_KEYS.join(", ")}.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, DEFAULTS_KEYS, `"defaults"`);
  const defaults: ProgramDefaults = {};
  if (raw.engine !== undefined) {
    if (typeof raw.engine === "string" && raw.engine.trim() !== "") defaults.engine = raw.engine.trim();
    else ctx.err([...path, "engine"], `"defaults.engine" must be a non-empty engine name.`);
  }
  if (raw.model !== undefined) {
    if (typeof raw.model === "string" && raw.model.trim() !== "") defaults.model = raw.model.trim();
    else ctx.err([...path, "model"], `"defaults.model" must be a non-empty string (a model alias or exact id).`);
  }
  const timeoutMs = parseTimeoutField(ctx, raw.timeout, [...path, "timeout"], `"defaults.timeout"`);
  if (timeoutMs !== undefined) defaults.timeoutMs = timeoutMs;
  const onError = parseEnumField(ctx, raw.on_error, [...path, "on_error"], `"defaults.on_error"`, PROGRAM_ON_ERROR);
  if (onError !== undefined) defaults.onError = onError as ProgramOnError;
  const llm = parseLlmOverrides(ctx, raw.llm, [...path, "llm"], `"defaults.llm"`);
  if (llm !== undefined) defaults.llm = llm;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function parseBudget(ctx: Ctx, raw: unknown): ProgramBudget | undefined {
  if (raw === undefined) return undefined;
  const path: Path = ["budget"];
  if (!isPlainRecord(raw)) {
    ctx.err(path, `"budget" must be a mapping with any of: ${BUDGET_KEYS.join(", ")}.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, BUDGET_KEYS, `"budget"`);
  const budget: ProgramBudget = {};
  if (raw.max_tokens !== undefined) {
    if (typeof raw.max_tokens === "number" && Number.isInteger(raw.max_tokens) && raw.max_tokens >= 1) {
      budget.maxTokens = raw.max_tokens;
    } else {
      ctx.err([...path, "max_tokens"], `"budget.max_tokens" must be an integer >= 1.`);
    }
  }
  if (raw.max_units !== undefined) {
    if (
      typeof raw.max_units === "number" &&
      Number.isInteger(raw.max_units) &&
      raw.max_units >= 1 &&
      raw.max_units <= WORKFLOW_MAX_MAP_EXPANSION
    ) {
      budget.maxUnits = raw.max_units;
    } else {
      ctx.err(
        [...path, "max_units"],
        `"budget.max_units" must be an integer from 1 through ${WORKFLOW_MAX_MAP_EXPANSION}.`,
      );
    }
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function parseSteps(ctx: Ctx, raw: unknown): ProgramStep[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    ctx.err(["steps"], `"steps" is required and must be a list with at least one step.`);
    return [];
  }
  if (raw.length > WORKFLOW_MAX_STEPS) {
    ctx.err(["steps"], `"steps" must contain at most ${WORKFLOW_MAX_STEPS} entries.`);
  }

  // First pass: collect ids so route targets can be checked against ALL steps
  // (including ones that fail their own validation).
  const idIndex = new Map<string, number>();
  raw.forEach((rawStep, index) => {
    if (isPlainRecord(rawStep) && typeof rawStep.id === "string" && !idIndex.has(rawStep.id)) {
      idIndex.set(rawStep.id, index);
    }
  });

  const steps: ProgramStep[] = [];
  const seenIds = new Map<string, number>();
  const routeChecks: RouteCheck[] = [];

  raw.forEach((rawStep, index) => {
    const path: Path = ["steps", index];
    if (!isPlainRecord(rawStep)) {
      ctx.err(path, `Step ${index + 1} must be a mapping with an "id" and exactly one of "unit", "map", or "route".`);
      return;
    }
    const label = typeof rawStep.id === "string" && rawStep.id !== "" ? `Step "${rawStep.id}"` : `Step ${index + 1}`;
    checkUnknownKeys(ctx, rawStep, path, STEP_KEYS, label);

    let id = "";
    if (typeof rawStep.id !== "string" || rawStep.id === "") {
      ctx.err([...path, "id"], `${label} requires a non-empty string "id".`);
    } else if (!PROGRAM_STEP_ID_PATTERN.test(rawStep.id)) {
      ctx.err(
        [...path, "id"],
        `${label} has an invalid id "${rawStep.id}". A step id cannot be referenced from \${{ }} expressions ` +
          `unless it matches [A-Za-z_][A-Za-z0-9_-]* (a letter or underscore first, then letters, digits, ` +
          `underscores, or dashes; no dots, no leading digit) — otherwise \${{ steps.${rawStep.id}.output }} ` +
          `cannot be written.`,
      );
    } else {
      id = rawStep.id;
      const firstIndex = seenIds.get(id);
      if (firstIndex !== undefined) {
        ctx.err(
          [...path, "id"],
          `Duplicate step id "${id}" (first used by step ${firstIndex + 1}). Step ids must be unique.`,
        );
      } else {
        seenIds.set(id, index);
      }
    }

    let title: string | undefined;
    if (rawStep.title !== undefined) {
      if (typeof rawStep.title === "string" && rawStep.title.trim() !== "") {
        title = rawStep.title.trim();
        ctx.checkTemplates(rawStep.title, [...path, "title"], `${label} "title"`);
      } else {
        ctx.err([...path, "title"], `${label} "title" must be a non-empty string.`);
      }
    }

    const declaredKinds = STEP_KINDS.filter((kind) => rawStep[kind] !== undefined);
    if (declaredKinds.length !== 1) {
      const found = declaredKinds.length === 0 ? "found none" : `found ${declaredKinds.join(" + ")}`;
      ctx.err(path, `${label} must declare exactly one of "unit", "map", or "route" (${found}).`);
    }

    // Parse every declared block (even when the exactly-one rule already
    // failed) so all inner problems surface in a single validate run.
    const unit = rawStep.unit !== undefined ? parseUnit(ctx, rawStep.unit, [...path, "unit"], label) : undefined;
    const map = rawStep.map !== undefined ? parseMap(ctx, rawStep.map, [...path, "map"], label) : undefined;
    const route =
      rawStep.route !== undefined
        ? parseRoute(ctx, rawStep.route, [...path, "route"], label, index, routeChecks)
        : undefined;

    const output = parseSchemaObject(ctx, rawStep.output, [...path, "output"], `${label} "output"`);
    const gate = rawStep.gate !== undefined ? parseGate(ctx, rawStep.gate, [...path, "gate"], label) : undefined;

    const step: ProgramStep = { id, source: ctx.refAt(path) };
    if (title !== undefined) step.title = title;
    if (declaredKinds.length === 1) {
      if (unit) step.unit = unit;
      if (map) step.map = map;
      if (route) step.route = route;
    }
    if (output !== undefined) step.output = output;
    if (gate !== undefined) step.gate = gate;
    steps.push(step);
  });

  // Route target post-pass: targets exist, come after the routing step, and
  // never point back at it.
  for (const check of routeChecks) {
    const targets = [...check.branches.map((b) => ({ stepId: b.stepId, line: b.line }))];
    if (check.defaultTarget) targets.push(check.defaultTarget);
    for (const target of targets) {
      const targetIndex = idIndex.get(target.stepId);
      if (targetIndex === undefined) {
        ctx.errAtLine(
          target.line,
          `${check.stepLabel} routes to unknown step "${target.stepId}". Route targets must name a step id in this workflow.`,
        );
      } else if (targetIndex === check.stepIndex) {
        ctx.errAtLine(target.line, `${check.stepLabel} must not route to itself.`);
      } else if (targetIndex < check.stepIndex) {
        ctx.errAtLine(
          target.line,
          `${check.stepLabel} routes backward to "${target.stepId}" (step ${targetIndex + 1}). Route targets must come after the routing step.`,
        );
      }
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Step blocks
// ---------------------------------------------------------------------------

function parseUnit(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): ProgramUnit | undefined {
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${stepLabel} "unit" must be a mapping with an "instructions" key.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, UNIT_KEYS, `${stepLabel} "unit"`);

  const unit: ProgramUnit = { instructions: "", source: ctx.refAt(path) };

  if (typeof raw.instructions === "string" && raw.instructions.trim() !== "") {
    unit.instructions = raw.instructions;
    ctx.checkTemplates(raw.instructions, [...path, "instructions"], `${stepLabel} "instructions"`);
    if (utf8Bytes(raw.instructions) > WORKFLOW_MAX_INSTRUCTION_BYTES) {
      ctx.err([...path, "instructions"], `${stepLabel} "instructions" exceeds the 256 KiB resource limit.`);
    }
  } else {
    ctx.err([...path, "instructions"], `${stepLabel} "unit" requires non-empty string "instructions".`);
  }

  if (raw.engine !== undefined) {
    if (typeof raw.engine === "string" && raw.engine.trim() !== "") unit.engine = raw.engine.trim();
    else ctx.err([...path, "engine"], `${stepLabel} "engine" must be a non-empty engine name.`);
  }
  if (raw.model !== undefined) {
    if (typeof raw.model === "string" && raw.model.trim() !== "") unit.model = raw.model.trim();
    else ctx.err([...path, "model"], `${stepLabel} "model" must be a non-empty string (a model alias or exact id).`);
  }
  const llm = parseLlmOverrides(ctx, raw.llm, [...path, "llm"], `${stepLabel} "llm"`);
  if (llm !== undefined) unit.llm = llm;

  const timeoutMs = parseTimeoutField(ctx, raw.timeout, [...path, "timeout"], `${stepLabel} "timeout"`);
  if (timeoutMs !== undefined) unit.timeoutMs = timeoutMs;

  const retry = parseRetry(ctx, raw.retry, [...path, "retry"], stepLabel);
  if (retry !== undefined) unit.retry = retry;

  const onError = parseEnumField(ctx, raw.on_error, [...path, "on_error"], `${stepLabel} "on_error"`, PROGRAM_ON_ERROR);
  if (onError !== undefined) unit.onError = onError as ProgramOnError;

  const output = parseSchemaObject(ctx, raw.output, [...path, "output"], `${stepLabel} unit "output"`);
  if (output !== undefined) unit.output = output;

  if (raw.env !== undefined) {
    if (Array.isArray(raw.env) && raw.env.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
      unit.env = raw.env.map((entry) => (entry as string).trim());
    } else {
      ctx.err([...path, "env"], `${stepLabel} "env" must be a list of non-empty env asset refs.`);
    }
  }

  const isolation = parseEnumField(
    ctx,
    raw.isolation,
    [...path, "isolation"],
    `${stepLabel} "isolation"`,
    PROGRAM_ISOLATION_KINDS,
  );
  if (isolation !== undefined) unit.isolation = isolation as ProgramIsolation;

  return unit;
}

function parseMap(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): ProgramMap | undefined {
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${stepLabel} "map" must be a mapping with "over" and "unit" keys.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, MAP_KEYS, `${stepLabel} "map"`);

  let over = "";
  if (typeof raw.over === "string" && raw.over.trim() !== "") {
    over = raw.over.trim();
    ctx.checkTemplates(raw.over, [...path, "over"], `${stepLabel} "over"`);
  } else {
    ctx.err(
      [...path, "over"],
      `${stepLabel} "map" requires "over": a \${{ … }} expression naming the item list (e.g. \${{ steps.discover.output.files }}).`,
    );
  }

  let concurrency: number | undefined;
  if (raw.concurrency !== undefined) {
    if (typeof raw.concurrency === "number" && Number.isInteger(raw.concurrency) && raw.concurrency > 0) {
      concurrency = raw.concurrency;
    } else {
      ctx.err([...path, "concurrency"], `${stepLabel} "concurrency" must be a positive integer.`);
    }
  }

  const reducer = parseEnumField(ctx, raw.reducer, [...path, "reducer"], `${stepLabel} "reducer"`, PROGRAM_REDUCERS);

  const unit = raw.unit !== undefined ? parseUnit(ctx, raw.unit, [...path, "unit"], stepLabel) : undefined;
  if (raw.unit === undefined) {
    ctx.err(path, `${stepLabel} "map" requires a nested "unit" to fan out.`);
  }
  if (unit === undefined) return undefined;

  const map: ProgramMap = { over, unit };
  if (concurrency !== undefined) map.concurrency = concurrency;
  if (reducer !== undefined) map.reducer = reducer as ProgramReducer;
  return map;
}

function parseRoute(
  ctx: Ctx,
  raw: unknown,
  path: Path,
  stepLabel: string,
  stepIndex: number,
  routeChecks: RouteCheck[],
): ProgramRoute | undefined {
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${stepLabel} "route" must be a mapping with "input" and "when" keys.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, ROUTE_KEYS, `${stepLabel} "route"`);

  let input = "";
  if (typeof raw.input === "string" && raw.input.trim() !== "") {
    input = raw.input.trim();
    ctx.checkTemplates(raw.input, [...path, "input"], `${stepLabel} "route.input"`);
  } else {
    ctx.err(
      [...path, "input"],
      `${stepLabel} "route" requires "input": a \${{ … }} expression naming the value to route on.`,
    );
  }

  const check: RouteCheck = { stepIndex, stepLabel, branches: [] };
  const whenPath: Path = [...path, "when"];
  const whenNode = ctx.nodeAt(whenPath);

  if (raw.when === undefined || !isPlainRecord(raw.when)) {
    ctx.err(
      whenPath,
      `${stepLabel} "route" requires "when": a mapping of match value to target step id (e.g. when: { pass: ship }).`,
    );
  } else if (isMap(whenNode)) {
    if (whenNode.items.length > WORKFLOW_MAX_ROUTE_BRANCHES) {
      ctx.err(whenPath, `${stepLabel} "when" must contain at most ${WORKFLOW_MAX_ROUTE_BRANCHES} branches.`);
    }
    // Walk the AST pairs (not the JS object) so duplicate matches that only
    // collide after stringification ("true" vs true) are still caught.
    const seenMatches = new Map<string, number>();
    for (const pair of whenNode.items) {
      const keyLine = rangedLine(ctx, pair.key, whenPath);
      if (!isScalar(pair.key)) {
        ctx.errAtLine(keyLine, `${stepLabel} "when" match keys must be scalar values.`);
        continue;
      }
      const match = String(pair.key.value);
      const valueNode = pair.value;
      const valueLine = rangedLine(ctx, valueNode, whenPath);
      const target = isScalar(valueNode) && typeof valueNode.value === "string" ? valueNode.value.trim() : "";
      if (target === "") {
        ctx.errAtLine(valueLine, `${stepLabel} "when: ${match}" must map to a step id string.`);
        continue;
      }
      const firstLine = seenMatches.get(match);
      if (firstLine !== undefined) {
        ctx.errAtLine(
          keyLine,
          `${stepLabel} has a duplicate "when" match "${match}" (first declared on line ${firstLine}). Matches must be unique.`,
        );
        continue;
      }
      seenMatches.set(match, keyLine);
      check.branches.push({ match, stepId: target, line: valueLine });
    }
    if (check.branches.length === 0 && whenNode.items.length === 0) {
      ctx.err(whenPath, `${stepLabel} "when" must contain at least one match → step-id entry.`);
    }
  } else {
    // AST unavailable (e.g. the mapping came through an alias) — fall back to
    // the resolved JS object; duplicate-key detection already ran in YAML.
    for (const [match, target] of Object.entries(raw.when)) {
      if (typeof target === "string" && target.trim() !== "") {
        check.branches.push({ match, stepId: target.trim(), line: ctx.lineAt(whenPath) });
      } else {
        ctx.err(whenPath, `${stepLabel} "when: ${match}" must map to a step id string.`);
      }
    }
    if (Object.keys(raw.when).length > WORKFLOW_MAX_ROUTE_BRANCHES) {
      ctx.err(whenPath, `${stepLabel} "when" must contain at most ${WORKFLOW_MAX_ROUTE_BRANCHES} branches.`);
    }
    if (Object.keys(raw.when).length === 0) {
      ctx.err(whenPath, `${stepLabel} "when" must contain at least one match → step-id entry.`);
    }
  }

  let defaultStepId: string | undefined;
  if (raw.default !== undefined) {
    if (typeof raw.default === "string" && raw.default.trim() !== "") {
      defaultStepId = raw.default.trim();
      check.defaultTarget = { stepId: defaultStepId, line: ctx.lineAt([...path, "default"]) };
    } else {
      ctx.err([...path, "default"], `${stepLabel} "route.default" must be a step id string.`);
    }
  }

  routeChecks.push(check);

  const route: ProgramRoute = { input, branches: check.branches.map(({ match, stepId }) => ({ match, stepId })) };
  if (defaultStepId !== undefined) route.defaultStepId = defaultStepId;
  return route;
}

function parseGate(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): ProgramGate | undefined {
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${stepLabel} "gate" must be a mapping with a "criteria" list.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, GATE_KEYS, `${stepLabel} "gate"`);

  const gate: ProgramGate = { criteria: [] };
  if (
    Array.isArray(raw.criteria) &&
    raw.criteria.length > 0 &&
    raw.criteria.every((c) => typeof c === "string" && c.trim() !== "")
  ) {
    gate.criteria = raw.criteria.map((c) => (c as string).trim());
    for (const [i, c] of raw.criteria.entries()) {
      ctx.checkTemplates(c as string, [...path, "criteria", i], `${stepLabel} gate criterion ${i + 1}`);
    }
  } else {
    ctx.err([...path, "criteria"], `${stepLabel} "gate" requires "criteria": a non-empty list of criterion strings.`);
  }
  if (raw.max_loops !== undefined) {
    // TODO(R2): max_loops execution (bounded evaluator-optimizer) is engine
    // rework scope; the parser validates and carries it through.
    if (typeof raw.max_loops === "number" && Number.isInteger(raw.max_loops) && raw.max_loops >= 1) {
      gate.maxLoops = raw.max_loops;
    } else {
      ctx.err([...path, "max_loops"], `${stepLabel} "gate.max_loops" must be an integer >= 1.`);
    }
  }
  if (raw.required !== undefined) {
    // Reviewer #18: a required gate must be judged; with no judge available the
    // engine/report BLOCK the step instead of failing open.
    if (typeof raw.required === "boolean") {
      gate.required = raw.required;
    } else {
      ctx.err([...path, "required"], `${stepLabel} "gate.required" must be a boolean (true or false).`);
    }
  }
  return gate;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function parseRetry(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): ProgramRetry | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${stepLabel} "retry" must be a mapping: { max: <n>, on: [<failure_reason>, …] }.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, RETRY_KEYS, `${stepLabel} "retry"`);

  let ok = true;
  if (!(typeof raw.max === "number" && Number.isInteger(raw.max) && raw.max >= 0)) {
    ctx.err([...path, "max"], `${stepLabel} "retry.max" is required and must be a non-negative integer.`);
    ok = false;
  }
  const on: ProgramRetry["on"] = [];
  if (Array.isArray(raw.on) && raw.on.length > 0) {
    raw.on.forEach((reason, i) => {
      if (typeof reason === "string" && (PROGRAM_RETRY_REASONS as readonly string[]).includes(reason)) {
        on.push(reason as ProgramRetry["on"][number]);
      } else {
        ctx.err(
          [...path, "on", i],
          `${stepLabel} "retry.on" has unknown failure reason ${JSON.stringify(reason)}. Valid reasons: ${PROGRAM_RETRY_REASONS.join(", ")}.`,
        );
        ok = false;
      }
    });
  } else {
    ctx.err(
      [...path, "on"],
      `${stepLabel} "retry.on" is required and must be a non-empty list of failure reasons (${PROGRAM_RETRY_REASONS.join(", ")}).`,
    );
    ok = false;
  }
  return ok ? { max: raw.max as number, on } : undefined;
}

function parseTimeoutField(ctx: Ctx, raw: unknown, path: Path, label: string): number | null | undefined {
  if (raw === undefined) return undefined;
  // Bare integers keep the existing duration semantics (a number is ms).
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && raw > 0) return raw;
    ctx.err(path, `${label} has a non-positive timeout ${JSON.stringify(raw)}. ${TIMEOUT_HINT}.`);
    return undefined;
  }
  if (typeof raw !== "string") {
    ctx.err(path, `${label} must be a duration string. ${TIMEOUT_HINT}.`);
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value === "none") return null;
  const match = value.match(TIMEOUT_VALUE);
  if (!match) {
    ctx.err(path, `${label} has an invalid timeout "${raw}". ${TIMEOUT_HINT}.`);
    return undefined;
  }
  const n = Number.parseInt(match[1]!, 10);
  const unit = match[2] ?? "ms";
  const timeoutMs = unit === "m" ? n * 60_000 : unit === "s" ? n * 1_000 : n;
  if (timeoutMs <= 0) {
    ctx.err(path, `${label} has a non-positive timeout "${raw}". Use a positive duration or "none".`);
    return undefined;
  }
  return timeoutMs;
}

function parseEnumField(
  ctx: Ctx,
  raw: unknown,
  path: Path,
  label: string,
  allowed: readonly string[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && allowed.includes(raw)) return raw;
  ctx.err(path, `${label} must be one of: ${allowed.join(" | ")} (got ${JSON.stringify(raw)}).`);
  return undefined;
}

/** Parse only invocation tuning. Connection identity belongs to a named engine. */
function parseLlmOverrides(ctx: Ctx, raw: unknown, path: Path, label: string): LlmInvocationOverrides | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${label} must be a mapping of LLM invocation overrides.`);
    return undefined;
  }
  const keys = [
    "temperature",
    "max_tokens",
    "supports_json_schema",
    "extra_params",
    "context_length",
    "enable_thinking",
  ];
  checkUnknownKeys(ctx, raw, path, keys, label);
  const result: LlmInvocationOverrides = {};
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature === "number" && Number.isFinite(raw.temperature)) result.temperature = raw.temperature;
    else ctx.err([...path, "temperature"], `${label}.temperature must be a finite number.`);
  }
  if (raw.max_tokens !== undefined) {
    if (typeof raw.max_tokens === "number" && Number.isInteger(raw.max_tokens) && raw.max_tokens > 0) {
      result.maxTokens = raw.max_tokens;
    } else ctx.err([...path, "max_tokens"], `${label}.max_tokens must be a positive integer.`);
  }
  if (raw.supports_json_schema !== undefined) {
    if (typeof raw.supports_json_schema === "boolean") result.supportsJsonSchema = raw.supports_json_schema;
    else ctx.err([...path, "supports_json_schema"], `${label}.supports_json_schema must be a boolean.`);
  }
  if (raw.extra_params !== undefined) {
    if (!isPlainRecord(raw.extra_params)) {
      ctx.err([...path, "extra_params"], `${label}.extra_params must be a JSON object.`);
    } else {
      const issues = validateExtraParams(raw.extra_params);
      for (const issue of issues) {
        ctx.err([...path, "extra_params", ...issue.path], `${formatExtraParamsIssue(`${label}.extra_params`, issue)}.`);
      }
      if (jsonBytes(raw.extra_params) > WORKFLOW_MAX_EXTRA_PARAMS_BYTES) {
        ctx.err([...path, "extra_params"], `${label}.extra_params exceeds the 64 KiB resource limit.`);
      }
      if (issues.length === 0 && jsonBytes(raw.extra_params) <= WORKFLOW_MAX_EXTRA_PARAMS_BYTES) {
        result.extraParams = raw.extra_params;
      }
    }
  }
  if (raw.context_length !== undefined) {
    if (typeof raw.context_length === "number" && Number.isInteger(raw.context_length) && raw.context_length > 0) {
      result.contextLength = raw.context_length;
    } else ctx.err([...path, "context_length"], `${label}.context_length must be a positive integer.`);
  }
  if (raw.enable_thinking !== undefined) {
    if (typeof raw.enable_thinking === "boolean") result.enableThinking = raw.enable_thinking;
    else ctx.err([...path, "enable_thinking"], `${label}.enable_thinking must be a boolean.`);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseSchemaObject(ctx: Ctx, raw: unknown, path: Path, label: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${label} must be a JSON Schema object (e.g. { type: object, properties: { … } }).`);
    return undefined;
  }
  if (jsonBytes(raw) > WORKFLOW_MAX_SCHEMA_BYTES) {
    ctx.err(path, `${label} exceeds the 256 KiB resource limit.`);
  }
  return raw;
}

function checkUnknownKeys(
  ctx: Ctx,
  obj: Record<string, unknown>,
  path: Path,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      ctx.err([...path, key], `Unknown ${label} key "${key}". Allowed keys: ${allowed.join(", ")}.`);
    }
  }
}

/** Line of an AST node via its byte range; falls back to a path lookup. */
function rangedLine(ctx: Ctx, node: unknown, fallbackPath: Path): number {
  const range = (node as RangedNode | null | undefined)?.range;
  return range ? ctx.lineAtOffset(range[0]) : ctx.lineAt(fallbackPath);
}

// ---------------------------------------------------------------------------
// ${{ … }} syntactic pass
// ---------------------------------------------------------------------------

/**
 * Cheap syntactic pass over string fields. Two layers:
 *
 *   1. A local unterminated-`${{` check (unambiguously malformed regardless
 *      of grammar).
 *   2. The full closed-grammar check from ./expressions when that module is
 *      available (it is written by a parallel task — loaded defensively).
 *
 * Expression REFERENCES (unknown step, unknown param, type mismatch) are the
 * compiler/validator's job, not this parser's.
 */
function checkTemplates(ctx: Ctx, text: string, path: Path, label: string): void {
  let idx = 0;
  while (true) {
    const open = text.indexOf("${{", idx);
    if (open === -1) break;
    const close = text.indexOf("}}", open + 3);
    const nextOpen = text.indexOf("${{", open + 3);
    if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
      ctx.err(path, `${label} contains an unterminated "\${{" expression. Close it with "}}".`);
      return;
    }
    idx = close + 2;
  }

  const checker = loadExpressionChecker();
  if (checker) {
    const message = checker(text);
    if (message !== null) ctx.err(path, `${label}: ${message}`);
  }
  // TODO(R1): when ./expressions is absent (parallel task not landed yet)
  // only the unterminated check above runs; the compiler task enforces the
  // closed expression grammar fully.
}

type ExpressionChecker = (text: string) => string | null;

let cachedExpressionChecker: ExpressionChecker | null | undefined;

/** Test seam: force a re-probe of ./expressions (e.g. after mocking). */
export function resetExpressionCheckerForTests(): void {
  cachedExpressionChecker = undefined;
}

function loadExpressionChecker(): ExpressionChecker | null {
  if (cachedExpressionChecker !== undefined) return cachedExpressionChecker;
  cachedExpressionChecker = null;
  let candidate: ((text: string) => unknown) | undefined;
  try {
    const requireModule = createRequire(import.meta.url);
    // Non-literal specifier keeps tsc from resolving the module at compile
    // time — it may not exist yet (written by a parallel task).
    const specifier = "./expressions";
    const mod = requireModule(specifier) as Record<string, unknown>;
    candidate = [mod.parseTemplate, mod.compileTemplate, mod.parseTemplateString, mod.tokenizeTemplate].find(
      (fn): fn is (text: string) => unknown => typeof fn === "function",
    );
  } catch {
    return cachedExpressionChecker; // module not present — skip the pass
  }
  if (!candidate) return cachedExpressionChecker;
  const parseTemplate = candidate;
  cachedExpressionChecker = (text) => {
    try {
      const result = parseTemplate(text);
      if (isPlainRecord(result) && result.ok === false) {
        const errs = result.errors;
        if (Array.isArray(errs) && errs.length > 0) {
          const first: unknown = errs[0];
          if (typeof first === "string") return first;
          if (isPlainRecord(first) && typeof first.message === "string") return first.message;
        }
        if (typeof result.error === "string") return result.error;
        return `malformed \${{ … }} expression`;
      }
      return null;
    } catch {
      // A throw here is as likely an API-signature mismatch with the
      // parallel expressions task as a real template error — never turn it
      // into a false lint failure. The compiler task enforces the grammar.
      return null;
    }
  };
  return cachedExpressionChecker;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Strip the yaml package's multi-line code frame down to the first line. */
function yamlErrorMessage(message: string): string {
  const first = message.split("\n", 1)[0] ?? message;
  return first.replace(/ at line \d+, column \d+:?\s*$/, "").trim();
}
