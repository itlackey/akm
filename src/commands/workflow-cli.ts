// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow` command family. Extracted verbatim from src/cli.ts (WS6) so the
 * God Module shrinks; the `main.subCommands.workflow` key and every subcommand's
 * args/output shape are byte-identical. Handlers whose body is a plain
 * `runWithJsonErrors(...) + output(...)` are migrated to `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form. `workflow template` keeps a plain `defineCommand` because it writes the
 * template straight to stdout with no JSON envelope. The private helpers
 * `looksLikeWorkflowRunId` and `resolveWorkflowFilePath` move with the family.
 */

import { defineCommand } from "citty";
import { defineJsonCommand, output, runWithJsonErrors } from "../cli/shared";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "../core/asset/asset-create";
import { parseAssetRef } from "../core/asset/asset-ref";
import { loadConfig } from "../core/config/config";
import { NotFoundError, UsageError } from "../core/errors";
import { akmIndex } from "../indexer/indexer";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { hasBooleanFlag } from "../output/context";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
import { resolveAssetPath } from "../sources/resolve";
import {
  createWorkflowAsset,
  formatWorkflowErrors,
  getWorkflowTemplate,
  validateWorkflowSource,
} from "../workflows/authoring/authoring";
import {
  hasWorkflowSubcommand,
  parseWorkflowJsonObject,
  parseWorkflowStepState,
  WORKFLOW_STEP_STATES,
} from "../workflows/cli";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  getWorkflowStatus,
  listWorkflowRuns,
  resumeWorkflowRun,
  startWorkflowRun,
} from "../workflows/runtime/runs";

const workflowStartCommand = defineJsonCommand({
  meta: {
    name: "start",
    description: "Start a new workflow run in the current working scope",
  },
  args: {
    ref: { type: "positional", description: "Workflow ref (workflow:<name>)", required: true },
    params: { type: "string", description: "Workflow parameters as a JSON object" },
    force: {
      type: "boolean",
      description: "Allow a parallel run when an active run already exists in this scope (#485)",
      default: false,
    },
  },
  async run({ args }) {
    const result = await startWorkflowRun(args.ref, parseWorkflowJsonObject(args.params, "--params"), {
      force: args.force === true,
    });
    output("workflow-start", result);
  },
});

const workflowNextCommand = defineJsonCommand({
  meta: {
    name: "next",
    description:
      "Show the next actionable workflow step in the current scope, auto-starting a run when passed a workflow ref",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref", required: true },
    params: { type: "string", description: "Workflow parameters as a JSON object (only for auto-started runs)" },
  },
  async run({ args }) {
    // `--dry-run` is intentionally NOT a declared arg (so it stays out of
    // --help). The guard reads it straight from process.argv so existing
    // callers still get a clear, actionable error instead of a generic
    // "unknown flag" from citty.
    if (hasBooleanFlag(process.argv, "--dry-run")) {
      throw new UsageError(
        "`akm workflow next` does not support --dry-run. Remove the flag to start or resume a run.",
        "INVALID_FLAG_VALUE",
      );
    }
    const parsedParams = args.params ? parseWorkflowJsonObject(args.params, "--params") : undefined;
    // If the target looks like a UUID-style run id (no `:` and matches the
    // run-id shape), short-circuit with a structured WORKFLOW_NOT_FOUND
    // error before parseAssetRef gets to throw an unhelpful ref-parse error.
    if (looksLikeWorkflowRunId(args.target)) {
      const { hasWorkflowRun } = await import("../workflows/runtime/runs.js");
      if (!(await hasWorkflowRun(args.target))) {
        throw new NotFoundError(
          `Workflow run "${args.target}" not found.`,
          "WORKFLOW_NOT_FOUND",
          "Run `akm workflow list --active` to see runs.",
        );
      }
    }
    const result = await getNextWorkflowStep(args.target, parsedParams);
    output("workflow-next", result);
  },
});

/**
 * Heuristic: a workflow run id is a UUID-shaped or hex-id-shaped string with
 * no `:` separator (refs always contain a colon: `workflow:<name>` or
 * `<origin>//workflow:<name>`). When this matches we can give a much better
 * error than parseAssetRef's "Invalid asset type" failure.
 */
