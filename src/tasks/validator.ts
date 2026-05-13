/**
 * Validate a parsed {@link TaskDocument} for runnability.
 *
 * Enforces:
 *   • the schedule is parseable and translates to the active backend
 *   • the workflow ref resolves (workflow targets)
 *   • the asset/file source exists (prompt targets)
 *   • the agent profile resolves (prompt targets)
 *
 * Validation is deliberately split from parsing: callers that only want to
 * read frontmatter (e.g. `tasks list`) can skip these checks, while
 * `tasks add` and `tasks run` should always run them.
 */

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../core/asset-ref";
import { resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config";
import { NotFoundError } from "../core/errors";
import { requireAgentProfile } from "../integrations/agent";
import { resolveAssetPath } from "../sources/resolve";
import { parseSchedule, type ScheduleBackend } from "./schedule";
import type { TaskDocument } from "./schema";

export interface ValidateTaskOptions {
  /** Which backend the schedule must translate to. */
  backend: ScheduleBackend;
  /** Override stashDir; defaults to {@link resolveStashDir}. */
  stashDir?: string;
}

export async function validateTaskDocument(task: TaskDocument, options: ValidateTaskOptions): Promise<void> {
  // Schedule must parse and translate.
  parseSchedule(task.schedule, options.backend);

  if (task.target.kind === "workflow") {
    const stashDir = options.stashDir ?? resolveStashDir();
    const ref = parseAssetRef(task.target.ref);
    if (ref.type !== "workflow") {
      throw new NotFoundError(
        `Task "${task.id}" workflow target must be a workflow ref (got "${task.target.ref}").`,
        "WORKFLOW_NOT_FOUND",
      );
    }
    await resolveAssetPath(stashDir, "workflow", ref.name);
    return;
  }

  if (task.target.kind !== "prompt") {
    return;
  }

  // Prompt target. Resolve the profile unconditionally — when no profile is
  // set on the task, requireAgentProfile falls back to config.agent.default
  // and throws a clear error if neither is configured. Catching this at
  // `tasks add` / `tasks sync` time is much more useful than failing only
  // when the OS scheduler fires.
  const config = loadConfig();
  requireAgentProfile(config.agent, task.target.profile);

  const src = task.target.source;
  if (src.kind === "asset") {
    const stashDir = options.stashDir ?? resolveStashDir();
    const ref = parseAssetRef(src.ref);
    await resolveAssetPath(stashDir, ref.type, ref.name);
  } else if (src.kind === "file") {
    const taskDir = path.dirname(task.source.path);
    const resolved = path.isAbsolute(src.path) ? src.path : path.resolve(taskDir, src.path);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new NotFoundError(
        `Prompt file not found for task "${task.id}": ${src.path} (resolved to ${resolved}).`,
        "FILE_NOT_FOUND",
      );
    }
  }
  // inline source is always valid post-parse.
}
