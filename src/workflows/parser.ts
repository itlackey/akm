// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unified workflow markdown parser (workflow-format-unification).
 *
 * One frontmatter+body parser replaces the two prior format grammars: the
 * classic `# Workflow:` / `## Step:` markdown parser, and the YAML program's
 * field validator. Composition over invention: the frontmatter block is
 * parsed with the `yaml` package's `parseDocument` + `LineCounter` (best-effort
 * per-key line anchoring), the body's heading list with `parseMarkdownToc`
 * (already fence-aware) — both already in the codebase. The parser
 * accumulates `WorkflowError`s rather than throwing.
 *
 * Frontmatter carries the orchestration graph (params/defaults/budget/steps);
 * the body carries per-step prose, joined to the graph by step id. Body rules
 * (spec §2.2), exactly three:
 *
 *   1. Every level-2 heading must be `## <step-id>` for a DECLARED step,
 *      exactly (fenced code blocks are skipped when scanning for headings).
 *   2. A unit/map step MUST have a section (its instructions, byte-exact to
 *      the next H2 or EOF); a route step MAY. Everything before the first H2
 *      is free preamble.
 *   3. Inside a step section, an optional `### gate` sub-heading starts the
 *      step's gate rubric (to the section end) — the format's single
 *      reserved marker. Omitted or empty rubric text skips validation.
 *
 * Prose (instructions, gate rubrics, preamble) is NEVER templated or scanned
 * for reference syntax — it reaches the dispatched unit byte-exact. Only
 * three whole-value frontmatter positions carry the closed reference grammar
 * (`program/expressions.ts`): `map.over`, `route.input`, `inputs[]`.
 */

import { LineCounter, parseDocument } from "yaml";
import { parseFrontmatterBlock } from "../core/asset/frontmatter";
import { parseMarkdownToc } from "../core/asset/markdown";
import { isContainedRelativePath } from "../core/common";
import { formatExtraParamsIssue, validateExtraParams } from "../core/extra-params";
import { checkJsonSchemaDefinition, JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS } from "../core/json-schema";
import { parseReference } from "./program/expressions";
import {
  PROGRAM_ISOLATION_KINDS,
  PROGRAM_ON_ERROR,
  PROGRAM_PARAM_NAME_PATTERN,
  PROGRAM_REDUCERS,
  PROGRAM_RETRY_REASONS,
  PROGRAM_STEP_ID_PATTERN,
  type ProgramBudget,
  type ProgramDefaults,
  type ProgramExec,
  type ProgramGate,
  type ProgramIsolation,
  type ProgramMap,
  type ProgramOnError,
  type ProgramReducer,
  type ProgramRetry,
  type ProgramRoute,
  type ProgramStep,
  type ProgramUnit,
} from "./program/schema";
import {
  jsonBytes,
  utf8Bytes,
  WORKFLOW_ENGINE_NAME_PATTERN,
  WORKFLOW_ENV_VAR_NAME_PATTERN,
  WORKFLOW_MAX_CONCURRENCY,
  WORKFLOW_MAX_ENGINE_NAME_LENGTH,
  WORKFLOW_MAX_EXEC_ARG_BYTES,
  WORKFLOW_MAX_EXEC_ARGV,
  WORKFLOW_MAX_EXEC_CWD_LENGTH,
  WORKFLOW_MAX_EXEC_PASS_ENV,
  WORKFLOW_MAX_EXTRA_PARAMS_BYTES,
  WORKFLOW_MAX_GATE_LOOPS,
  WORKFLOW_MAX_INPUTS,
  WORKFLOW_MAX_MAP_EXPANSION,
  WORKFLOW_MAX_PARAMS,
  WORKFLOW_MAX_RETRIES,
  WORKFLOW_MAX_ROUTE_BRANCHES,
  WORKFLOW_MAX_SCHEMA_BYTES,
  WORKFLOW_MAX_SOURCE_BYTES,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_MAX_TIMEOUT_MS,
} from "./resource-limits";
import {
  type SourceRef,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDocument,
  type WorkflowError,
  type WorkflowInstructionBlock,
  type WorkflowParseResult,
  type WorkflowStep,
} from "./schema";
import { runSemanticChecks } from "./validator";

// LlmInvocationOverrides referenced via an inline `import("...")` TYPE QUERY,
// same rationale as program/schema.ts / program/parser.ts's identical query
// (this file is reached from `output/renderers.ts` via `workflows/renderer.ts`).
type LlmInvocationOverrides = import("../integrations/agent/engine-resolution").LlmInvocationOverrides;

/** Envelope keys every AKM markdown asset carries ($ref'd from schemas/akm-asset-envelope.json). */
const ENVELOPE_KEYS = [
  "type",
  "description",
  "tags",
  "when_to_use",
  "xrefs",
  "updated",
  "timestamp",
  "generated",
  "verified",
  "provenance",
  "status",
  "stale_after",
];
const WORKFLOW_KEYS = ["params", "defaults", "budget", "steps"];
const TOP_LEVEL_KEYS = [...ENVELOPE_KEYS, ...WORKFLOW_KEYS];
const DEFAULTS_KEYS = ["engine", "model", "timeout", "on_error", "llm"];
const BUDGET_KEYS = ["max_tokens", "max_units"];
const STEP_KEYS = ["id", "unit", "map", "route", "inputs", "output", "gate"];
const UNIT_KEYS = ["exec", "engine", "model", "llm", "timeout", "retry", "on_error", "output", "env", "isolation"];
const EXEC_KEYS = ["command", "cwd", "pass_env", "inherit_env"];
/** Unit keys that name an ENGINE dispatch and therefore cannot appear beside `exec:`. */
const UNIT_ENGINE_KEYS = ["engine", "model", "llm"] as const;
const MAP_KEYS = ["over", "concurrency", "reducer", "unit"];
const ROUTE_KEYS = ["input", "when", "default"];
const RETRY_KEYS = ["max", "on"];
const GATE_KEYS = ["max_loops"];
const ROUTE_BRANCH_KEYS = ["match", "step"];
const ACTOR_STAMP_KEYS = ["by", "at"];