function looksLikeWorkflowRunId(target: string): boolean {
  if (target.includes(":")) return false;
  if (target.includes("/")) return false;
  // UUID v4-ish: 8-4-4-4-12 hex digits separated by dashes.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) return true;
  // Bare hex/alphanumeric run ids of >=8 chars (covers shortened ids).
  if (/^[0-9a-z][0-9a-z_-]{7,}$/i.test(target) && /[0-9]/.test(target)) return true;
  return false;
}

const workflowCompleteCommand = defineJsonCommand({
  meta: {
    name: "complete",
    description: "Update a workflow step state and persist notes/evidence",
  },
  args: {
    runId: { type: "positional", description: "Workflow run id", required: true },
    step: { type: "string", description: "Workflow step id", required: true },
    state: {
      type: "string",
      description: `Step state (default: completed). One of: ${WORKFLOW_STEP_STATES.join(", ")}.`,
    },
    notes: { type: "string", description: "Notes for the completed step" },
    summary: {
      type: "string",
      description: "Summary of work done (required when completing a step); validated against completion criteria",
    },
    evidence: { type: "string", description: "Evidence JSON object for the step" },
  },
  async run({ args }) {
    const result = await completeWorkflowStep({
      runId: args.runId,
      stepId: args.step,
      status: parseWorkflowStepState(args.state),
      notes: args.notes,
      summary: args.summary,
      evidence: args.evidence ? parseWorkflowJsonObject(args.evidence, "--evidence") : undefined,
    });
    if ("ok" in result && result.ok === false) {
      // Summary failed the completion-criteria validation gate (#506): the
      // step stays pending and the agent receives corrective feedback.
      output("workflow-complete-rejected", result);
      return;
    }
    output("workflow-complete", result);
  },
});

const workflowStatusCommand = defineJsonCommand({
  meta: {
    name: "status",
    description: "Show full workflow run state for review or resume; workflow refs resolve within the current scope",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref (workflow:<name>)", required: true },
  },
  async run({ args }) {
    const target = args.target;
    // Check if target looks like a workflow ref
    const parsed = (() => {
      try {
        return parseAssetRef(target);
      } catch {
        return null;
      }
    })();
    if (parsed?.type === "workflow") {
      const ref = `${parsed.origin ? `${parsed.origin}//` : ""}workflow:${parsed.name}`;
      const { runs } = await listWorkflowRuns({ workflowRef: ref });
      if (runs.length === 0) {
        throw new NotFoundError(`No workflow runs found for ${ref}`, "WORKFLOW_NOT_FOUND");
      }
      const mostRecent = runs[0];
      if (!mostRecent) throw new NotFoundError(`No workflow runs found for ${ref}`, "WORKFLOW_NOT_FOUND");
      const result = await getWorkflowStatus(mostRecent.id);
      output("workflow-status", result);
    } else {
      const result = await getWorkflowStatus(target);
      output("workflow-status", result);
    }
  },
});

const workflowListCommand = defineJsonCommand({
  meta: {
    name: "list",
    description: "List workflow runs in the current working scope",
  },
  args: {
    ref: { type: "string", description: "Filter to one workflow ref" },
    active: { type: "boolean", description: "Only show active runs", default: false },
  },
  async run({ args }) {
    const result = await listWorkflowRuns({ workflowRef: args.ref, activeOnly: args.active });
    output("workflow-list", result);
  },
});

