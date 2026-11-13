// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Experimental: project a `steps:` task into prepared steps. A prompt step is
 * prepared as a one-step command task through the same `prepareTaskExecution`
 * a command task uses, so the cascade, redaction and lowering stay unchanged.
 */

import path from "node:path";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import type { TaskSourceV4Step } from "../source/task-source-v4";
import type { PreparableTaskDocument } from "../task-source";
import { defaultTaskShell, environmentSnapshot, qualifyOwnedRef } from "./prepare-support";
import type { PreparedTaskStep, PrepareTaskExecutionContext } from "./prepared-execution";

type StepsDocument = PreparableTaskDocument & { target: Extract<PreparableTaskDocument["target"], { kind: "steps" }> };

function timeoutMs(value: string | number | null | undefined): number | null | undefined {
  if (value === undefined || value === null || typeof value === "number") return value;
  return parseDuration(value, DURATION_UNITS) ?? undefined;
}

/** The synthesized one-step command document: task-level keys are defaults, the step's own keys win. */
function promptDocument(
  document: StepsDocument,
  step: Extract<TaskSourceV4Step, { kind: "prompt" }>,
): PreparableTaskDocument {
  const base = { ...(document.akm ?? {}) } as Record<string, unknown>;
  delete base.outputSchema;
  delete base.maxSteps;
  delete base.maxRetries;
  // A step that names a harness or connection replaces the task's whole runner selection.
  if (step.harness !== undefined || step.connection !== undefined) {
    delete base.harness;
    delete base.connection;
    delete base.engine;
  }
  for (const key of ["harness", "connection", "model"] as const) {
    if (step[key] !== undefined) base[key] = step[key];
  }
  if (step.timeout !== undefined) base.timeout = step.timeout;
  if (step.expect) base.outputSchema = { type: "object", required: [...step.expect] };
  return {
    version: 3,
    ...(document.name !== undefined ? { name: document.name } : {}),
    target:
      step.prompt.kind === "ref"
        ? { kind: "uses", uses: { kind: "command", ref: step.prompt.ref } }
        : {
            kind: "uses",
            uses: { kind: "builtin-command", ref: "akm/command" },
            command: { kind: "inline", content: step.prompt.content },
          },
    env: { ...document.env, ...step.env },
    akm: base,
    triggers: document.triggers,
    source: document.source,
  } as PreparableTaskDocument;
}

/** Name the step in a step failure, keeping the error's class and code. */
export function nameStepError(stepName: string, error: unknown): unknown {
  if (error instanceof Error) error.message = `Step "${stepName}": ${error.message}`;
  return error;
}

export async function prepareSteps(
  document: StepsDocument,
  context: PrepareTaskExecutionContext,
  prepareOne: (document: PreparableTaskDocument, context: PrepareTaskExecutionContext) => Promise<unknown>,
): Promise<readonly PreparedTaskStep[]> {
  const prepared: PreparedTaskStep[] = [];
  for (const step of document.target.steps) {
    const environment = environmentSnapshot({ ...document.env, ...step.env });
    const common = { name: step.name, retries: step.retries, environment };
    if (step.kind === "run") {
      const timeout = timeoutMs(step.timeout ?? document.akm?.timeout);
      prepared.push(
        Object.freeze({
          ...common,
          kind: "shell" as const,
          command: step.run,
          shell: document.target.shell ?? defaultTaskShell(context.platform ?? process.platform),
          cwd: path.resolve(context.bundleRoot, document.target.workingDirectory ?? "."),
          ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
        }),
      );
    } else if (step.kind === "task") {
      prepared.push(
        Object.freeze({ ...common, kind: "task" as const, ref: qualifyOwnedRef(step.ref, context).qualified }),
      );
    } else {
      let command: { invocation: never };
      try {
        command = (await prepareOne(promptDocument(document, step), context)) as { invocation: never };
      } catch (error) {
        throw nameStepError(step.name, error);
      }
      prepared.push(
        Object.freeze({
          ...common,
          kind: "command" as const,
          invocation: command.invocation,
          ...(step.expect ? { expect: step.expect } : {}),
        }),
      );
    }
  }
  return Object.freeze(prepared);
}
