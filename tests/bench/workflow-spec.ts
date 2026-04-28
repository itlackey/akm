/**
 * Declarative workflow specs for AKM compliance checks.
 *
 * Specs are authored as YAML in `tests/fixtures/bench/workflows/*.yaml` and
 * describe expected agent behaviour over the normalized event stream from
 * `workflow-trace.ts` (issue #254). This module owns:
 *
 *   - `WorkflowSpec` type
 *   - `loadWorkflowSpec(path, root?)` — parses + validates one file
 *   - `loadAllWorkflowSpecs(dir)` — walks a workflows directory
 *
 * Event names are validated against a HARDCODED set in this file. Once
 * #254 lands, #256 will reconcile by importing the source-of-truth set
 * from `workflow-trace.ts`. Until then this set is the contract.
 *
 * Asset refs (e.g. `gold_ref`) are validated via `parseAssetRef` from
 * `src/core/asset-ref.ts` — never reinvent ref validation.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { parseAssetRef } from "../../src/core/asset-ref";

// ── Event-name set (hardcoded; reconcile with #254 in wave 3) ──────────────

/**
 * Hardcoded event-name allowlist. Mirrors the WorkflowTraceEvent.kind set
 * specified in the #254 brief.
 *
 * `first_workspace_write` is a synthetic marker (the first `workspace_write`
 * for a run) and is included so specs can talk about it directly.
 */
export const KNOWN_EVENT_NAMES = Object.freeze([
  "agent_started",
  "akm_search",
  "akm_show",
  "akm_feedback",
  "akm_reflect",
  "akm_distill",
  "akm_propose",
  "akm_proposal_accept",
  "workspace_read",
  "workspace_write",
  "test_run",
  "verifier_run",
  "agent_finished",
  "first_workspace_write",
] as const);

export type WorkflowEventName = (typeof KNOWN_EVENT_NAMES)[number];

const EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(KNOWN_EVENT_NAMES);

function isKnownEvent(name: unknown): name is WorkflowEventName {
  return typeof name === "string" && EVENT_NAME_SET.has(name);
}

// ── Spec types ─────────────────────────────────────────────────────────────

export interface WorkflowAppliesTo {
  /** Arms this spec applies to, e.g. ["akm"]. Empty/undefined = any arm. */
  arms?: string[];
  /** Task-id domain prefixes (split on '/'), e.g. ["docker-homelab"]. */
  task_domains?: string[];
  /** Outcomes filter, e.g. ["pass"] or ["fail"]. */
  outcomes?: string[];
  /** Spec only applies when task has a gold_ref declared. */
  requires_gold_ref?: boolean;
  /** Threshold for repeated-failure specs. */
  min_repeated_failures?: number;
}

export interface WorkflowSequenceStep {
  event: WorkflowEventName;
  /** Must occur before this other event. */
  before?: WorkflowEventName;
  /** Must occur after this other event. */
  after?: WorkflowEventName;
  /** Step is only required when this condition is true at run time. */
  required_if?: string;
  /** Required minimum count of this event. */
  min_count?: number;
  /** For akm_feedback steps: required polarity ("positive" | "negative"). */
  polarity?: "positive" | "negative";
  /** For akm_show steps: ref must equal this field's value, e.g. "gold_ref". */
  ref_must_equal?: string;
}

export interface WorkflowForbiddenStep {
  event: WorkflowEventName;
  /** Forbidden when it occurs before this other event. */
  before?: WorkflowEventName;
  /** Forbidden when it occurs after this other event. */
  after?: WorkflowEventName;
  /** For akm_feedback: forbid this polarity. */
  polarity?: "positive" | "negative";
}

export interface WorkflowScoring {
  required_steps_weight: number;
  forbidden_steps_weight: number;
  evidence_quality_weight: number;
}

export interface WorkflowSpec {
  id: string;
  title: string;
  description?: string;
  applies_to?: WorkflowAppliesTo;
  /** Optional asset ref (validated via parseAssetRef). */
  gold_ref?: string;
  required_sequence: WorkflowSequenceStep[];
  forbidden?: WorkflowForbiddenStep[];
  scoring: WorkflowScoring;
  /** Absolute path the spec was loaded from. */
  sourcePath: string;
}

