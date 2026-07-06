// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Orchestration subsection parsing for the P1 extended workflow grammar
 * (docs/technical/akm-workflows-orchestration-plan.md).
 *
 * A step body may declare `### Runner`, `### Model`, `### Timeout`,
 * `### Fan-out`, `### Schema`, `### Env`, and `### Depends On` in addition to
 * the classic `### Instructions` / `### Completion Criteria`. All additions
 * are additive and backward-compatible; parsing accumulates `WorkflowError`s
 * exactly like the base parser instead of throwing.
 */

import { parseAssetRef } from "../core/asset/asset-ref";
import type { SourceRef, WorkflowError, WorkflowStepOrchestration } from "./schema";

export const ORCHESTRATION_SUBSECTIONS = new Set([
  "Runner",
  "Model",
  "Timeout",
  "Fan-out",
  "Schema",
  "Env",
  "Depends On",
]);

const RUNNER_KINDS = new Set(["llm", "agent", "sdk", "inherit"]);
const FAN_OUT_REDUCERS = new Set(["collect", "vote"]);
const KEY_VALUE_LINE = /^([a-z][a-z-]*):\s*(.*)$/;
const BULLET_LINE = /^[-*]\s+(.+)$/;
const TIMEOUT_VALUE = /^(\d+)(ms|s|m)?$/;

interface SubsectionSlice {
  name: string;
  headingLine: number;
  bodyStart: number;
  bodyEnd: number;
}

/**
 * Parse every orchestration subsection of one step into a
 * {@link WorkflowStepOrchestration}, or `undefined` when the step declares
 * none. Duplicate subsections and malformed bodies push errors and are
 * skipped, mirroring the base parser's accumulate-don't-throw contract.
 */
export function collectOrchestration(
  subsections: SubsectionSlice[],
  lines: string[],
  path: string,
  stepTitle: string,
  errors: WorkflowError[],
): WorkflowStepOrchestration | undefined {
  const seen = new Set<string>();
  let out: Omit<WorkflowStepOrchestration, "source"> = {};
  let anchor: SourceRef | undefined;

  for (const sub of subsections) {
    if (!ORCHESTRATION_SUBSECTIONS.has(sub.name)) continue;
    if (seen.has(sub.name)) {
      errors.push({
        line: sub.headingLine,
        message: `Step "${stepTitle}" has more than one "### ${sub.name}" section (line ${sub.headingLine}). Keep only one.`,
      });
      continue;
    }
    seen.add(sub.name);
    anchor ??= { path, start: sub.headingLine, end: sub.bodyEnd };

    switch (sub.name) {
      case "Runner":
        out = { ...out, ...parseRunner(sub, lines, stepTitle, errors) };
        break;
      case "Model":
        out = { ...out, ...parseSingleValue(sub, lines, stepTitle, errors, "Model", (model) => ({ model })) };
        break;
      case "Timeout":
        out = { ...out, ...parseTimeout(sub, lines, stepTitle, errors) };
        break;
      case "Fan-out":
        out = { ...out, ...parseFanOut(sub, lines, stepTitle, errors) };
        break;
      case "Schema":
        out = { ...out, ...parseSchema(sub, lines, stepTitle, errors) };
        break;
      case "Env":
        out = { ...out, ...parseEnv(sub, lines, stepTitle, errors) };
        break;
      case "Depends On":
        out = { ...out, ...parseDependsOn(sub, lines, stepTitle, errors) };
        break;
    }
  }

  if (!anchor || Object.keys(out).length === 0) {
    return anchor ? { source: anchor } : undefined;
  }
  return { ...out, source: anchor };
}

// ── Per-subsection parsers ───────────────────────────────────────────────────

function bodyLines(sub: SubsectionSlice, lines: string[]): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  for (let lineNum = sub.bodyStart; lineNum <= Math.min(sub.bodyEnd, lines.length); lineNum++) {
    const stripped = stripTrailingComment(lines[lineNum - 1] ?? "").trim();
    if (!stripped) continue;
    out.push({ line: lineNum, text: stripped });
  }
  return out;
}