const TIMEOUT_VALUE = /^(\d+)(ms|s|m)?$/;
const TIMEOUT_HINT = `Use "<n>ms", "<n>s", "<n>m" (e.g. "10m"), or "none"`;
const LIFECYCLE_STATUSES = new Set(["draft", "stable", "deprecated"]);

/**
 * Cheap structural probe retained ONLY for callers that still need a fast
 * "is this workflow-shaped" content check without touching the filesystem's
 * directory. Recognition itself no longer sniffs content (spec §2.5) — this
 * is a best-effort convenience for content-only contexts (e.g. a proposal
 * whose ref carries no path). It looks for `type: workflow` in frontmatter.
 */
export function looksLikeWorkflow(raw: string): boolean {
  const fmBlock = parseFrontmatterBlock(raw);
  if (!fmBlock) return false;
  return /^type:\s*['"]?workflow['"]?\s*(#.*)?$/m.test(fmBlock.frontmatter);
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
}

/** Route branch bookkeeping for the post-pass (targets need all step ids). */
interface RouteCheck {
  stepIndex: number;
  stepLabel: string;
  branches: Array<{ match: string; stepId: string; line: number }>;
  defaultTarget?: { stepId: string; line: number };
}

/**
 * Most parse diagnostics one `parseWorkflow` call reports. The resource limits
 * (`./resource-limits.ts`) bound the INPUT — 256 steps, 64 params, 1 MiB of
 * source — but nothing bounded the OUTPUT, so one badly-malformed large
 * workflow could emit hundreds of lines and bury the first real problem under
 * its own downstream fallout. Errors are sorted by line, so the FIRST ones are
 * the ones to fix first; anything past this cap is replaced by an explicit
 * trailer (see {@link capReportedErrors}) — truncation is never silent, and
 * never changes the fact that the document failed.
 */
export const WORKFLOW_MAX_REPORTED_ERRORS = 50;

/**
 * The reporting boundary for parse diagnostics: keep the first
 * {@link WORKFLOW_MAX_REPORTED_ERRORS} (already line-sorted) and append one
 * unmistakable trailer naming how many were dropped. `ok: false` is unaffected
 * — a capped list is still a failed parse.
 */
function capReportedErrors(errors: WorkflowError[]): WorkflowError[] {
  if (errors.length <= WORKFLOW_MAX_REPORTED_ERRORS) return errors;
  const kept = errors.slice(0, WORKFLOW_MAX_REPORTED_ERRORS);
  const hidden = errors.length - kept.length;
  const lastLine = kept[kept.length - 1]?.line ?? 1;
  kept.push({
    line: lastLine,
    message:
      `... ${hidden} more error${hidden === 1 ? "" : "s"} not shown (${errors.length} total; reporting is capped ` +
      `at ${WORKFLOW_MAX_REPORTED_ERRORS}). Fix the errors above and re-run to see the rest.`,
  });
  return kept;
}

export function parseWorkflow(markdown: string, source: { path: string }): WorkflowParseResult {
  if (utf8Bytes(markdown) > WORKFLOW_MAX_SOURCE_BYTES) {
    return {
      ok: false,
      errors: [{ line: 1, message: "Workflow source exceeds the 1 MiB resource limit." }],
    };
  }

  const errors: WorkflowError[] = [];
  const path = source.path;
  const lines = markdown.split(/\r?\n/);
  const totalLines = lines.length;

  const fmBlock = parseFrontmatterBlock(markdown);
  if (!fmBlock) {
    return {
      ok: false,
      errors: [
        {
          line: 1,
          message:
            `Workflow markdown must start with a YAML frontmatter block ("---" ... "---") declaring at least ` +
            `a non-empty "steps" list.`,
        },
      ],
    };
  }

  // The frontmatter substring always starts right after the opening "---"
  // line (exactly one line), so a yaml LineCounter position over just this
  // substring is always exactly one less than the real file line.
  const lineOffset = 1;
  const frontmatterEndLine = Math.max(1, fmBlock.bodyStartLine - 1);

  const lineCounter = new LineCounter();
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(fmBlock.frontmatter, { lineCounter });
  } catch (cause) {
    return {
      ok: false,
      errors: [{ line: 2, message: `Workflow frontmatter is not valid YAML: ${describeError(cause)}` }],
    };
  }
  for (const problem of doc.errors) {
    const offset = Array.isArray(problem.pos) ? problem.pos[0] : 0;
    errors.push({
      line: Math.max(1, lineCounter.linePos(offset).line + lineOffset),
      message: yamlErrorMessage(problem.message),
    });
  }
  if (errors.length > 0) return { ok: false, errors: capReportedErrors(errors) };

  let root: unknown;
  try {
    root = doc.toJS();
  } catch (cause) {
    return { ok: false, errors: [{ line: 2, message: `YAML expansion failed: ${describeError(cause)}` }] };
  }

  const lineAt = (p: Path): number => {
    for (let depth = p.length; depth >= 0; depth--) {
      const node = depth === 0 ? doc.contents : doc.getIn(p.slice(0, depth), true);
      const range = (node as RangedNode | null | undefined)?.range;
      if (range) return Math.max(1, lineCounter.linePos(range[0]).line + lineOffset);
    }
    return 2;
  };

  const ctx: Ctx = {
    filePath: path,
    errors,
    lineAt,
    lineAtOffset: (offset) => Math.max(1, lineCounter.linePos(offset).line + lineOffset),
    nodeAt: (p) => (p.length === 0 ? doc.contents : doc.getIn(p, true)),
    refAt: (p) => {
      for (let depth = p.length; depth >= 0; depth--) {
        const node = depth === 0 ? doc.contents : doc.getIn(p.slice(0, depth), true);
        const range = (node as RangedNode | null | undefined)?.range;
        if (range) {
          const start = Math.max(1, lineCounter.linePos(range[0]).line + lineOffset);
          const end = Math.max(start, lineCounter.linePos(Math.max(range[0], range[1] - 1)).line + lineOffset);
          return { path, start, end };
        }
      }
      return { path, start: frontmatterEndLine, end: frontmatterEndLine };
    },
    err: (p, message) => errors.push({ line: lineAt(p), message }),
    errAtLine: (line, message) => errors.push({ line, message }),
  };

  if (root === null || root === undefined) root = {};
  if (!isPlainRecord(root)) {
    return {
      ok: false,
      errors: [{ line: 2, message: `Workflow frontmatter must be a YAML mapping (key: value pairs).` }],
    };
  }

  checkUnknownKeys(ctx, root, [], TOP_LEVEL_KEYS, "workflow frontmatter");
  checkEnvelopeFields(ctx, root, frontmatterEndLine);

  const description = typeof root.description === "string" ? root.description : undefined;
  const tags = readTags(ctx, root.tags, frontmatterEndLine);
  const params = parseParams(ctx, root.params);
  const defaults = parseDefaults(ctx, root.defaults);
  const budget = parseBudget(ctx, root.budget);
  const parsedSteps = parseSteps(ctx, root.steps);

  // ── Body binding ────────────────────────────────────────────────────────
  const toc = parseMarkdownToc(markdown);
  const declaredIds = new Set(parsedSteps.map((s) => s.id));
  const { sections, preamble } = bindStepSections(
    toc.headings,
    lines,
    fmBlock.bodyStartLine,
    totalLines,
    path,
    declaredIds,
    errors,
  );

  const steps: WorkflowStep[] = parsedSteps.map((step, index) => {
    const section = sections.get(step.id);
    if (!section) {
      if (step.route === undefined) {
        errors.push({
          line: step.source.start,
          message: `Step "${step.id}" is a unit/map step and must have a "## ${step.id}" body section with its instructions.`,
        });
      }
    } else {
      if (step.route === undefined && !section.instructions) {
        errors.push({
          line: section.headingLine,
          message: `Step "${step.id}" section ("## ${step.id}") is empty. Add the step's instructions below the heading.`,
        });
      }
    }

    const gate: ProgramGate | undefined = step.gate ?? (section?.gateRubric ? {} : undefined);

    const out: WorkflowStep = {
      id: step.id,
      sequenceIndex: index,
      ...(step.unit ? { unit: step.unit } : {}),
      ...(step.map ? { map: step.map } : {}),
      ...(step.route ? { route: step.route } : {}),
      ...(step.inputs ? { inputs: step.inputs } : {}),
      ...(step.output !== undefined ? { output: step.output } : {}),
      ...(gate ? { gate } : {}),
      ...(section?.instructions ? { instructions: section.instructions } : {}),
      ...(section?.gateRubric ? { gateRubric: section.gateRubric } : {}),
      source: step.source,
    };
    return out;
  });

  const draft: WorkflowDocument = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    ...(description ? { description } : {}),
    ...(tags ? { tags } : {}),
    ...(params ? { params } : {}),
    ...(defaults ? { defaults } : {}),
    ...(budget ? { budget } : {}),
    steps,
    ...(preamble ? { preamble } : {}),
    source: { path, lineCount: totalLines },
  };

  runSemanticChecks(draft, root, frontmatterEndLine, errors);

  if (errors.length > 0) return { ok: false, errors: capReportedErrors(sortErrors(errors)) };
  return { ok: true, document: draft };
}

