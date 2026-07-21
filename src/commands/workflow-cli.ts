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
import { getParsedInvocation } from "../cli/invocation";
import { getStringArg } from "../cli/parse-args";
import { defineJsonCommand, output, runWithJsonErrors } from "../cli/shared";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "../core/asset/asset-create";
import { parseRefInput } from "../core/asset/resolve-ref";
import { loadConfig } from "../core/config/config";
import { NotFoundError, UsageError } from "../core/errors";
import { akmIndex } from "../indexer/indexer";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
import { resolveAssetPath } from "../sources/resolve";
import {
  createWorkflowAsset,
  formatWorkflowErrors,
  getWorkflowProgramTemplate,
  getWorkflowTemplate,
  validateWorkflowProgramSource,
  validateWorkflowSource,
} from "../workflows/authoring/authoring";
import {
  hasWorkflowSubcommand,
  parseWorkflowJsonObject,
  parseWorkflowStepState,
  WORKFLOW_STEP_STATES,
} from "../workflows/cli";
import { isWorkflowProgramPath } from "../workflows/program/project";
import {
  abandonWorkflowRun,
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
    // --help). The guard reads it straight from the invocation singleton so
    // existing callers still get a clear, actionable error instead of a
    // generic "unknown flag" from citty.
    if (getParsedInvocation().hasFlag("--dry-run")) {
      throw new UsageError(
        "`akm workflow next` does not support --dry-run. Remove the flag to start or resume a run.",
        "INVALID_FLAG_VALUE",
      );
    }
    const parsedParams = args.params ? parseWorkflowJsonObject(args.params, "--params") : undefined;
    // If the target looks like a UUID-style run id (no `:` and matches the
    // run-id shape), short-circuit with a structured WORKFLOW_NOT_FOUND
    // error before the ref parser throws an unhelpful ref-parse error.
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
 * error than the ref parser's "Invalid asset type" failure.
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
    units: {
      type: "boolean",
      description:
        "Also list per-unit rows from the run journal (unit id, status, failure_reason, and any result/error " +
        "diagnostic text). Diagnostics only — step evidence stays deterministic and is unaffected (#22).",
      default: false,
    },
  },
  async run({ args }) {
    const target = args.target;
    const includeUnits = args.units === true;
    // Check if target looks like a workflow ref
    const parsed = (() => {
      try {
        return parseRefInput(target);
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
      const result = await getWorkflowStatus(mostRecent.id, { includeUnits });
      output("workflow-status", result);
    } else {
      const result = await getWorkflowStatus(target, { includeUnits });
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
    description:
      "Create a workflow in the working stash (markdown document by default; a .yaml/.yml name writes a YAML program)",
  },
  args: {
    name: {
      type: "positional",
      description:
        "Workflow name (flat, no '/'; use --path for a subdirectory). A .yaml/.yml suffix creates a YAML program.",
      required: true,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under workflows/ to place the workflow in (e.g. 'release'). The filename comes from the name.",
    },
    from: {
      type: "string",
      description: "Import and validate content from an existing file (parsed per the destination extension)",
    },
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
    description: "Print a valid workflow template (markdown by default, --yaml for a YAML program)",
  },
  args: {
    yaml: {
      type: "boolean",
      description: "Print a minimal valid YAML workflow program instead of the markdown template",
      default: false,
    },
  },
  run({ args }) {
    process.stdout.write(args.yaml ? getWorkflowProgramTemplate() : getWorkflowTemplate());
  },
});

const workflowValidateCommand = defineJsonCommand({
  meta: {
    name: "validate",
    description: "Validate a workflow file or ref (markdown document or YAML program) and print any errors",
  },
  args: {
    target: {
      type: "positional",
      description: "Workflow ref (workflow:<name>) or filesystem path to a workflow .md/.yaml",
      required: true,
    },
  },
  async run({ args }) {
    const filePath = await resolveWorkflowFilePath(args.target);
    // YAML programs (redesign addendum, R1) validate through the program
    // parser AND compiler so expression/reference errors surface at lint
    // time; both error lists carry line numbers. Markdown is unchanged.
    if (isWorkflowProgramPath(filePath)) {
      const { result } = validateWorkflowProgramSource(filePath);
      if (!result.ok) {
        throw new UsageError(formatWorkflowErrors(filePath, result.errors));
      }
      // Non-fatal WARNINGS ride the envelope additively — `ok` stays true. The
      // text formatter renders them clearly marked for humans; the JSON key is
      // the machine channel. Empty array when the program is fully typed/declared.
      output("workflow-validate", {
        ok: true,
        path: filePath,
        format: "program",
        title: result.program.name,
        stepCount: result.program.steps.length,
        warnings: result.warnings.map((w) => ({ line: w.line, message: w.message })),
      });
      return;
    }
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
  // A bare (`workflow:<name>`) OR origin-qualified (`<origin>//workflow:<name>`)
  // ref resolves through the source search, exactly like `workflow start` /
  // `status` / `next`. Anything else is treated as a filesystem path. Detecting
  // the origin-qualified form here (not just the bare prefix) keeps `validate`'s
  // ref contract in lockstep with the rest of the workflow command family — an
  // `extra//workflow:foo` ref validates the file that `extra//workflow:foo`
  // starts, rather than being mistaken for a relative path that does not exist.
  // DOCUMENTED EXCEPTION (ref-grammar decision D-R3 migration window): the two
  // legacy `workflow:` sniffs survive ONLY as pre-Chunk-8 durable-row tolerance,
  // classifying an old-spelled ref as a ref (not a path) so it routes through the
  // resolver rather than being mistaken for a relative path. Input-side only;
  // remove the legacy arms at the 0.10.0 grammar removal.
  const looksLikeWorkflowRef =
    target.startsWith("workflow:") ||
    target.includes("//workflow:") ||
    target.startsWith("workflows/") ||
    target.includes("//workflows/");
  if (!looksLikeWorkflowRef) return target;
  const parsed = parseRefInput(target);
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

const workflowRunCommand = defineJsonCommand({
  meta: {
    name: "run",
    description:
      "EXPERIMENTAL: execute a workflow's steps with the native engine — akm dispatches each step's units " +
      "(fan-out, schema output) to the configured runner and advances the run through the normal completion gates",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref (auto-starts a run)", required: true },
    params: { type: "string", description: "Workflow parameters as a JSON object (only for auto-started runs)" },
    "max-steps": { type: "string", description: "Stop after executing this many steps" },
    "require-gates": {
      type: "boolean",
      description:
        "Treat every criteria-bearing completion gate as required: if no LLM judge is available, BLOCK the step " +
        "(for a human to resolve via `akm workflow resume`) instead of failing open. A per-step `gate.required: true` " +
        "in the workflow does the same on every surface; this is the run-wide override (#18).",
      default: false,
    },
  },
  async run({ args }) {
    const { runWorkflowSteps } = await import("../workflows/exec/run-workflow.js");
    const rawMaxSteps = getStringArg(args, "max-steps");
    let maxSteps: number | undefined;
    if (rawMaxSteps !== undefined) {
      maxSteps = Number.parseInt(rawMaxSteps, 10);
      if (!/^\d+$/.test(rawMaxSteps) || maxSteps <= 0) {
        throw new UsageError(`--max-steps must be a positive integer, got "${rawMaxSteps}".`, "INVALID_FLAG_VALUE");
      }
    }
    const result = await runWorkflowSteps({
      target: args.target,
      ...(args.params ? { params: parseWorkflowJsonObject(args.params, "--params") } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(args["require-gates"] === true ? { requireGates: true } : {}),
    });
    output("workflow-run", result);
  },
});

const workflowBriefCommand = defineJsonCommand({
  meta: {
    name: "brief",
    description:
      "EXPERIMENTAL: describe a run's active step as an executable work-list for ANY agent session (the " +
      "harness-neutral driver protocol) — read-only, takes no engine lease, mutates nothing; prints per-unit " +
      "instructions, output schema, env binding names, and the exact `akm workflow report` command lines",
  },
  args: {
    target: {
      type: "positional",
      description: "Workflow run id (or a workflow ref with an active run)",
      required: true,
    },
  },
  async run({ args }) {
    const { buildWorkflowBrief } = await import("../workflows/exec/brief.js");
    const result = await buildWorkflowBrief(args.target);
    output("workflow-brief", result);
  },
});

const WORKFLOW_REPORT_STATES = ["completed", "failed", "running"] as const;
type WorkflowReportStatus = (typeof WORKFLOW_REPORT_STATES)[number];

const workflowReportCommand = defineJsonCommand({
  meta: {
    name: "report",
    description:
      "EXPERIMENTAL: report a unit's result back into a run (the mutating half of the harness-neutral driver " +
      "protocol) — ingested through the SAME shared step semantics the engine uses. --status running claims/" +
      "heartbeats a unit; completed/failed records it and, when the step's work-list is fully terminal, runs the " +
      "engine's completion path (reducer, artifact + schema validation, gate). --settle (no --unit) advances a run " +
      "parked on a route-only/empty step. Refused while a live engine lease exists",
  },
  args: {
    target: {
      type: "positional",
      description: "Workflow run id (or a workflow ref with an active run)",
      required: true,
    },
    unit: {
      type: "string",
      description: "Content-derived unit id from `akm workflow brief` (copy it verbatim). Omit with --settle.",
    },
    settle: {
      type: "boolean",
      description:
        "Advance/finalize a run whose active step has NO unit left to report: a non-dispatching step (params-based route, empty fan-out, all-unresolvable) OR a fully-terminal step still needing finalization (every unit ran but the gate never judged — e.g. after resuming a required-gate block). Runs the deterministic completion path. Mutually exclusive with --unit; refused when the step still has genuinely pending units",
      default: false,
    },
    "expect-step": {
      type: "string",
      description:
        "Guard: the step id you briefed against. Refuses the report if the run's active step has since moved (from the `brief` report/settle command line)",
    },
    status: { type: "string", description: `Unit status: ${WORKFLOW_REPORT_STATES.join(", ")}` },
    result: { type: "string", description: "Result payload (JSON for a schema unit, else text). completed only." },
    "result-file": { type: "string", description: "Read the result payload from this file instead of --result/stdin" },
    tokens: { type: "string", description: "Tokens spent on this unit (counts against a declared budget)" },
    "session-id": { type: "string", description: "Harness-native session id revealed while executing the unit" },
    "failure-reason": { type: "string", description: "Structured failure vocabulary for a --status failed report" },
    note: { type: "string", description: "Short progress note for a --status running heartbeat (not persisted)" },
    rerun: {
      type: "boolean",
      description:
        "Re-run an already-FAILED unit: record a NEW attempt (re-applies budget) instead of refusing a differing re-report",
      default: false,
    },
  },
  async run({ args }) {
    // --settle: the unit-less verb that advances a run parked on a
    // non-dispatching step. Mutually exclusive with the per-unit report flags.
    if (args.settle === true) {
      if (getStringArg(args, "unit") !== undefined || getStringArg(args, "status") !== undefined) {
        throw new UsageError(
          "--settle advances a route-only/empty step and takes no --unit or --status. Drop them, or report a " +
            "specific unit with `--unit <id> --status <state>` instead.",
          "INVALID_FLAG_VALUE",
        );
      }
      const { settleWorkflowSpine } = await import("../workflows/exec/report.js");
      const result = await settleWorkflowSpine({
        target: args.target,
        ...(getStringArg(args, "expect-step") !== undefined ? { expectStep: getStringArg(args, "expect-step") } : {}),
      });
      output("workflow-report", result);
      return;
    }

    const status = args.status as string;
    if (!status) {
      throw new UsageError(
        "--status is required (completed | failed | running), or pass --settle to advance a non-dispatching step.",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    if (!WORKFLOW_REPORT_STATES.includes(status as WorkflowReportStatus)) {
      throw new UsageError(
        `Invalid --status "${status}". Expected one of: ${WORKFLOW_REPORT_STATES.join(", ")}.`,
        "INVALID_FLAG_VALUE",
      );
    }
    const unitId = getStringArg(args, "unit");
    if (!unitId) {
      throw new UsageError(
        "--unit is required (the content-derived unit id from `akm workflow brief`), or pass --settle for a route-only/empty step.",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }

    let tokens: number | undefined;
    const rawTokens = getStringArg(args, "tokens");
    if (rawTokens !== undefined) {
      tokens = Number.parseInt(rawTokens, 10);
      if (!/^\d+$/.test(rawTokens)) {
        throw new UsageError(`--tokens must be a non-negative integer, got "${rawTokens}".`, "INVALID_FLAG_VALUE");
      }
    }

    // Result payload precedence: --result, then --result-file, then stdin
    // (completed/failed only; a running heartbeat carries no result).
    let resultRaw: string | undefined;
    if (status !== "running") {
      const resultFile = getStringArg(args, "result-file");
      if (args.result !== undefined && resultFile !== undefined) {
        throw new UsageError("Pass at most one of --result or --result-file.", "INVALID_FLAG_VALUE");
      }
      if (args.result !== undefined) {
        resultRaw = String(args.result);
      } else if (resultFile !== undefined) {
        const fs = await import("node:fs");
        resultRaw = fs.readFileSync(resultFile, "utf8");
      } else if (!process.stdin.isTTY) {
        resultRaw = await readStdin();
      }
    }

    const { reportWorkflowUnit } = await import("../workflows/exec/report.js");
    const result = await reportWorkflowUnit({
      target: args.target,
      unitId,
      status: status as WorkflowReportStatus,
      ...(getStringArg(args, "expect-step") !== undefined ? { expectStep: getStringArg(args, "expect-step") } : {}),
      ...(resultRaw !== undefined ? { resultRaw } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(args.rerun === true ? { rerun: true } : {}),
      ...(getStringArg(args, "session-id") !== undefined ? { sessionId: getStringArg(args, "session-id") } : {}),
      ...(getStringArg(args, "failure-reason") !== undefined
        ? { failureReason: getStringArg(args, "failure-reason") }
        : {}),
      ...(getStringArg(args, "note") !== undefined ? { note: getStringArg(args, "note") } : {}),
    });
    output("workflow-report", result);
  },
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const workflowWatchCommand = defineJsonCommand({
  meta: {
    name: "watch",
    description:
      "Print a run's workflow_* events (state.db events table) as NDJSON and exit; --stream polls in the " +
      "foreground until the run reaches a terminal status (no daemon)",
  },
  args: {
    runId: { type: "positional", description: "Workflow run id", required: true },
    stream: {
      type: "boolean",
      description: "Keep polling for new events until the run leaves 'active' (completed/failed/blocked)",
      default: false,
    },
    "interval-ms": { type: "string", description: "Poll interval in milliseconds for --stream (default: 1000)" },
  },
  async run({ args }) {
    const rawInterval = getStringArg(args, "interval-ms");
    let intervalMs: number | undefined;
    if (rawInterval !== undefined) {
      intervalMs = Number.parseInt(rawInterval, 10);
      if (!/^\d+$/.test(rawInterval) || intervalMs <= 0) {
        throw new UsageError(`--interval-ms must be a positive integer, got "${rawInterval}".`, "INVALID_FLAG_VALUE");
      }
    }
    const { watchWorkflowRun } = await import("../workflows/exec/watch.js");
    const result = await watchWorkflowRun({
      runId: args.runId,
      stream: args.stream === true,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
    });
    // The event lines above are raw NDJSON on stdout; this trailing envelope
    // is the machine-readable command result (counts + terminal status).
    output("workflow-watch", { ok: true, ...result });
  },
});

const workflowAbandonCommand = defineJsonCommand({
  meta: {
    name: "abandon",
    description: "Give up on a workflow run: mark it failed so it stops counting as active (resume can reopen it)",
  },
  args: {
    runId: { type: "positional", description: "Workflow run id", required: true },
  },
  async run({ args }) {
    const result = await abandonWorkflowRun(args.runId);
    output("workflow-abandon", result);
  },
});

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
    abandon: workflowAbandonCommand,
    validate: workflowValidateCommand,
    run: workflowRunCommand,
    brief: workflowBriefCommand,
    report: workflowReportCommand,
    watch: workflowWatchCommand,
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (hasWorkflowSubcommand(args)) return;
      output("workflow-list", await listWorkflowRuns({ activeOnly: true }));
    });
  },
});
