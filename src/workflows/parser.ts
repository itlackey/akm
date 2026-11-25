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
 * accumulates `WorkflowError`s rather than throwing, and emits a compiled
 * {@link WorkflowPlan} directly (`plan.ts`).
 *
 * Frontmatter carries the orchestration graph (params/defaults/budget/steps);
 * the body carries per-step prose, joined to the graph by step id. Body rules
 *, exactly three:
 *
 *   1. Every level-2 heading must be `## <step-id>` for a DECLARED step,
 *      exactly (fenced code blocks are skipped when scanning for headings).
 *   2. A step MUST have a section (its instructions, byte-exact to
 *      the next H2 or EOF). Everything before the first H2
 *      is free preamble.
 *   3. Inside a step section, an optional `### gate` sub-heading starts the
 *      step's gate rubric (to the section end) — the format's single
 *      reserved marker. Omitted or empty rubric text skips validation.
 *
 * Prose (instructions, gate rubrics, preamble) is NEVER templated or scanned
 * for reference syntax — it reaches the dispatched unit byte-exact. Only
 * two whole-value frontmatter positions carry the closed reference grammar
 * (`program/expressions.ts`): `map.over`, `inputs[]`.
 */

import { LineCounter, parseDocument } from "yaml";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { parseFrontmatterBlock } from "../core/asset/frontmatter";
import { parseMarkdownToc } from "../core/asset/markdown";
import { isRecord, toErrorMessage } from "../core/common";
import { warnRetiredEngineKey } from "../execution/source";
import {
  type SourceRef,
  WORKFLOW_PLAN_VERSION,
  type WorkflowBudget,
  type WorkflowError,
  type WorkflowOnError,
  type WorkflowPlan,
  type WorkflowPlanStep,
  type WorkflowStepSpec,
} from "./plan";
import {
  jsonBytes,
  utf8Bytes,
  WORKFLOW_MAX_INSTRUCTION_BYTES,
  WORKFLOW_MAX_SCHEMA_BYTES,
  WORKFLOW_MAX_SOURCE_BYTES,
} from "./resource-limits";
import {
  type Ctx,
  checkSchemaDefinition,
  checkUnknownKeys,
  type Path,
  PROGRAM_ON_ERROR,
  PROGRAM_PARAM_NAME_PATTERN,
  PROGRAM_STEP_ID_PATTERN,
  type ProgramGate,
  type ProgramMap,
  type ProgramUnit,
  parseEngineName,
  parseEnumField,
  parseGate,
  parseInputs,
  parseLlmOverrides,
  parseMap,
  parseSchemaObject,
  parseTimeoutField,
  parseUnit,
  UNIT_KEYS,
} from "./step-fields";

/** A byte-exact slice of the markdown body, plus where it came from. */
interface WorkflowInstructionBlock {
  text: string;
  source: SourceRef;
}

export type WorkflowParseResult = { ok: true; plan: WorkflowPlan } | { ok: false; errors: WorkflowError[] };

type ProgramDefaults = NonNullable<WorkflowPlan["defaults"]>;
interface ProgramStep {
  id: string;
  unit?: ProgramUnit;
  map?: ProgramMap;
  inputs?: string[];
  output?: Record<string, unknown>;
  gate?: ProgramGate;
  source: SourceRef;
}

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
const DEFAULTS_KEYS = ["connection", "harness", "engine", "model", "timeout", "on_error", "llm"];
const BUDGET_KEYS = ["max_tokens", "max_units"];
const STEP_KEYS = ["id", "unit", "map", "inputs", "output", "gate"];
const ACTOR_STAMP_KEYS = ["by", "at"];

const LIFECYCLE_STATUSES = new Set(["draft", "stable", "deprecated"]);

/** Yaml AST node surface we rely on for line anchoring (best-effort). */
interface RangedNode {
  range?: [number, number, number] | null;
}

export interface WorkflowParseOptions {
  path: string;
  /** Plan title; defaults to the file's basename. */
  title?: string;
}