// ── Errors ─────────────────────────────────────────────────────────────────

export class WorkflowSpecError extends Error {
  readonly code = "WORKFLOW_SPEC_INVALID" as const;
  constructor(
    message: string,
    readonly specPath: string,
  ) {
    super(`${message} (in ${specPath})`);
    this.name = "WorkflowSpecError";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, specPath: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new WorkflowSpecError(`Missing or non-string field "${key}"`, specPath);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string, specPath: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new WorkflowSpecError(`Field "${key}" must be a string`, specPath);
  }
  return v;
}

function optionalStringArray(obj: Record<string, unknown>, key: string, specPath: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new WorkflowSpecError(`Field "${key}" must be a string[]`, specPath);
  }
  return v as string[];
}

function requireNumber(obj: Record<string, unknown>, key: string, specPath: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new WorkflowSpecError(`Missing or non-numeric field "${key}"`, specPath);
  }
  return v;
}

function validateEventName(name: unknown, specPath: string, where: string): WorkflowEventName {
  if (!isKnownEvent(name)) {
    throw new WorkflowSpecError(
      `Unknown event name "${String(name)}" in ${where}. ` + `Allowed: ${KNOWN_EVENT_NAMES.join(", ")}`,
      specPath,
    );
  }
  return name;
}

function validatePolarity(value: unknown, specPath: string, where: string): "positive" | "negative" {
  if (value !== "positive" && value !== "negative") {
    throw new WorkflowSpecError(`Field "polarity" in ${where} must be "positive" or "negative"`, specPath);
  }
  return value;
}

function parseAppliesTo(raw: unknown, specPath: string): WorkflowAppliesTo | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new WorkflowSpecError('Field "applies_to" must be an object', specPath);
  }
  const out: WorkflowAppliesTo = {};
  const arms = optionalStringArray(raw, "arms", specPath);
  if (arms) out.arms = arms;
  const domains = optionalStringArray(raw, "task_domains", specPath);
  if (domains) out.task_domains = domains;
  const outcomes = optionalStringArray(raw, "outcomes", specPath);
  if (outcomes) out.outcomes = outcomes;
  if (raw.requires_gold_ref !== undefined) {
    if (typeof raw.requires_gold_ref !== "boolean") {
      throw new WorkflowSpecError('Field "applies_to.requires_gold_ref" must be a boolean', specPath);
    }
    out.requires_gold_ref = raw.requires_gold_ref;
  }
  if (raw.min_repeated_failures !== undefined) {
    if (typeof raw.min_repeated_failures !== "number" || !Number.isFinite(raw.min_repeated_failures)) {
      throw new WorkflowSpecError('Field "applies_to.min_repeated_failures" must be a number', specPath);
    }
    out.min_repeated_failures = raw.min_repeated_failures;
  }
  return out;
}

function parseSequenceStep(raw: unknown, specPath: string, index: number): WorkflowSequenceStep {
  if (!isPlainObject(raw)) {
    throw new WorkflowSpecError(`required_sequence[${index}] must be an object`, specPath);
  }
  const where = `required_sequence[${index}]`;
  const event = validateEventName(raw.event, specPath, where);
  const step: WorkflowSequenceStep = { event };
  if (raw.before !== undefined) {
    step.before = validateEventName(raw.before, specPath, `${where}.before`);
  }
  if (raw.after !== undefined) {
    step.after = validateEventName(raw.after, specPath, `${where}.after`);
  }
  if (raw.required_if !== undefined) {
    if (typeof raw.required_if !== "string" || raw.required_if.length === 0) {
      throw new WorkflowSpecError(`${where}.required_if must be a non-empty string`, specPath);
    }
    step.required_if = raw.required_if;
  }
  if (raw.min_count !== undefined) {
    if (typeof raw.min_count !== "number" || !Number.isFinite(raw.min_count) || raw.min_count < 1) {
      throw new WorkflowSpecError(`${where}.min_count must be a positive number`, specPath);
    }
    step.min_count = raw.min_count;
  }
  if (raw.polarity !== undefined) {
    step.polarity = validatePolarity(raw.polarity, specPath, where);
  }
  if (raw.ref_must_equal !== undefined) {
    if (typeof raw.ref_must_equal !== "string" || raw.ref_must_equal.length === 0) {
      throw new WorkflowSpecError(`${where}.ref_must_equal must be a non-empty string`, specPath);
    }
    step.ref_must_equal = raw.ref_must_equal;
  }
  return step;
}