// ---------------------------------------------------------------------------
// Body binding
// ---------------------------------------------------------------------------

interface StepSection {
  headingLine: number;
  instructions?: WorkflowInstructionBlock;
  gateRubric?: WorkflowInstructionBlock;
}

function bindStepSections(
  headings: { level: number; text: string; line: number }[],
  lines: string[],
  bodyStartLine: number,
  totalLines: number,
  path: string,
  declaredIds: Set<string>,
  errors: WorkflowError[],
): { sections: Map<string, StepSection>; preamble?: string } {
  const sections = new Map<string, StepSection>();
  const h2s = headings.filter((h) => h.level === 2);
  const firstH2Line = h2s[0]?.line;
  const preambleRaw = firstH2Line
    ? sliceLines(lines, bodyStartLine, firstH2Line - 1).trim()
    : sliceLines(lines, bodyStartLine, totalLines).trim();

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!;
    if (h.level !== 2) continue;

    if (!declaredIds.has(h.text)) {
      errors.push({
        line: h.line,
        message: `Unexpected level-2 heading "## ${h.text}" on line ${h.line} — no step "${h.text}" is declared in frontmatter "steps:". Level-2 headings must exactly match a declared step id.`,
      });
      continue;
    }
    if (sections.has(h.text)) {
      errors.push({
        line: h.line,
        message: `Step "${h.text}" has more than one "## ${h.text}" section (first on line ${sections.get(h.text)!.headingLine}). Keep only one.`,
      });
      continue;
    }

    const sectionEnd = findNextHeadingAtOrAboveLevel(headings, i, 2, totalLines);
    const gate = findGateSubsection(headings, i, sectionEnd, path, h.text, errors);
    const instructionsEnd = gate ? gate.headingLine - 1 : sectionEnd;
    const instructionsText = sliceProseLines(lines, h.line + 1, instructionsEnd);

    const section: StepSection = { headingLine: h.line };
    if (instructionsText) {
      section.instructions = { text: instructionsText, source: { path, start: h.line + 1, end: instructionsEnd } };
    }
    if (gate) {
      const gateText = sliceProseLines(lines, gate.bodyStart, gate.bodyEnd);
      if (gateText) {
        section.gateRubric = { text: gateText, source: { path, start: gate.bodyStart, end: gate.bodyEnd } };
      }
    }
    sections.set(h.text, section);
  }

  return { sections, preamble: preambleRaw || undefined };
}

