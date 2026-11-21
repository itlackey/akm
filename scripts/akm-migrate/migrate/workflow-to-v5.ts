// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure planner for one workflow file: the workflow, as the workflow compiler reads it, becomes the text of a new
 * version 5 task. It never guesses. What version 5 has no form for and cannot lose safely (a fan-out, a child
 * workflow, an argv a shell would change) blocks the file with what to change; what it has no form for and loses
 * safely is listed as a note. Whether the result is a task v5 accepts is the checker's (`./task-files.ts` calls
 * `checkTaskV5`).
 */

import crypto from "node:crypto";
import { Document } from "yaml";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import { TASK_SOURCE_V5_VERSION, unknownReferences } from "../../../src/tasks/v5/source";
import { checkWorkflowPlan, compileWorkflowSource, workflowStepInstructions } from "../../../src/workflows/compile";
import type { WorkflowPlan, WorkflowPlanStep } from "../../../src/workflows/plan";
import { parseReference } from "../../../src/workflows/program/expressions";

export interface WorkflowToV5Input {
  /** The workflow file. */
  readonly filePath: string;
  readonly bytes: Buffer;
  readonly mode: number;
  readonly writable: boolean;
  /** `<name>` of `workflows/<name>.md`. */
  readonly name: string;
  /** The task file the conversion would create. */
  readonly taskPath: string;
  readonly taskExists: boolean;
  /** Task files whose text names `workflows/<name>`. */
  readonly namedBy: readonly string[];
}

export interface WorkflowToV5Converted {
  readonly status: "converted";
  readonly reason: "workflow-converted";
  readonly detail?: string;
  readonly filePath: string;
  /** `<name>` of `workflows/<name>.md`. */
  readonly name: string;
  /** The new task file. */
  readonly taskPath: string;
  readonly mode: number;
  readonly after: Buffer;
  readonly afterHash: string;
  /** What the workflow did that version 5 does not, to change by hand. */
  readonly notes: readonly string[];
}

export interface WorkflowToV5Blocked {
  readonly status: "blocked";
  readonly filePath: string;
  readonly reason: string;
  readonly detail: string;
  /** What to change, and how, before running the conversion again. */
  readonly guidance: string;
}

export type WorkflowToV5Outcome = WorkflowToV5Converted | WorkflowToV5Blocked;

const PLAIN_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const START_AGAIN = (name: string): string => `Then run \`akm migrate apply workflows/${name}.md\` again.`;

/** Why a file cannot convert, and what to do about it; one entry per reason. */
/** The workflow frontmatter keys the conversion reads; any other key has no place in a task file. */
const CONVERTED_FRONTMATTER = new Set([
  "type",
  "description",
  "when_to_use",
  "tags",
  "params",
  "defaults",
  "budget",
  "steps",
]);

const STEP_GUIDANCE = {
  "unknown-reference": (name: string) =>
    `Rewrite that step's text in workflows/${name}.md so every \${...} in it names an input or an earlier step; version 5 refuses any other \${...} in a prompt and has no escape. Where the text names a shell or environment variable for the agent to use, write it without braces (\`$XDG_CACHE_HOME\`) or in words; the step stays a prompt step and needs no new step or script. ${START_AGAIN(name)}`,
  "fan-out": (name: string) =>
    `Version 5 has no fan-out. Replace the map step with one step that does the whole list (a prose step that works through every item, or a script under scripts/ that loops and is run with a run: step), or write tasks/${name}.yml by hand with one step per item. ${START_AGAIN(name)}`,
  "child-workflow": (name: string) =>
    `Version 5 runs a task, not a workflow, from a step. Convert the child workflow first (\`akm migrate apply workflows/<child>.md\`), then write tasks/${name}.yml by hand with a \`run: tasks/<child>\` step where the workflow: step was, or remove the workflow: step from workflows/${name}.md. ${START_AGAIN(name)}`,
  engine: (name: string) =>
    `The retired engine: key names a connection or a harness. Run \`akm migrate apply\` to rewrite it as connection: or harness: in workflows/${name}.md. ${START_AGAIN(name)}`,
  "llm-overrides": (name: string) =>
    `Version 5 has no per-step or per-workflow inference settings (llm:). Remove them from workflows/${name}.md, or set them on the connection or harness the step uses. ${START_AGAIN(name)}`,
  "exec-argv": (name: string) =>
    `An exec: step is a shell line, so an argv converts only when every item is a plain shell word (letters, digits and _@%+=:,./-). Move the command into a script asset under scripts/ and run it from a step, or give the argv plain words only. ${START_AGAIN(name)}`,
} as const;