function parseForbiddenStep(raw: unknown, specPath: string, index: number): WorkflowForbiddenStep {
  if (!isPlainObject(raw)) {
    throw new WorkflowSpecError(`forbidden[${index}] must be an object`, specPath);
  }
  const where = `forbidden[${index}]`;
  const step: WorkflowForbiddenStep = {
    event: validateEventName(raw.event, specPath, where),
  };
  if (raw.before !== undefined) {
    step.before = validateEventName(raw.before, specPath, `${where}.before`);
  }
  if (raw.after !== undefined) {
    step.after = validateEventName(raw.after, specPath, `${where}.after`);
  }
  if (raw.polarity !== undefined) {
    step.polarity = validatePolarity(raw.polarity, specPath, where);
  }
  return step;
}

function parseScoring(raw: unknown, specPath: string): WorkflowScoring {
  if (!isPlainObject(raw)) {
    throw new WorkflowSpecError('Field "scoring" must be an object', specPath);
  }
  const required_steps_weight = requireNumber(raw, "required_steps_weight", specPath);
  const forbidden_steps_weight = requireNumber(raw, "forbidden_steps_weight", specPath);
  const evidence_quality_weight = requireNumber(raw, "evidence_quality_weight", specPath);
  for (const [key, val] of Object.entries({
    required_steps_weight,
    forbidden_steps_weight,
    evidence_quality_weight,
  })) {
    if (val < 0 || val > 1) {
      throw new WorkflowSpecError(`scoring.${key} must be in [0, 1] (got ${val})`, specPath);
    }
  }
  const sum = required_steps_weight + forbidden_steps_weight + evidence_quality_weight;
  if (Math.abs(sum - 1) > 1e-6) {
    throw new WorkflowSpecError(`scoring weights must sum to 1.0 (got ${sum})`, specPath);
  }
  return { required_steps_weight, forbidden_steps_weight, evidence_quality_weight };
}

// ── Loader ─────────────────────────────────────────────────────────────────

const MAX_SPEC_BYTES = 1 << 20; // 1 MiB — workflow specs are small.

/**
 * Load and validate a single workflow spec from a YAML file.
 *
 * If `root` is provided, the resolved absolute path of `specPath` MUST be
 * contained within `root` (path-traversal guard). Resolution uses
 * `path.resolve` + a `path.relative` containment check.
 */