/** Find a step section's `### gate` sub-heading, if any — the format's single reserved marker. */
function findGateSubsection(
  headings: { level: number; text: string; line: number }[],
  stepHeadingIndex: number,
  sectionEnd: number,
  path: string,
  stepId: string,
  errors: WorkflowError[],
): { headingLine: number; bodyStart: number; bodyEnd: number } | undefined {
  let found: { headingLine: number; bodyStart: number; bodyEnd: number } | undefined;
  for (let j = stepHeadingIndex + 1; j < headings.length; j++) {
    const h = headings[j]!;
    if (h.line > sectionEnd) break;
    if (h.level <= 2) break; // next step / preamble heading — section already bounded here
    if (h.level !== 3 || h.text !== "gate") continue;
    if (found) {
      errors.push({
        line: h.line,
        message: `Step "${stepId}" has more than one "### gate" sub-heading (first on line ${found.headingLine}). Keep only one.`,
      });
      continue;
    }
    found = { headingLine: h.line, bodyStart: h.line + 1, bodyEnd: sectionEnd };
  }
  void path;
  return found;
}

function findNextHeadingAtOrAboveLevel(
  headings: { level: number; line: number }[],
  fromIndex: number,
  level: number,
  totalLines: number,
): number {
  for (let i = fromIndex + 1; i < headings.length; i++) {
    if (headings[i]!.level <= level) return headings[i]!.line - 1;
  }
  return totalLines;
}

function sliceLines(lines: string[], startLineInclusive: number, endLineInclusive: number): string {
  if (endLineInclusive < startLineInclusive) return "";
  const s = Math.max(1, startLineInclusive);
  const e = Math.min(endLineInclusive, lines.length);
  return lines.slice(s - 1, e).join("\n");
}

function sliceProseLines(lines: string[], startLineInclusive: number, endLineInclusive: number): string {
  let start = Math.max(1, startLineInclusive);
  let end = Math.min(endLineInclusive, lines.length);
  while (start <= end && /^\s*$/.test(lines[start - 1]!)) start++;
  while (end >= start && /^\s*$/.test(lines[end - 1]!)) end--;
  return sliceLines(lines, start, end);
}

// ---------------------------------------------------------------------------
// Envelope fields
// ---------------------------------------------------------------------------

function checkEnvelopeFields(ctx: Ctx, root: Record<string, unknown>, fmEndLine: number): void {
  if (root.type !== undefined && root.type !== "workflow") {
    ctx.err(["type"], `Workflow frontmatter "type" must be "workflow" (got ${JSON.stringify(root.type)}).`);
  }
  if (root.when_to_use !== undefined && typeof root.when_to_use !== "string") {
    ctx.err(["when_to_use"], `Workflow frontmatter "when_to_use" must be a string.`);
  }
  if (root.description !== undefined && typeof root.description !== "string") {
    ctx.err(["description"], `Workflow frontmatter "description" must be a string.`);
  }
  checkXrefs(ctx, root.xrefs, fmEndLine);
  if (root.updated !== undefined && typeof root.updated !== "string") {
    ctx.err(["updated"], `Workflow frontmatter "updated" must be a string.`);
  }
  if (root.timestamp !== undefined && typeof root.timestamp !== "string") {
    ctx.err(["timestamp"], `Workflow frontmatter "timestamp" must be a string.`);
  }
  checkActorStamp(ctx, root.generated, ["generated"], `"generated"`);
  if (root.verified !== undefined) {
    if (Array.isArray(root.verified)) {
      root.verified.forEach((entry, i) => {
        checkActorStamp(ctx, entry, ["verified", i], `"verified"`);
      });
    } else {
      checkActorStamp(ctx, root.verified, ["verified"], `"verified"`);
    }
  }
  if (root.provenance !== undefined && !isPlainRecord(root.provenance)) {
    ctx.err(["provenance"], `Workflow frontmatter "provenance" must be a mapping.`);
  }
  if (root.status !== undefined && (typeof root.status !== "string" || !LIFECYCLE_STATUSES.has(root.status))) {
    ctx.err(["status"], `Workflow frontmatter "status" must be one of: draft, stable, deprecated.`);
  }
  if (root.stale_after !== undefined && typeof root.stale_after !== "string") {
    ctx.err(["stale_after"], `Workflow frontmatter "stale_after" must be a string.`);
  }
}