const workflowCreateCommand = defineJsonCommand({
  meta: {
    name: "create",
    description: "Create a workflow markdown document in the working stash",
  },
  args: {
    name: {
      type: "positional",
      description: "Workflow name (flat, no '/'; use --path for a subdirectory)",
      required: true,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under workflows/ to place the workflow in (e.g. 'release'). The filename comes from the name.",
    },
    from: { type: "string", description: "Import and validate markdown from an existing file" },
    force: {
      type: "boolean",
      description: "Overwrite an existing workflow (requires --from or --reset)",
      default: false,
    },
    reset: {
      type: "boolean",
      description: "Explicitly replace an existing workflow with a fresh template (use with --force)",
      default: false,
    },
  },
  async run({ args }) {
    // `name` is flat; subdirectory placement is `--path`'s job.
    assertFlatAssetName(args.name);
    const effectiveName = combineCreatePath(normalizeCreateSubPath(args.path), args.name);
    const namePattern = /^[a-z0-9][a-z0-9._/-]*$/;
    if (!namePattern.test(effectiveName)) {
      throw new UsageError(
        "Workflow name must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, dots, underscores, and slashes.",
      );
    }
    if (args.force && !args.from && !args.reset) {
      throw new UsageError(
        "Refusing to overwrite with template: pass --from <file> to replace content, or --reset to explicitly replace with a fresh template.",
      );
    }
    const result = createWorkflowAsset({
      name: effectiveName,
      from: args.from,
      force: args.force,
    });
    // Index the newly-written workflow so `akm workflow start` can resolve
    // a workflowEntryId without requiring an explicit `akm index` call
    // first. Uses the same incremental index path that `akm add` uses.
    await akmIndex({ stashDir: result.stashDir });
    output("workflow-create", { ok: true, ...result });
  },
});

const workflowTemplateCommand = defineCommand({
  meta: {
    name: "template",
    description: "Print a valid workflow markdown template",
  },
  run() {
    process.stdout.write(getWorkflowTemplate());
  },
});

const workflowValidateCommand = defineJsonCommand({
  meta: {
    name: "validate",
    description: "Validate a workflow markdown file or ref and print any errors",
  },
  args: {
    target: {
      type: "positional",
      description: "Workflow ref (workflow:<name>) or filesystem path to a workflow .md",
      required: true,
    },
  },
  async run({ args }) {
    const filePath = await resolveWorkflowFilePath(args.target);
    const { parse } = validateWorkflowSource(filePath);
    if (parse.ok) {
      output("workflow-validate", {
        ok: true,
        path: filePath,
        title: parse.document.title,
        stepCount: parse.document.steps.length,
      });
      return;
    }
    throw new UsageError(formatWorkflowErrors(filePath, parse.errors));
  },
});

async function resolveWorkflowFilePath(target: string): Promise<string> {
  if (!target.startsWith("workflow:")) return target;
  const parsed = parseAssetRef(target);
  if (parsed.type !== "workflow") {
    throw new UsageError(`Expected a workflow ref (workflow:<name>), got "${target}".`);
  }
  const config = loadConfig();
  const allSources = resolveSourceEntries(undefined, config);
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);
  for (const source of searchSources) {
    try {
      return await resolveAssetPath(source.path, "workflow", parsed.name);
    } catch {
      /* try next source */
    }
  }
  throw new UsageError(`Workflow not found for ref: workflow:${parsed.name}`);
}

const workflowResumeCommand = defineJsonCommand({
  meta: {
    name: "resume",
    description: "Resume a blocked or failed workflow run, flipping it back to active",
  },
  args: {
    runId: { type: "positional", description: "Workflow run id", required: true },
  },
  async run({ args }) {
    const result = await resumeWorkflowRun(args.runId);
    output("workflow-resume", result);
  },
});

export const workflowCommand = defineCommand({
  meta: {
    name: "workflow",
    description: "Author, inspect, and execute step-by-step workflow assets",
  },
  subCommands: {
    start: workflowStartCommand,
    next: workflowNextCommand,
    complete: workflowCompleteCommand,
    status: workflowStatusCommand,
    list: workflowListCommand,
    create: workflowCreateCommand,
    template: workflowTemplateCommand,
    resume: workflowResumeCommand,
    validate: workflowValidateCommand,
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (hasWorkflowSubcommand(args)) return;
      output("workflow-list", await listWorkflowRuns({ activeOnly: true }));
    });
  },
});