type StepBlockReason = keyof typeof STEP_GUIDANCE;

export function checkFailureGuidance(name: string): string {
  return `Version 5 refused the converted task. Change workflows/${name}.md so that the task it makes passes the check (\`akm doctor explain tasks/${name}\` runs the same one), or write tasks/${name}.yml by hand. ${START_AGAIN(name)}`;
}

export function workflowBlocked(
  filePath: string,
  reason: string,
  detail: string,
  guidance: string,
): WorkflowToV5Blocked {
  return Object.freeze({ status: "blocked" as const, filePath, reason, detail, guidance });
}

function duration(ms: number): string | number {
  for (const [unit, size] of [
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
  ] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return ms;
}

type Settings = NonNullable<WorkflowPlanStep["spec"]>["unit"];

/** The options a unit's settings give a step, and the notes for the settings that have no form. */
function options(settings: Settings, defaults: WorkflowPlan["defaults"], step: string | undefined) {
  const out: Record<string, unknown> = {};
  const notes: string[] = [];
  const where = step === undefined ? "The workflow" : `Step ${step}`;
  for (const key of ["harness", "connection", "model"] as const) {
    const value = settings?.[key] ?? (step === undefined ? defaults?.[key] : undefined);
    if (value !== undefined) out[key] = value;
  }
  const timeout =
    settings?.timeoutMs !== undefined ? settings.timeoutMs : step === undefined ? defaults?.timeoutMs : undefined;
  if (timeout === null) {
    notes.push(`${where} set no timeout; a version 5 step has a limit of 30 minutes unless it sets a timeout.`);
  } else if (timeout !== undefined) {
    out.timeout = duration(timeout);
  }
  const onError = settings?.onError ?? (step === undefined ? defaults?.onError : undefined);
  if (onError === "continue") {
    notes.push(`${where} had on_error: continue; in version 5 a failed step stops the run.`);
  }
  return { out, notes };
}

function expectOf(schema: Record<string, unknown> | undefined, step: string): { expect?: string[]; notes: string[] } {
  if (schema === undefined) return { notes: [] };
  const required = schema.required;
  if (
    schema.type === "object" &&
    Array.isArray(required) &&
    required.length > 0 &&
    required.every((key) => typeof key === "string")
  ) {
    const rest = Object.keys(schema).filter((key) => key !== "required" && key !== "type");
    return {
      expect: required as string[],
      notes:
        rest.length > 0
          ? [`Step ${step}: its output schema is not checked any more beyond the required keys, now expect:.`]
          : [],
    };
  }
  return { notes: [`Step ${step}: its output schema is not checked any more.`] };
}

function promptOf(plan: WorkflowPlan, step: WorkflowPlanStep): { text: string; notes: string[] } {
  const notes: string[] = [];
  let text = workflowStepInstructions(step);
  const params = plan.params ?? [];
  if (params.length > 0) text += `\n\n## Run inputs\n${params.map((name) => `- ${name}: \${${name}}`).join("\n")}`;
  const inputs: string[] = [];
  for (const reference of step.spec?.inputs ?? []) {
    const parsed = parseReference(reference);
    if (!parsed.ok || parsed.expr.kind !== "stepOutput") continue;
    inputs.push(`### ${reference}\n\${${parsed.expr.stepId}}`);
    if (parsed.expr.path.length > 0) {
      notes.push(
        `Step ${step.stepId}: it was given ${reference}; the converted prompt holds the whole result of step ${parsed.expr.stepId}, so name the field in the prompt by hand.`,
      );
    }
  }
  if (inputs.length > 0) text += `\n\n## Declared inputs\n${inputs.join("\n\n")}`;
  return { text, notes };
}

/** Convert one workflow file to the text of a version 5 task. */
export function planWorkflowToV5File(input: WorkflowToV5Input): WorkflowToV5Outcome {
  const { filePath, name } = input;
  const block = (reason: string, detail: string, guidance: string) =>
    workflowBlocked(filePath, reason, detail, guidance);
  if (!input.writable) {
    return block(
      "read-only-source",
      "the owning source is not writable",
      `A task is created in the workflow's own bundle, and this bundle is not writable. Make the bundle writable, or copy workflows/${name}.md into a writable bundle. ${START_AGAIN(name)}`,
    );
  }
  if (input.taskExists) {
    return block(
      "task-file-exists",
      `${input.taskPath} already exists; it is never overwritten`,
      `Remove or rename tasks/${name}.yml, or keep it and delete workflows/${name}.md if it already is the converted task. ${START_AGAIN(name)}`,
    );
  }
  const text = input.bytes.toString("utf8");
  const compiled = compileWorkflowSource(text, { path: filePath, title: name });
  if (!compiled.ok) {
    return block(
      "invalid-workflow",
      compiled.errors.map((error) => `line ${error.line}: ${error.message}`).join("; "),
      `Fix the workflow until \`akm doctor explain workflows/${name}\` accepts it. ${START_AGAIN(name)}`,
    );
  }
  const plan = compiled.plan;
  const checked = checkWorkflowPlan(plan);
  if (!checked.ok) {
    return block(
      "invalid-workflow",
      checked.errors.map((error) => `line ${error.line}: ${error.message}`).join("; "),
      `Fix the workflow until \`akm doctor explain workflows/${name}\` accepts it. ${START_AGAIN(name)}`,
    );
  }

  const blockers: { reason: StepBlockReason; text: string }[] = [];
  const notes: string[] = [];
  const fail = (reason: StepBlockReason, text: string): void => {
    blockers.push({ reason, text });
  };
  if (plan.defaults?.engine !== undefined) fail("engine", "the workflow's defaults use the retired engine: key");
  if (plan.defaults?.llm !== undefined) fail("llm-overrides", "the workflow's defaults set llm: inference settings");
  const top = options(undefined, plan.defaults, undefined);
  notes.push(...top.notes);
  if (plan.budget !== undefined)
    notes.push("The workflow's budget is not kept: version 5 has no token or unit budget.");
  const unkept = Object.keys(parseFrontmatter(text).data).filter((key) => !CONVERTED_FRONTMATTER.has(key));
  if (unkept.length > 0) {
    notes.push(`Frontmatter not kept (${unkept.join(", ")}): a task file has no such keys.`);
  }

  const known = new Set(Object.keys(plan.paramSchemas ?? {}));
  const steps: Record<string, unknown>[] = [];
  const prompts: { name: string; text: string; known: Set<string> }[] = [];
  for (const step of plan.steps) {
    const spec = step.spec;
    const id = step.stepId;
    const unit = spec?.unit;
    const stepKnown = new Set(known);
    known.add(id);
    if (spec?.map) {
      fail("fan-out", `step ${id}: a fan-out (map over ${spec.map.over})`);
      continue;
    }
    if (spec?.workflow) {
      fail("child-workflow", `step ${id}: a child workflow (workflow: ${spec.workflow})`);
      continue;
    }
    if (unit?.engine !== undefined) fail("engine", `step ${id}: the retired engine: key`);
    if (unit?.llm !== undefined) fail("llm-overrides", `step ${id}: llm: inference settings`);
    if (unit?.engine !== undefined || unit?.llm !== undefined) continue;
    const settings = options(unit, plan.defaults, id);
    notes.push(...settings.notes);
    if (unit?.retry && unit.retry.on.length > 0) {
      notes.push(
        `Step ${id}: retry.on (${unit.retry.on.join(", ")}) is not kept; a version 5 step is tried again on any failure.`,
      );
    }
    if (step.gate.criteria.length > 0 || step.gate.maxLoops > 1) {
      notes.push(`Step ${id}: its \`### gate\` rubric is not checked any more; the step ends when its command does.`);
    }
    const out: Record<string, unknown> = { name: id };
    const schema = step.outputSchema ?? unit?.output;
    if (spec?.exec) {
      const odd = spec.exec.command.find((word) => !PLAIN_SHELL_WORD.test(word));
      if (odd !== undefined) {
        fail("exec-argv", `step ${id}: argument ${JSON.stringify(odd)} is not a plain shell word`);
        continue;
      }
      out.exec = spec.exec.command.join(" ");
      if (spec.exec.cwd !== undefined) out.cwd = spec.exec.cwd;
      if (spec.exec.passEnv !== undefined && spec.exec.passEnv.length > 0) out.inherit = spec.exec.passEnv;
      notes.push(
        `Step ${id}: it received the run's values as AKM_PARAMS and AKM_INPUTS; a version 5 step receives neither. A step that reads them reads the state file at $AKM_TASK_STATE instead: change it by hand.`,
      );
      if (schema !== undefined) notes.push(`Step ${id}: its output schema is not checked any more.`);
      if (settings.out.timeout !== undefined) out.timeout = settings.out.timeout;
    } else {
      const prompt = promptOf(plan, step);
      notes.push(...prompt.notes);
      out.prompt = prompt.text;
      prompts.push({ name: id, text: prompt.text, known: stepKnown });
      Object.assign(out, settings.out);
      const expected = expectOf(schema, id);
      notes.push(...expected.notes);
      if (expected.expect) out.expect = expected.expect;
    }
    if (unit?.env !== undefined && unit.env.length > 0) out.env = unit.env;
    if (unit?.retry && unit.retry.max > 0) out["max-retries"] = unit.retry.max;
    steps.push(out);
  }
  for (const prompt of prompts) {
    const refused = [...new Set(unknownReferences(prompt.text, (token) => prompt.known.has(token)))];
    if (refused.length > 0) {
      blockers.push({
        reason: "unknown-reference",
        text: `step ${prompt.name}: ${refused.map((token) => `\${${token}}`).join(", ")} (neither an input nor an earlier step)`,
      });
    }
  }
  if (blockers.length > 0) {
    const reasons = [...new Set(blockers.map((blocker) => blocker.reason))];
    return block(
      reasons[0] as string,
      blockers.map((blocker) => blocker.text).join("; "),
      reasons.map((reason) => STEP_GUIDANCE[reason](name)).join(" "),
    );
  }

  const out: Record<string, unknown> = { version: TASK_SOURCE_V5_VERSION };
  if (plan.description !== undefined) out.description = plan.description;
  if (plan.whenToUse !== undefined) out.when_to_use = plan.whenToUse;
  if (plan.tags !== undefined) out.tags = plan.tags;
  if (plan.paramSchemas !== undefined) out.inputs = plan.paramSchemas;
  out.lock = true;
  // A workflow's steps ran at its bundle's root; a task's steps work in an empty folder made for the run unless it
  // names one. A relative cwd: is taken from the bundle root.
  out.cwd = ".";
  Object.assign(out, top.out);
  out.steps = steps;
  const after = Buffer.from(new Document(out).toString({ lineWidth: 0 }), "utf8");

  if (input.namedBy.length > 0) {
    notes.push(
      `Task files that name workflows/${name}: ${input.namedBy.join(", ")}. Point each at tasks/${name}; they are not changed.`,
    );
  }
  return Object.freeze({
    status: "converted" as const,
    reason: "workflow-converted" as const,
    filePath,
    name,
    taskPath: input.taskPath,
    mode: input.mode,
    after,
    afterHash: crypto.createHash("sha256").update(after).digest("hex"),
    notes: Object.freeze(notes),
  });
}