function checkActorStamp(ctx: Ctx, value: unknown, path: Path, label: string): void {
  if (value === undefined) return;
  if (!isPlainRecord(value)) {
    ctx.err(path, `Workflow frontmatter ${label} must be a mapping with a non-empty "by".`);
    return;
  }
  checkUnknownKeys(ctx, value, path, ACTOR_STAMP_KEYS, `${label} actor stamp`);
  if (typeof value.by !== "string" || value.by.length === 0) {
    ctx.err([...path, "by"], `Workflow frontmatter ${label} must be a mapping with a non-empty "by".`);
  }
  if (value.at !== undefined && typeof value.at !== "string") {
    ctx.err([...path, "at"], `Workflow frontmatter ${label} actor stamp "at" must be a string.`);
  }
}

function readTags(ctx: Ctx, value: unknown, fmEndLine: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string" && tag.trim().length > 0)) {
    ctx.errAtLine(fmEndLine, `Workflow frontmatter "tags" must be an array of non-empty strings.`);
    return undefined;
  }
  return value.map((tag) => (tag as string).trim());
}

function checkXrefs(ctx: Ctx, value: unknown, fmEndLine: number): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((ref) => typeof ref === "string")) {
    ctx.errAtLine(fmEndLine, `Workflow frontmatter "xrefs" must be an array of canonical asset refs.`);
  }
}

// ---------------------------------------------------------------------------
// Top-level sections (frontmatter graph)
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
        `Param name "${paramName}" is invalid. Use letters, digits, and underscores, starting with a letter or underscore, so "params.${paramName}" can address it.`,
      );
      continue;
    }
    if (!isPlainRecord(value)) {
      ctx.err(["params", paramName], `Param "${paramName}" must be a JSON Schema object (e.g. { type: string }).`);
      continue;
    }
    if (jsonBytes(value) > WORKFLOW_MAX_SCHEMA_BYTES) {
      ctx.err(["params", paramName], `Param "${paramName}" schema exceeds the 256 KiB resource limit.`);
    }
    checkSchemaDefinition(ctx, value, ["params", paramName], `Param "${paramName}" schema`);
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
    const engine = parseEngineName(ctx, raw.engine, [...path, "engine"], `"defaults.engine"`);
    if (engine !== undefined) defaults.engine = engine;
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
      ctx.err(path, `Step ${index + 1} must be a mapping with an "id".`);
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
        `${label} has an invalid id "${rawStep.id}". A step id cannot be referenced from steps.${rawStep.id}.output ` +
          `unless it matches [A-Za-z_][A-Za-z0-9_-]* (a letter or underscore first, then letters, digits, ` +
          `underscores, or dashes; no dots, no leading digit).`,
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

    const declaredKinds = (["map", "route"] as const).filter((kind) => rawStep[kind] !== undefined);
    if (declaredKinds.length > 1) {
      ctx.err(path, `${label} must declare at most one of "map" or "route" (found ${declaredKinds.join(" + ")}).`);
    }
    const isRoute = rawStep.route !== undefined;
    const isMapStep = rawStep.map !== undefined;
    if (isRoute && rawStep.unit !== undefined) {
      ctx.err(path, `${label} is a route step and cannot also declare "unit" (route steps dispatch no unit).`);
    }
    if (isMapStep && rawStep.unit !== undefined) {
      ctx.err(
        path,
        `${label} is a map step; the per-item dispatch-override bag belongs at "map.unit", not top-level "unit".`,
      );
    }
    if (isRoute && rawStep.inputs !== undefined) {
      ctx.err(path, `${label} is a route step and cannot declare "inputs" (route steps dispatch no unit).`);
    }

    const unit =
      rawStep.unit !== undefined && !isRoute && !isMapStep
        ? parseUnit(ctx, rawStep.unit, [...path, "unit"], label)
        : undefined;
    const map = isMapStep ? parseMap(ctx, rawStep.map, [...path, "map"], label) : undefined;
    const route = isRoute ? parseRoute(ctx, rawStep.route, [...path, "route"], label, index, routeChecks) : undefined;
    const inputs = !isRoute ? parseInputs(ctx, rawStep.inputs, [...path, "inputs"], label) : undefined;

    const output = parseSchemaObject(ctx, rawStep.output, [...path, "output"], `${label} "output"`);
    const gate = rawStep.gate !== undefined ? parseGate(ctx, rawStep.gate, [...path, "gate"], label) : undefined;

    const step: ProgramStep = { id, source: ctx.refAt(path) };
    if (unit) step.unit = unit;
    if (map) step.map = map;
    if (route) step.route = route;
    if (inputs) step.inputs = inputs;
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
    ctx.err(path, `${stepLabel} "unit" must be a mapping (a dispatch-override bag).`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, UNIT_KEYS, `${stepLabel} "unit"`);

  const unit: ProgramUnit = { source: ctx.refAt(path) };

  if (raw.exec !== undefined) {
    const exec = parseExec(ctx, raw.exec, [...path, "exec"], stepLabel);
    if (exec !== undefined) unit.exec = exec;
    // An exec unit dispatches no engine call, so every engine-selection key is
    // a contradiction rather than a harmless extra. Reported per key so the
    // author sees exactly which line to delete.
    for (const key of UNIT_ENGINE_KEYS) {
      if (raw[key] === undefined) continue;
      ctx.err(
        [...path, key],
        `${stepLabel} "unit" declares both "exec" and "${key}". An exec unit runs a shell command and never ` +
          `reaches an engine, so "${key}" would have no effect — remove one of the two.`,
      );
    }
  }

  if (raw.engine !== undefined) {
    const engine = parseEngineName(ctx, raw.engine, [...path, "engine"], `${stepLabel} "engine"`);
    if (engine !== undefined) unit.engine = engine;
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

/**
 * Parse `unit.exec` — the argv-array shell-command surface.
 *
 * Deliberately NO shell-string spelling: the child is spawned directly from
 * this array, so shell metacharacters are inert literal bytes and the whole
 * quoting/injection class is structurally absent. An author who wants a
 * pipeline writes the interpreter explicitly (`["bash", "-lc", "…"]`), which
 * keeps that decision visible in the frontmatter diff.
 */
function parseExec(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): ProgramExec | undefined {
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${stepLabel} "exec" must be a mapping with a "command" argv list.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, EXEC_KEYS, `${stepLabel} "exec"`);

  const command = parseExecCommand(ctx, raw.command, [...path, "command"], stepLabel);
  if (command === undefined) return undefined;

  const exec: ProgramExec = { command };
  const cwd = parseExecCwd(ctx, raw.cwd, [...path, "cwd"], stepLabel);
  if (cwd !== undefined) exec.cwd = cwd;
  const passEnv = parseExecPassEnv(ctx, raw.pass_env, [...path, "pass_env"], stepLabel);
  if (passEnv !== undefined) exec.passEnv = passEnv;
  if (raw.inherit_env !== undefined) {
    if (typeof raw.inherit_env !== "boolean") {
      ctx.err(
        [...path, "inherit_env"],
        `${stepLabel} "exec.inherit_env" must be true or false. true gives the command akm's whole environment ` +
          `instead of the default allowlist; omit it (or write false) to keep the allowlist.`,
      );
    } else if (raw.inherit_env) {
      exec.inheritEnv = true;
    }
  }
  return exec;
}

