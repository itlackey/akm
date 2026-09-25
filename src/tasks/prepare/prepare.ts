// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure task runtime projection.
 *
 * This is the only bridge from an already-parsed, already-projected task
 * source document (the `PreparableTaskDocument` seam, P4-N4) into executable
 * work. It performs all source/config/asset reads before the task runner
 * reserves a durable attempt and returns immutable snapshots. In particular,
 * script work contains frozen bytes and their digest, never a path that can
 * be reread when a delayed or resumed dispatch begins.
 *
 * `prepareTaskV3Execution`'s three production callers are
 * `src/tasks/run/load-task.ts`, `src/tasks/scheduler-sync.ts`, and
 * `src/workflows/freeze/targets/task.ts`'s `taskDispatch`. The name and the
 * `TaskV3*` type family it takes stay (spec docs/plans/specs/p4-deletions-closeout.md
 * §0, R-R1) — only task source v4 ever reaches this function now, always via
 * `src/tasks/source/project-v4.ts`'s `projectTaskSourceV4()`.
 */

import fs from "node:fs";
import { prepareCommandInvocation } from "../../commands/command/command-execution";
import { UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import type { TaskV3SourceDocument } from "../source-v3";
import {
  base,
  commandEnvironmentSnapshot,
  currentExecutionValues,
  defaultTaskShell,
  environmentSnapshot,
  qualifyOwnedRef,
  resolvedOwnedAsset,
  validatePreparedCommand,
  validateWorkflowRuntimeSource,
} from "./prepare-support";
import type { PreparedTaskV3Execution, PrepareTaskV3ExecutionContext } from "./prepared-execution";
import { captureDirectoryIdentity, captureScriptTarget } from "./script-capture";

/** Project one canonical task-v3 source into immutable executable work. */
export async function prepareTaskV3Execution(
  document: TaskV3SourceDocument,
  context: PrepareTaskV3ExecutionContext,
): Promise<PreparedTaskV3Execution> {
  const environment = environmentSnapshot(document.env);
  const commandEnvironment = commandEnvironmentSnapshot(environment, context.schedulerContext);
  const common = base(document, context, environment);
  if (document.target.kind === "run") {
    const cwdIdentity = captureDirectoryIdentity(context.bundleRoot, document.target.workingDirectory);
    return Object.freeze({
      ...common,
      kind: "shell" as const,
      command: document.target.run,
      shell: document.target.shell ?? defaultTaskShell(context.platform ?? process.platform),
      cwd: cwdIdentity.realCwd,
      cwdIdentity,
    });
  }

  const target = document.target.uses;
  if (target.kind === "builtin-command") {
    const command = document.target.command;
    if (!command) throw new Error("invariant: parsed built-in command target has no command action");
    const action =
      command.kind === "stored"
        ? {
            ref: qualifyOwnedRef(command.ref, context).qualified,
            ...(command.arguments !== undefined ? { arguments: command.arguments } : {}),
          }
        : { content: command.content, ...(command.arguments !== undefined ? { arguments: command.arguments } : {}) };
    const invocation = validatePreparedCommand(
      await (context.prepareCommand ?? prepareCommandInvocation)({
        action,
        config: context.config,
        current: currentExecutionValues(document, context, commandEnvironment),
        ...(context.commandSourceLoader ? { sourceLoader: context.commandSourceLoader } : {}),
      }),
      context,
    );
    return Object.freeze({ ...common, kind: "command" as const, invocation });
  }

  const { qualified } = qualifyOwnedRef(target.ref, context);
  if (target.kind === "command") {
    // Unreachable from any parsed source: task source v4 accepts with: only
    // on uses: akm/command. Kept as a seam invariant — this function takes a
    // structurally-typed document.
    if (document.target.with !== undefined) {
      throw new UsageError(
        "Command refs do not accept with; use akm/command with {ref, arguments} for portable arguments.",
        "COMPOSITION_INVALID",
      );
    }
    const invocation = validatePreparedCommand(
      await (context.prepareCommand ?? prepareCommandInvocation)({
        action: { ref: qualified },
        config: context.config,
        current: currentExecutionValues(document, context, commandEnvironment),
        ...(context.commandSourceLoader ? { sourceLoader: context.commandSourceLoader } : {}),
      }),
      context,
    );
    return Object.freeze({ ...common, kind: "command" as const, invocation });
  }
  if (target.kind === "workflow") {
    // Stays reachable — task source v4 still has a top-level env: (P4-N4).
    if (Object.keys(environment).length > 0) {
      warn(
        "[akm] Task %s: env: is not translated for a workflow target and will be ignored; the durable workflow runtime does not consume it. Use a command target, or drop env:.",
        context.taskRef,
      );
    }
    const resolved = await resolvedOwnedAsset(qualified, "workflow", context);
    validateWorkflowRuntimeSource(
      resolved.file,
      resolved.bundleRoot,
      context.readFile ?? ((targetPath: string) => fs.readFileSync(targetPath)),
    );
    return Object.freeze({
      ...common,
      kind: "workflow" as const,
      ref: qualified,
      params: Object.freeze({ ...(document.target.with ?? {}) }),
      ...(document.akm?.maxSteps !== undefined ? { maxSteps: document.akm.maxSteps } : {}),
      ...(document.akm?.maxRetries !== undefined ? { maxRetries: document.akm.maxRetries } : {}),
    });
  }
  // Unreachable from any parsed source: task source v4 accepts with: only on
  // uses: akm/command. Kept as a seam invariant — this function takes a
  // structurally-typed document.
  if (document.target.with !== undefined) {
    throw new UsageError("Script refs do not accept with.", "COMPOSITION_INVALID");
  }
  const resolved = await resolvedOwnedAsset(qualified, "script", context);
  // Shared with prepare-script-target.ts's prepareScriptTarget() (spec §4.3):
  // one implementation of the byte/interpreter capture, not two.
  const captured = captureScriptTarget(
    qualified,
    resolved.file,
    resolved.bundleRoot,
    context.readFile ?? ((targetPath: string) => fs.readFileSync(targetPath)),
  );
  return Object.freeze({
    ...common,
    kind: "script" as const,
    sourceRef: qualified,
    ...captured,
  });
}