export function loadWorkflowSpec(specPath: string, root?: string): WorkflowSpec {
  const absSpec = path.resolve(specPath);

  if (root !== undefined) {
    const absRoot = path.resolve(root);
    const rel = path.relative(absRoot, absSpec);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || rel.length === 0 || path.isAbsolute(rel)) {
      throw new WorkflowSpecError(`Spec path resolves outside workflows root "${absRoot}"`, absSpec);
    }
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absSpec);
  } catch (err) {
    throw new WorkflowSpecError(`Cannot stat spec file: ${(err as Error).message}`, absSpec);
  }
  if (!stat.isFile()) {
    throw new WorkflowSpecError("Spec path is not a regular file", absSpec);
  }
  if (stat.size > MAX_SPEC_BYTES) {
    throw new WorkflowSpecError(`Spec file too large (${stat.size} > ${MAX_SPEC_BYTES} bytes)`, absSpec);
  }

  const text = readFileSync(absSpec, "utf8");
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new WorkflowSpecError(`YAML parse error: ${(err as Error).message}`, absSpec);
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowSpecError("Top-level YAML must be a mapping", absSpec);
  }

  const id = requireString(raw, "id", absSpec);
  const title = requireString(raw, "title", absSpec);
  const description = optionalString(raw, "description", absSpec);
  const applies_to = parseAppliesTo(raw.applies_to, absSpec);

  const goldRefRaw = optionalString(raw, "gold_ref", absSpec);
  if (goldRefRaw !== undefined) {
    try {
      parseAssetRef(goldRefRaw);
    } catch (err) {
      throw new WorkflowSpecError(
        `gold_ref "${goldRefRaw}" is not a valid asset ref: ${(err as Error).message}`,
        absSpec,
      );
    }
  }

  if (!Array.isArray(raw.required_sequence) || raw.required_sequence.length === 0) {
    throw new WorkflowSpecError("required_sequence must be a non-empty array", absSpec);
  }
  const required_sequence = raw.required_sequence.map((step, i) => parseSequenceStep(step, absSpec, i));

  let forbidden: WorkflowForbiddenStep[] | undefined;
  if (raw.forbidden !== undefined && raw.forbidden !== null) {
    if (!Array.isArray(raw.forbidden)) {
      throw new WorkflowSpecError("forbidden must be an array", absSpec);
    }
    forbidden = raw.forbidden.map((step, i) => parseForbiddenStep(step, absSpec, i));
  }

  const scoring = parseScoring(raw.scoring, absSpec);

  const spec: WorkflowSpec = {
    id,
    title,
    required_sequence,
    scoring,
    sourcePath: absSpec,
  };
  if (description !== undefined) spec.description = description;
  if (applies_to !== undefined) spec.applies_to = applies_to;
  if (goldRefRaw !== undefined) spec.gold_ref = goldRefRaw;
  if (forbidden !== undefined) spec.forbidden = forbidden;
  return spec;
}

/**
 * Load every `*.yaml` / `*.yml` file in `dir` (non-recursive) as a
 * `WorkflowSpec`. Each file is path-traversal-checked against `dir`.
 *
 * Throws `WorkflowSpecError` on the first malformed spec — fail-fast.
 * Duplicate `id` values across the directory are also rejected.
 */
export function loadAllWorkflowSpecs(dir: string): WorkflowSpec[] {
  const absDir = path.resolve(dir);
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch (err) {
    throw new WorkflowSpecError(`Cannot read workflows directory: ${(err as Error).message}`, absDir);
  }
  const yamlFiles = entries.filter((e) => e.endsWith(".yaml") || e.endsWith(".yml")).sort();

  const specs: WorkflowSpec[] = [];
  const ids = new Set<string>();
  for (const f of yamlFiles) {
    const spec = loadWorkflowSpec(path.join(absDir, f), absDir);
    if (ids.has(spec.id)) {
      throw new WorkflowSpecError(`Duplicate workflow spec id "${spec.id}"`, spec.sourcePath);
    }
    ids.add(spec.id);
    specs.push(spec);
  }
  return specs;
}

// ── Applicability ──────────────────────────────────────────────────────────

export interface WorkflowApplicabilityContext {
  arm: string;
  /** Full task id, e.g. "docker-homelab/redis-healthcheck". */
  taskId: string;
  outcome?: string;
  hasGoldRef?: boolean;
  repeatedFailures?: number;
}

/**
 * Returns true iff the spec's `applies_to` filter matches `ctx`. A spec with
 * no `applies_to` matches everything.
 *
 * Domain match: the first '/'-separated segment of `taskId` must appear in
 * `applies_to.task_domains` (matches the convention used by #260).
 */
export function specApplies(spec: WorkflowSpec, ctx: WorkflowApplicabilityContext): boolean {
  const a = spec.applies_to;
  if (!a) return true;
  if (a.arms && a.arms.length > 0 && !a.arms.includes(ctx.arm)) return false;
  if (a.task_domains && a.task_domains.length > 0) {
    const domain = ctx.taskId.split("/")[0] ?? "";
    if (!a.task_domains.includes(domain)) return false;
  }
  if (a.outcomes && a.outcomes.length > 0) {
    if (!ctx.outcome || !a.outcomes.includes(ctx.outcome)) return false;
  }
  if (a.requires_gold_ref && !ctx.hasGoldRef) return false;
  if (a.min_repeated_failures !== undefined) {
    if ((ctx.repeatedFailures ?? 0) < a.min_repeated_failures) return false;
  }
  return true;
}