/**
 * `pass_env:` — extra parent-process env var NAMES the child may see on top of
 * the default allowlist. NAMES ONLY: a value would be a plaintext secret in the
 * frozen plan, which is exactly what `env:` bindings exist to avoid.
 */
function parseExecPassEnv(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    ctx.err(
      path,
      `${stepLabel} "exec.pass_env" must be a non-empty list of environment variable NAMES to copy through from ` +
        `akm's own environment, e.g. pass_env: [CARGO_HOME]. Values never appear here — use "env:" bindings for those.`,
    );
    return undefined;
  }
  if (raw.length > WORKFLOW_MAX_EXEC_PASS_ENV) {
    ctx.err(
      path,
      `${stepLabel} "exec.pass_env" must have at most ${WORKFLOW_MAX_EXEC_PASS_ENV} entries. A command needing ` +
        `more than that wants "inherit_env: true", which says so explicitly.`,
    );
    return undefined;
  }
  const names: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || !WORKFLOW_ENV_VAR_NAME_PATTERN.test(entry)) {
      ctx.err(
        path,
        `${stepLabel} "exec.pass_env[${index}]" must be an environment variable name matching ` +
          `${WORKFLOW_ENV_VAR_NAME_PATTERN.source}.`,
      );
      return undefined;
    }
    if (names.includes(entry)) {
      ctx.err(path, `${stepLabel} "exec.pass_env" lists "${entry}" more than once.`);
      return undefined;
    }
    names.push(entry);
  }
  return names;
}

/** The argv array itself: 1..WORKFLOW_MAX_EXEC_ARGV bounded non-empty strings. */
function parseExecCommand(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    ctx.err(
      path,
      `${stepLabel} "exec" requires "command": a non-empty argv list, e.g. command: ["bun", "run", "test:unit"]. ` +
        `A single shell string is not accepted — the command is spawned directly, never through a shell.`,
    );
    return undefined;
  }
  if (raw.length > WORKFLOW_MAX_EXEC_ARGV) {
    ctx.err(path, `${stepLabel} "exec.command" must have at most ${WORKFLOW_MAX_EXEC_ARGV} entries.`);
    return undefined;
  }
  const argv: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || entry === "") {
      ctx.err(path, `${stepLabel} "exec.command[${index}]" must be a non-empty string.`);
      return undefined;
    }
    if (utf8Bytes(entry) > WORKFLOW_MAX_EXEC_ARG_BYTES) {
      ctx.err(path, `${stepLabel} "exec.command[${index}]" exceeds ${WORKFLOW_MAX_EXEC_ARG_BYTES} bytes.`);
      return undefined;
    }
    argv.push(entry);
  }
  return argv;
}

/**
 * The optional relative `cwd:`. Rejected here (statically) for absolute paths
 * and `..` segments; containment against the resolved base directory is
 * re-checked at dispatch, so a symlinked subdirectory cannot escape either.
 */