export function parseWorkflow(markdown: string, source: WorkflowParseOptions): WorkflowParseResult {
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
  const lineOf = (offset: number) => Math.max(1, lineCounter.linePos(offset).line + lineOffset);
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(fmBlock.frontmatter, { lineCounter });
  } catch (cause) {
    return {
      ok: false,
      errors: [{ line: 2, message: `Workflow frontmatter is not valid YAML: ${toErrorMessage(cause)}` }],
    };
  }
  for (const problem of doc.errors) {
    const offset = Array.isArray(problem.pos) ? problem.pos[0] : 0;
    errors.push({
      line: lineOf(offset),
      message: yamlErrorMessage(problem.message),
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  let root: unknown;
  try {
    root = doc.toJS();
  } catch (cause) {
    return { ok: false, errors: [{ line: 2, message: `YAML expansion failed: ${toErrorMessage(cause)}` }] };
  }

  // The nearest ancestor of `p` the YAML AST has a range for (best-effort anchoring).
  const rangeAt = (p: Path) => {
    for (let depth = p.length; depth >= 0; depth--) {
      const node = depth === 0 ? doc.contents : doc.getIn(p.slice(0, depth), true);
      const range = (node as RangedNode | null | undefined)?.range;
      if (range) return range;
    }
    return undefined;
  };

  const ctx: Ctx = {
    refAt: (p) => {
      const range = rangeAt(p);
      if (!range) return { path, start: frontmatterEndLine, end: frontmatterEndLine };
      const start = lineOf(range[0]);
      return { path, start, end: Math.max(start, lineOf(Math.max(range[0], range[1] - 1))) };
    },
    err: (p, message) => {
      const range = rangeAt(p);
      errors.push({ line: range ? lineOf(range[0]) : 2, message });
    },
    errAtLine: (line, message) => errors.push({ line, message }),
  };

  if (root === null || root === undefined) root = {};
  if (!isRecord(root)) {
    return {
      ok: false,
      errors: [{ line: 2, message: `Workflow frontmatter must be a YAML mapping (key: value pairs).` }],
    };
  }

  checkUnknownKeys(ctx, root, [], TOP_LEVEL_KEYS, "workflow frontmatter");
  checkEnvelopeFields(ctx, root, frontmatterEndLine);

  const description = typeof root.description === "string" ? root.description : undefined;
  const whenToUse = typeof root.when_to_use === "string" ? root.when_to_use : undefined;
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

  const steps = parsedSteps.map((step, index): WorkflowPlanStep => {
    const section = sections.get(step.id);
    if (!section) {
      errors.push({
        line: step.source.start,
        message: `Step "${step.id}" must have a "## ${step.id}" body section with its instructions.`,
      });
    } else if (!section.instructions) {
      errors.push({
        line: section.headingLine,
        message: `Step "${step.id}" section ("## ${step.id}") is empty. Add the step's instructions below the heading.`,
      });
    }
    for (const [block, what] of [
      [section?.instructions, "instructions exceed"],
      [section?.gateRubric, "gate rubric exceeds"],
    ] as const) {
      if (block && utf8Bytes(block.text) > WORKFLOW_MAX_INSTRUCTION_BYTES) {
        errors.push({ line: block.source.start, message: `Step "${step.id}" ${what} the 256 KiB resource limit.` });
      }
    }
    const rubric = section?.gateRubric?.text;
    return {
      stepId: step.id,
      title: step.id,
      sequenceIndex: index,
      spec: stepSpec(step, section),
      ...(step.output !== undefined ? { outputSchema: step.output } : {}),
      gate: {
        kind: "gate",
        id: `${step.id}.gate`,
        stepId: step.id,
        criteria: rubric?.trim() ? [rubric] : [],
        maxLoops: step.gate?.maxLoops ?? 1,
        frozenJudge: null,
      },
    };
  });
  checkCanonicalXrefs(root.xrefs, frontmatterEndLine, errors);
  if (errors.length > 0) return { ok: false, errors: sortErrors(errors) };

  const paramNames = params ? Object.keys(params) : [];
  const plan: WorkflowPlan = {
    irVersion: WORKFLOW_PLAN_VERSION,
    title: source.title ?? path.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, ""),
    ...(params && paramNames.length > 0 ? { params: paramNames, paramSchemas: params } : {}),
    ...(budget ? { budget } : {}),
    ...(defaults ? { defaults } : {}),
    ...(description ? { description } : {}),
    ...(whenToUse ? { whenToUse } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(preamble ? { preamble } : {}),
    steps,
  };
  return { ok: true, plan };
}

/** The authored step as the plan carries it. A prose step is inline `akm/command` literal content. */
function stepSpec(step: ProgramStep, section: StepSection | undefined): WorkflowStepSpec {
  const prose = section?.instructions?.text;
  const dispatchUnit = step.map?.unit ?? step.unit;
  const { exec, workflow, with: childWith, source: _unitSource, ...unit } = dispatchUnit ?? { source: step.source };
  return {
    ...(workflow
      ? {
          workflow,
          ...(childWith ? { with: childWith } : {}),
          ...(prose?.trim() ? { instructions: prose } : {}),
        }
      : exec
        ? { exec: { ...exec }, ...(prose?.trim() ? { instructions: prose } : {}) }
        : { uses: "akm/command", with: { content: prose ?? "" } }),
    ...(Object.keys(unit).length > 0 ? { unit } : {}),
    ...(step.map
      ? {
          map: {
            over: step.map.over,
            ...(step.map.concurrency !== undefined ? { concurrency: step.map.concurrency } : {}),
            ...(step.map.reducer !== undefined ? { reducer: step.map.reducer } : {}),
          },
        }
      : {}),
    ...(step.inputs ? { inputs: [...step.inputs] } : {}),
    source: step.source,
  };
}

/** `xrefs` entries must be canonical asset refs. */
function checkCanonicalXrefs(value: unknown, line: number, errors: WorkflowError[]): void {
  if (!Array.isArray(value)) return; // shape already flagged by checkXrefs
  for (const ref of value) {
    try {
      if (typeof ref !== "string") throw new Error("non-canonical ref");
      const parsed = parseBundleRef(ref);
      if (parsed.conceptId.includes(":") || ref !== bundleRefToString(parsed)) throw new Error("non-canonical ref");
    } catch {
      errors.push({
        line,
        message: `Workflow frontmatter "xrefs" contains an invalid or non-canonical ref: ${String(ref)}.`,
      });
    }
  }
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
        message: `Unexpected level-2 heading "## ${h.text}" on line ${h.line} — no step "${h.text}" is declared in frontmatter "steps:". Level-2 headings must exactly match a declared step id. To document something that is not a step, use a level-3 heading.`,
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
    const gate = findGateSubsection(headings, i, sectionEnd, h.text, errors);
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
  const checkString = (key: string) => {
    if (root[key] !== undefined && typeof root[key] !== "string")
      ctx.err([key], `Workflow frontmatter "${key}" must be a string.`);
  };
  checkString("when_to_use");
  checkString("description");
  checkXrefs(ctx, root.xrefs, fmEndLine);
  checkString("updated");
  checkString("timestamp");
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
  if (root.provenance !== undefined && !isRecord(root.provenance)) {
    ctx.err(["provenance"], `Workflow frontmatter "provenance" must be a mapping.`);
  }
  if (root.status !== undefined && (typeof root.status !== "string" || !LIFECYCLE_STATUSES.has(root.status))) {
    ctx.err(["status"], `Workflow frontmatter "status" must be one of: draft, stable, deprecated.`);
  }
  checkString("stale_after");
}

function checkActorStamp(ctx: Ctx, value: unknown, path: Path, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
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
  if (!isRecord(raw)) {
    ctx.err(
      ["params"],
      `"params" must be a mapping of param name to a JSON Schema object (e.g. changed_files: { type: array }).`,
    );
    return undefined;
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
    if (!isRecord(value)) {
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
  if (!isRecord(raw)) {
    ctx.err(path, `"defaults" must be a mapping with any of: ${DEFAULTS_KEYS.join(", ")}.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, DEFAULTS_KEYS, `"defaults"`);
  const defaults: ProgramDefaults = {};
  for (const key of ["connection", "harness", "engine"] as const) {
    if (raw[key] === undefined) continue;
    const name = parseEngineName(ctx, raw[key], [...path, key], `"defaults.${key}"`);
    if (name !== undefined) defaults[key] = name;
    if (key === "engine") warnRetiredEngineKey();
  }
  if (raw.model !== undefined) {
    if (typeof raw.model === "string" && raw.model.trim() !== "") defaults.model = raw.model.trim();
    else ctx.err([...path, "model"], `"defaults.model" must be a non-empty string (a model alias or exact id).`);
  }
  const timeoutMs = parseTimeoutField(ctx, raw.timeout, [...path, "timeout"], `"defaults.timeout"`);
  if (timeoutMs !== undefined) defaults.timeoutMs = timeoutMs;
  const onError = parseEnumField(ctx, raw.on_error, [...path, "on_error"], `"defaults.on_error"`, PROGRAM_ON_ERROR);
  if (onError !== undefined) defaults.onError = onError as WorkflowOnError;
  const llm = parseLlmOverrides(ctx, raw.llm, [...path, "llm"], `"defaults.llm"`);
  if (llm !== undefined) defaults.llm = llm;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function parseBudget(ctx: Ctx, raw: unknown): WorkflowBudget | undefined {
  if (raw === undefined) return undefined;
  const path: Path = ["budget"];
  if (!isRecord(raw)) {
    ctx.err(path, `"budget" must be a mapping with any of: ${BUDGET_KEYS.join(", ")}.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, BUDGET_KEYS, `"budget"`);
  const budget: WorkflowBudget = {};
  for (const [key, field] of [
    ["max_tokens", "maxTokens"],
    ["max_units", "maxUnits"],
  ] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) budget[field] = value;
    else ctx.err([...path, key], `"budget.${key}" must be an integer >= 1.`);
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function parseSteps(ctx: Ctx, raw: unknown): ProgramStep[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    ctx.err(["steps"], `"steps" is required and must be a list with at least one step.`);
    return [];
  }

  const steps: ProgramStep[] = [];
  const seenIds = new Map<string, number>();

  raw.forEach((rawStep, index) => {
    const path: Path = ["steps", index];
    if (!isRecord(rawStep)) {
      ctx.err(path, `Step ${index + 1} must be a mapping with an "id".`);
      return;
    }
    const label = typeof rawStep.id === "string" && rawStep.id !== "" ? `Step "${rawStep.id}"` : `Step ${index + 1}`;
    const isMapStep = rawStep.map !== undefined;
    const unitKeyHome = isMapStep ? "map.unit:" : "unit:";
    checkUnknownKeys(ctx, rawStep, path, STEP_KEYS, label, (key) =>
      UNIT_KEYS.includes(key) ? ` (this belongs under "${unitKeyHome}")` : "",
    );

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

    if (isMapStep && rawStep.unit !== undefined) {
      ctx.err(
        path,
        `${label} is a map step; the per-item dispatch-override bag belongs at "map.unit", not top-level "unit".`,
      );
    }

    const unit =
      rawStep.unit !== undefined && !isMapStep ? parseUnit(ctx, rawStep.unit, [...path, "unit"], label) : undefined;
    const map = isMapStep ? parseMap(ctx, rawStep.map, [...path, "map"], label) : undefined;
    const inputs = parseInputs(ctx, rawStep.inputs, [...path, "inputs"], label);

    const output = parseSchemaObject(ctx, rawStep.output, [...path, "output"], `${label} "output"`);
    const gate = rawStep.gate !== undefined ? parseGate(ctx, rawStep.gate, [...path, "gate"], label) : undefined;

    const step: ProgramStep = { id, source: ctx.refAt(path) };
    if (unit) step.unit = unit;
    // A solo step's `output` is also its unit's contract. Only `unit.output`
    // makes the dispatch ask for, parse and re-request JSON, so without this a
    // step-level schema met a raw text reply and could never pass. A map
    // step's `output` describes the collected/reduced value, and a child
    // workflow unit's result is the child's own, so both keep the step-only meaning.
    if (output !== undefined && !isMapStep && unit?.output === undefined && unit?.workflow === undefined) {
      step.unit = { ...(unit ?? { source: step.source }), output };
    }
    if (map) step.map = map;
    if (inputs) step.inputs = inputs;
    if (output !== undefined) step.output = output;
    if (gate !== undefined) step.gate = gate;
    steps.push(step);
  });

  return steps;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Strip the yaml package's multi-line code frame down to the first line. */
function yamlErrorMessage(message: string): string {
  const first = message.split("\n", 1)[0] ?? message;
  return first.replace(/ at line \d+, column \d+:?\s*$/, "").trim();
}

function sortErrors(errors: WorkflowError[]): WorkflowError[] {
  return [...errors].sort((a, b) => a.line - b.line);
}