/** Strip a trailing ` # comment` (only when the `#` is whitespace-separated). */
function stripTrailingComment(text: string): string {
  const idx = text.search(/\s#\s/);
  return idx >= 0 ? text.slice(0, idx) : text;
}

function parseRunner(
  sub: SubsectionSlice,
  lines: string[],
  stepTitle: string,
  errors: WorkflowError[],
): Pick<WorkflowStepOrchestration, "runner" | "profile"> {
  const out: { runner?: WorkflowStepOrchestration["runner"]; profile?: string } = {};
  for (const { line, text } of bodyLines(sub, lines)) {
    const kv = text.match(KEY_VALUE_LINE);
    if (kv) {
      if (kv[1] === "profile" && kv[2].trim()) {
        out.profile = kv[2].trim();
        continue;
      }
      errors.push({
        line,
        message: `Step "${stepTitle}" "### Runner" has an unknown line "${text}". Use a runner kind (llm, agent, sdk, inherit) and optionally "profile: <name>".`,
      });
      continue;
    }
    const kind = text.toLowerCase();
    if (!RUNNER_KINDS.has(kind)) {
      errors.push({
        line,
        message: `Step "${stepTitle}" has an invalid runner "${text}". Use one of: llm, agent, sdk, inherit.`,
      });
      continue;
    }
    if (out.runner !== undefined) {
      errors.push({
        line,
        message: `Step "${stepTitle}" "### Runner" declares more than one runner kind. Keep only one.`,
      });
      continue;
    }
    out.runner = kind as WorkflowStepOrchestration["runner"];
  }
  if (out.runner === undefined && out.profile === undefined) {
    errors.push({
      line: sub.headingLine,
      message: `Step "${stepTitle}" has an empty "### Runner" section. Add a runner kind (llm, agent, sdk, inherit).`,
    });
  }
  return out;
}

function parseSingleValue<K extends Partial<WorkflowStepOrchestration>>(
  sub: SubsectionSlice,
  lines: string[],
  stepTitle: string,
  errors: WorkflowError[],
  label: string,
  build: (value: string) => K,
): K | Record<string, never> {
  const body = bodyLines(sub, lines);
  if (body.length === 0) {
    errors.push({
      line: sub.headingLine,
      message: `Step "${stepTitle}" has an empty "### ${label}" section. Add the value below the heading.`,
    });
    return {};
  }
  if (body.length > 1) {
    errors.push({
      line: body[1].line,
      message: `Step "${stepTitle}" "### ${label}" must contain a single value line.`,
    });
    return {};
  }
  return build(body[0].text);
}

function parseTimeout(
  sub: SubsectionSlice,
  lines: string[],
  stepTitle: string,
  errors: WorkflowError[],
): Pick<WorkflowStepOrchestration, "timeoutMs"> | Record<string, never> {
  return parseSingleValue(sub, lines, stepTitle, errors, "Timeout", (value) => {
    if (value.toLowerCase() === "none") return { timeoutMs: null };
    const match = value.toLowerCase().match(TIMEOUT_VALUE);
    if (!match) {
      errors.push({
        line: sub.bodyStart,
        message: `Step "${stepTitle}" has an invalid timeout "${value}". Use "<n>ms", "<n>s", "<n>m" (e.g. "10m"), or "none".`,
      });
      return {} as { timeoutMs?: number | null };
    }
    const n = Number.parseInt(match[1], 10);
    const unit = match[2] ?? "ms";
    const timeoutMs = unit === "m" ? n * 60_000 : unit === "s" ? n * 1_000 : n;
    if (timeoutMs <= 0) {
      errors.push({
        line: sub.bodyStart,
        message: `Step "${stepTitle}" has a non-positive timeout "${value}". Use a positive duration or "none".`,
      });
      return {} as { timeoutMs?: number | null };
    }
    return { timeoutMs };
  });
}

function parseFanOut(
  sub: SubsectionSlice,
  lines: string[],
  stepTitle: string,
  errors: WorkflowError[],
): Pick<WorkflowStepOrchestration, "fanOut"> | Record<string, never> {
  let over: string | undefined;
  let concurrency: number | undefined;
  let reducer: "collect" | "vote" | undefined;

  for (const { line, text } of bodyLines(sub, lines)) {
    const kv = text.match(KEY_VALUE_LINE);
    if (!kv) {
      errors.push({
        line,
        message: `Step "${stepTitle}" "### Fan-out" has an unknown line "${text}". Use "over:", "concurrency:", and "reducer:" key-value lines.`,
      });
      continue;
    }
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    switch (key) {
      case "over":
        if (!value) {
          errors.push({ line, message: `Step "${stepTitle}" "### Fan-out" has an empty "over:" value.` });
          break;
        }
        over = value;
        break;
      case "concurrency": {
        const n = Number.parseInt(value, 10);
        if (!/^\d+$/.test(value) || n <= 0) {
          errors.push({
            line,
            message: `Step "${stepTitle}" "### Fan-out" concurrency must be a positive integer, got "${value}".`,
          });
          break;
        }
        concurrency = n;
        break;
      }
      case "reducer":
        if (!FAN_OUT_REDUCERS.has(value)) {
          errors.push({
            line,
            message: `Step "${stepTitle}" "### Fan-out" reducer must be one of: collect, vote. Got "${value}".`,
          });
          break;
        }
        reducer = value as "collect" | "vote";
        break;
      default:
        errors.push({
          line,
          message: `Step "${stepTitle}" "### Fan-out" has an unknown key "${key}:". Use "over:", "concurrency:", or "reducer:".`,
        });
    }
  }

  if (!over) {
    errors.push({
      line: sub.headingLine,
      message: `Step "${stepTitle}" "### Fan-out" is missing the required "over: <param-or-evidence-key>" line.`,
    });
    return {};
  }
  return {
    fanOut: {
      over,
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(reducer !== undefined ? { reducer } : {}),
    },
  };
}

function parseSchema(
  sub: SubsectionSlice,
  lines: string[],
  stepTitle: string,
  errors: WorkflowError[],
): Pick<WorkflowStepOrchestration, "schema"> | Record<string, never> {
  const raw = lines
    .slice(sub.bodyStart - 1, Math.min(sub.bodyEnd, lines.length))
    .join("\n")
    .trim();
  if (!raw) {
    errors.push({
      line: sub.headingLine,
      message: `Step "${stepTitle}" has an empty "### Schema" section. Add a JSON Schema object (optionally fenced with \`\`\`json).`,
    });
    return {};
  }
  const unfenced = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (err) {
    errors.push({
      line: sub.headingLine,
      message: `Step "${stepTitle}" "### Schema" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    errors.push({
      line: sub.headingLine,
      message: `Step "${stepTitle}" "### Schema" must be a JSON object (a JSON Schema), not ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
    });
    return {};
  }
  return { schema: parsed as Record<string, unknown> };
}

function parseEnv(
  sub: SubsectionSlice,
  lines: string[],
  stepTitle: string,
  errors: WorkflowError[],
): Pick<WorkflowStepOrchestration, "env"> | Record<string, never> {
  const refs: string[] = [];
  for (const { line, text } of bodyLines(sub, lines)) {
    const bullet = text.match(BULLET_LINE);
    const ref = (bullet ? bullet[1] : text).trim();
    // Real ref validation, not a substring probe: parseAssetRef applies the
    // canonical type-alias table (`environment:` → env) and origin syntax, so
    // "myenv:foo" is rejected and "team//environment:ci" is accepted.
    let refType: string | undefined;
    try {
      refType = parseAssetRef(ref).type;
    } catch {
      refType = undefined;
    }
    if (refType !== "env") {
      errors.push({
        line,
        message: `Step "${stepTitle}" "### Env" entry "${ref}" is not an env ref. Use "env:<name>" (or "<origin>//env:<name>").`,
      });
      continue;
    }
    refs.push(ref);
  }
  if (refs.length === 0) {
    errors.push({
      line: sub.headingLine,
      message: `Step "${stepTitle}" has an empty "### Env" section. Add at least one "- env:<name>" entry.`,
    });
    return {};
  }
  return { env: refs };
}

function parseDependsOn(
  sub: SubsectionSlice,
  lines: string[],
  stepTitle: string,
  errors: WorkflowError[],
): Pick<WorkflowStepOrchestration, "dependsOn"> | Record<string, never> {
  const ids: string[] = [];
  for (const { text } of bodyLines(sub, lines)) {
    const bullet = text.match(BULLET_LINE);
    ids.push((bullet ? bullet[1] : text).trim());
  }
  if (ids.length === 0) {
    errors.push({
      line: sub.headingLine,
      message: `Step "${stepTitle}" has an empty "### Depends On" section. Add at least one "- <step-id>" bullet.`,
    });
    return {};
  }
  return { dependsOn: ids };
}