function parseExecCwd(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    ctx.err(path, `${stepLabel} "exec.cwd" must be a non-empty relative path inside the unit's working directory.`);
    return undefined;
  }
  const value = raw.trim();
  if (value.length > WORKFLOW_MAX_EXEC_CWD_LENGTH) {
    ctx.err(path, `${stepLabel} "exec.cwd" exceeds ${WORKFLOW_MAX_EXEC_CWD_LENGTH} characters.`);
    return undefined;
  }
  if (!isContainedRelativePath(value)) {
    ctx.err(
      path,
      `${stepLabel} "exec.cwd" (${JSON.stringify(value)}) must be a RELATIVE path inside the unit's working ` +
        `directory — absolute paths, Windows drive letters, "~", and ".." segments are rejected.`,
    );
    return undefined;
  }
  return value;
}

function parseMap(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): ProgramMap | undefined {
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${stepLabel} "map" must be a mapping with an "over" key.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, MAP_KEYS, `${stepLabel} "map"`);

  let over = "";
  if (typeof raw.over === "string" && raw.over.trim() !== "") {
    over = raw.over.trim();
    checkReferenceSyntax(ctx, over, [...path, "over"], `${stepLabel} "over"`);
  } else {
    ctx.err(
      [...path, "over"],
      `${stepLabel} "map" requires "over": a reference naming the item list (e.g. steps.discover.output.files).`,
    );
  }

  let concurrency: number | undefined;
  if (raw.concurrency !== undefined) {
    if (
      typeof raw.concurrency === "number" &&
      Number.isInteger(raw.concurrency) &&
      raw.concurrency > 0 &&
      raw.concurrency <= WORKFLOW_MAX_CONCURRENCY
    ) {
      concurrency = raw.concurrency;
    } else {
      ctx.err(
        [...path, "concurrency"],
        `${stepLabel} "concurrency" must be an integer from 1 through ${WORKFLOW_MAX_CONCURRENCY}.`,
      );
    }
  }

  const reducer = parseEnumField(ctx, raw.reducer, [...path, "reducer"], `${stepLabel} "reducer"`, PROGRAM_REDUCERS);
  const unit = raw.unit !== undefined ? parseUnit(ctx, raw.unit, [...path, "unit"], stepLabel) : undefined;

  const map: ProgramMap = { over };
  if (concurrency !== undefined) map.concurrency = concurrency;
  if (reducer !== undefined) map.reducer = reducer as ProgramReducer;
  if (unit !== undefined) map.unit = unit;
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
    checkReferenceSyntax(ctx, input, [...path, "input"], `${stepLabel} "route.input"`);
  } else {
    ctx.err([...path, "input"], `${stepLabel} "route" requires "input": a reference naming the value to route on.`);
  }

  const check: RouteCheck = { stepIndex, stepLabel, branches: [] };
  const whenPath: Path = [...path, "when"];

  if (!Array.isArray(raw.when) || raw.when.length === 0) {
    ctx.err(
      whenPath,
      `${stepLabel} "route" requires "when": a non-empty list of { match, step } branches (e.g. when: [{ match: pass, step: ship }]).`,
    );
  } else {
    if (raw.when.length > WORKFLOW_MAX_ROUTE_BRANCHES) {
      ctx.err(whenPath, `${stepLabel} "when" must contain at most ${WORKFLOW_MAX_ROUTE_BRANCHES} branches.`);
    }
    const seenMatches = new Map<string, number>();
    raw.when.forEach((branch: unknown, i: number) => {
      const branchPath: Path = [...whenPath, i];
      if (!isPlainRecord(branch)) {
        ctx.err(branchPath, `${stepLabel} "when[${i}]" must be a mapping: { match, step }.`);
        return;
      }
      checkUnknownKeys(ctx, branch, branchPath, ROUTE_BRANCH_KEYS, `${stepLabel} "when[${i}]"`);
      const matchLine = ctx.lineAt([...branchPath, "match"]);
      if (
        branch.match === undefined ||
        (typeof branch.match !== "string" && typeof branch.match !== "number" && typeof branch.match !== "boolean")
      ) {
        ctx.err([...branchPath, "match"], `${stepLabel} "when[${i}].match" must be a string, number, or boolean.`);
        return;
      }
      const match = String(branch.match);
      if (typeof branch.step !== "string" || branch.step.trim() === "") {
        ctx.err([...branchPath, "step"], `${stepLabel} "when[${i}].step" must be a step id string.`);
        return;
      }
      const stepId = branch.step.trim();
      const stepLine = ctx.lineAt([...branchPath, "step"]);
      const firstLine = seenMatches.get(match);
      if (firstLine !== undefined) {
        ctx.errAtLine(
          matchLine,
          `${stepLabel} has a duplicate "when" match "${match}" (first declared on line ${firstLine}). Matches must be unique.`,
        );
        return;
      }
      seenMatches.set(match, matchLine);
      check.branches.push({ match, stepId, line: stepLine });
    });
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

function parseInputs(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    ctx.err(path, `${stepLabel} "inputs" must be a non-empty list of reference strings.`);
    return undefined;
  }
  if (raw.length > WORKFLOW_MAX_INPUTS) {
    ctx.err(path, `${stepLabel} "inputs" must contain at most ${WORKFLOW_MAX_INPUTS} entries.`);
  }
  const out: string[] = [];
  raw.forEach((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      ctx.err([...path, i], `${stepLabel} "inputs[${i}]" must be a non-empty reference string.`);
      return;
    }
    const value = entry.trim();
    checkReferenceSyntax(ctx, value, [...path, i], `${stepLabel} "inputs[${i}]"`);
    out.push(value);
  });
  return out.length > 0 ? out : undefined;
}

function parseGate(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): ProgramGate | undefined {
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${stepLabel} "gate" must be a mapping with any of: ${GATE_KEYS.join(", ")}.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, GATE_KEYS, `${stepLabel} "gate"`);

  const gate: ProgramGate = {};
  if (raw.max_loops !== undefined) {
    if (
      typeof raw.max_loops === "number" &&
      Number.isInteger(raw.max_loops) &&
      raw.max_loops >= 1 &&
      raw.max_loops <= WORKFLOW_MAX_GATE_LOOPS
    ) {
      gate.maxLoops = raw.max_loops;
    } else {
      ctx.err(
        [...path, "max_loops"],
        `${stepLabel} "gate.max_loops" must be an integer from 1 through ${WORKFLOW_MAX_GATE_LOOPS}.`,
      );
    }
  }
  return gate;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/**
 * Engine names must already satisfy the frozen-plan grammar
 * (`WORKFLOW_ENGINE_NAME_PATTERN`, max 63 chars) at parse time — the decoder
 * enforces the same bound on persisted plans, and a name that only fails there
 * surfaces as an unlocated "Invalid frozen workflow plan" at `workflow run`.
 */
function parseEngineName(ctx: Ctx, raw: unknown, path: Path, label: string): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") {
    ctx.err(path, `${label} must be a non-empty engine name.`);
    return undefined;
  }
  const name = raw.trim();
  if (!WORKFLOW_ENGINE_NAME_PATTERN.test(name) || name.length > WORKFLOW_MAX_ENGINE_NAME_LENGTH) {
    ctx.err(
      path,
      `${label} has an invalid engine name ${JSON.stringify(name)}. Engine names are lowercase words of letters ` +
        `and digits separated by single dashes, starting with a letter (e.g. "code-review-llm"), at most ` +
        `${WORKFLOW_MAX_ENGINE_NAME_LENGTH} characters.`,
    );
    return undefined;
  }
  return name;
}

function parseRetry(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): ProgramRetry | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw)) {
    ctx.err(path, `${stepLabel} "retry" must be a mapping: { max: <n>, on: [<failure_reason>, …] }.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, RETRY_KEYS, `${stepLabel} "retry"`);

  let ok = true;
  if (!(typeof raw.max === "number" && Number.isInteger(raw.max) && raw.max >= 0 && raw.max <= WORKFLOW_MAX_RETRIES)) {
    ctx.err(
      [...path, "max"],
      `${stepLabel} "retry.max" is required and must be an integer from 0 through ${WORKFLOW_MAX_RETRIES}.`,
    );
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
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && raw > 0) return checkTimeoutCeiling(ctx, raw, path, label, String(raw));
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
  return checkTimeoutCeiling(ctx, timeoutMs, path, label, raw);
}

/**
 * Timeouts freeze into `IrInvocation.timeoutMs`, whose decoder bound is
 * `WORKFLOW_MAX_TIMEOUT_MS` (setTimeout's 32-bit signed ceiling). Enforce the
 * same ceiling here so an oversized duration fails with a line anchor instead
 * of an unlocated decode error at `workflow run`.
 */
function checkTimeoutCeiling(ctx: Ctx, timeoutMs: number, path: Path, label: string, raw: string): number | undefined {
  if (timeoutMs <= WORKFLOW_MAX_TIMEOUT_MS) return timeoutMs;
  ctx.err(
    path,
    `${label} has a timeout "${raw}" above the maximum of ${WORKFLOW_MAX_TIMEOUT_MS} ms (about 24.8 days). ` +
      `Use a shorter duration or "none" for no timeout.`,
  );
  return undefined;
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
  checkSchemaDefinition(ctx, raw, path, label);
  return raw;
}

/**
 * Validate an author-declared schema AS a schema (`output:` and `params`
 * declarations). The runtime enforces only a JSON Schema subset
 * (`core/json-schema.ts`); a typo'd `type` or a keyword the subset ignores
 * would silently constrain nothing at run time — a gate depending on a no-op
 * schema is worse than a loud failure here, so both are parse ERRORS.
 */
function checkSchemaDefinition(ctx: Ctx, schema: Record<string, unknown>, path: Path, label: string): void {
  for (const issue of checkJsonSchemaDefinition(schema)) {
    const issuePath = [...path, ...issue.path];
    if (issue.kind === "unsupported") {
      ctx.err(
        issuePath,
        `${label} (at ${issue.pointer}): ${issue.message}. Supported JSON Schema keywords: ` +
          `${JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS}.`,
      );
    } else {
      ctx.err(issuePath, `${label} is not a valid JSON Schema (at ${issue.pointer}): ${issue.message}.`);
    }
  }
}

function checkReferenceSyntax(ctx: Ctx, text: string, path: Path, label: string): void {
  const result = parseReference(text);
  if (!result.ok) ctx.err(path, `${label}: ${result.message}`);
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

function sortErrors(errors: WorkflowError[]): WorkflowError[] {
  return [...errors].sort((a, b) => a.line - b.line);
}
