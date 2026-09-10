// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow` command family. `run` is the canonical start/resume/execute
 * surface; the former public `start`, `next`, and `complete` lifecycle is gone.
 * `create --print` emits Markdown; execution accepts peer `.md` and
 * GitHub-shaped `.yml` workflow sources. Validate with `akm lint --type workflows`.
 */

import { getStringArg } from "../cli/parse-args";
import { defineGroupCommand, defineJsonCommand, EXIT_CODES, output, outputWithExitCode } from "../cli/shared";
import { armAbortDeadline } from "../core/abort-deadline";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "../core/asset/asset-create";
import { NotFoundError, TransientError, type TransientErrorCode, UsageError } from "../core/errors";
import { warn } from "../core/warn";
import { akmIndex } from "../indexer/indexer";
import { assertWorkflowMarkdownName, createWorkflowAsset, getWorkflowTemplate } from "../workflows/authoring/authoring";
import type { WorkflowParameterFlag } from "../workflows/ir/params";
import { WORKFLOW_MAX_TIMEOUT_MS } from "../workflows/ir/schema";
import {
  abandonWorkflowRun,
  getWorkflowStatus,
  listWorkflowRuns,
  resolveWorkflowRunTarget,
  resumeWorkflowRun,
} from "../workflows/runtime/runs";
import { akmWorkflowPlan } from "./workflow/plan";

const workflowStatusCommand = defineJsonCommand({
  meta: {
    name: "status",
    description: "Show full workflow run state for review or resume; workflow refs resolve within the current scope",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref (workflows/<name>)", required: true },
    units: {
      type: "boolean",
      description:
        "Also list per-unit rows from the run journal (unit id, status, failure_reason, and any result/error " +
        "diagnostic text). Diagnostics only — step evidence stays deterministic and is unaffected.",
      default: false,
    },
    "all-scopes": {
      type: "boolean",
      description:
        "When resolving a workflow ref (not a run id), search every scope instead of only the current one (#942).",
      default: false,
    },
  },
  async run({ args }) {
    const target = args.target;
    const includeUnits = args.units === true;
    const allScopes = args["all-scopes"] === true;
    const resolvedRunId = await resolveWorkflowRunTarget(target);
    if (resolvedRunId !== undefined) {
      const result = await getWorkflowStatus(resolvedRunId, { includeUnits });
      output("workflow-status", result);
      return;
    }
    let runs: Awaited<ReturnType<typeof listWorkflowRuns>>["runs"];
    let scopeKey: Awaited<ReturnType<typeof listWorkflowRuns>>["scopeKey"];
    try {
      ({ runs, scopeKey } = await listWorkflowRuns({ workflowRef: target, allScopes }));
    } catch (error) {
      if (!target.includes(":") && !target.includes("/")) {
        throw new NotFoundError(`Workflow run "${target}" not found.`, "WORKFLOW_NOT_FOUND");
      }
      throw error;
    }
    const mostRecent = runs[0];
    if (!mostRecent) {
      // #942: name the scope actually searched and point at `--all-scopes`
      // rather than a bare "not found" — the ref-fallthrough lookup is
      // scope-local by default, so "no runs" here means "none in THIS
      // scope", not "none anywhere". Already searching every scope (or no
      // real scope was filtered on) has nothing more specific to suggest.
      if (!allScopes && scopeKey !== null) {
        throw new NotFoundError(
          `No workflow runs found for ${target} in scope ${scopeKey}.`,
          "WORKFLOW_NOT_FOUND",
          `Run 'akm workflow status ${target} --all-scopes' to search every scope.`,
        );
      }
      throw new NotFoundError(`No workflow runs found for ${target}`, "WORKFLOW_NOT_FOUND");
    }
    const result = await getWorkflowStatus(mostRecent.id, { includeUnits });
    output("workflow-status", result);
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
    children: {
      type: "boolean",
      description: "Also include child workflow runs (hidden by default, P3b)",
      default: false,
    },
    "all-scopes": {
      type: "boolean",
      description:
        "Search every scope instead of only the current one (#942). The envelope's top-level `scopeKey` is " +
        "`null` with this flag, otherwise the scope that was searched — so an empty `runs: []` is never " +
        'indistinguishable from "nothing anywhere".',
      default: false,
    },
  },
  async run({ args }) {
    const result = await listWorkflowRuns({
      workflowRef: args.ref,
      activeOnly: args.active,
      includeChildren: args.children,
      allScopes: args["all-scopes"],
    });
    output("workflow-list", result);
  },
});

const workflowCreateCommand = defineJsonCommand({
  meta: {
    name: "create",
    description: "Create a workflow (markdown document) in the working bundle",
  },
  args: {
    name: {
      type: "positional",
      description: "Workflow name (flat, no '/'; use --path for a subdirectory).",
      required: true,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under workflows/ to place the workflow in (e.g. 'release'). The filename comes from the name.",
    },
    from: {
      type: "string",
      description: "Import and validate content from an existing file",
    },
    force: {
      type: "boolean",
      description:
        "Overwrite an existing workflow. Combined with --from, replaces its content; alone, replaces it with a fresh template.",
      default: false,
    },
    reset: {
      type: "boolean",
      description: "Deprecated alias for --force with no --from (replaces an existing workflow with a fresh template).",
      default: false,
    },
    print: {
      type: "boolean",
      description:
        "Print the RAW template that would be written to stdout without creating anything — pipe it to a file as a starter document",
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
    assertWorkflowMarkdownName(effectiveName);
    if (args.print) {
      // Raw document, not an envelope — the retired `workflow template` was
      // format-exempt for the same reason: `--print > starter.md` must yield
      // a usable starter file, not `{ok,template,kind}` JSON.
      process.stdout.write(getWorkflowTemplate());
      return;
    }
    const result = createWorkflowAsset({
      name: effectiveName,
      from: args.from,
      force: args.force,
    });
    // Index the newly-written workflow so `akm workflow run` can resolve
    // a workflowEntryId without requiring an explicit `akm index` call
    // first. Uses the same incremental index path that `akm add` uses.
    // `result.bundleDir` — the indexer's own `IndexOptions.stashDir` field
    // name is unchanged (indexer vocabulary is out of scope, P4 row B-50).
    await akmIndex({ stashDir: result.bundleDir });
    output("workflow-create", { ok: true, ...result });
  },
});

/**
 * `--skip-if-locked` (#948) eligibility: only these two named, retryable
 * `TransientError` codes (#948 addendum — moved off UsageError, exit 75) turn
 * a `workflow run` failure into a graceful skip — `RUN_LEASE_HELD` (another
 * engine invocation is driving THIS run, `workflow-runs-repository.ts`'s
 * single-driver lease) and `STATE_DB_CONTENDED` (an unrelated akm process is
 * writing state.db right now, `core/state-db.ts`'s BEGIN IMMEDIATE retry
 * exhaustion). Every other error — a bad flag, an unresolvable target —
 * still fails loudly.
 */
const WORKFLOW_RUN_SKIP_REASONS: Partial<Record<TransientErrorCode, "lock-held" | "state-db-contended">> = {
  RUN_LEASE_HELD: "lock-held",
  STATE_DB_CONTENDED: "state-db-contended",
};

const workflowRunCommand = defineJsonCommand({
  meta: {
    name: "run",
    description:
      "Start or resume a workflow and execute it through completion, failure, a verification gate, or an explicit limit",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref (auto-starts a run)", required: true },
    "max-steps": { type: "string", description: "Stop after executing this many steps" },
    "max-retries": { type: "string", description: "Retry a failed workflow step this many additional times" },
    timeout: { type: "string", description: "Whole-run timeout: N, Nms, Ns, or Nm (bare N is milliseconds)" },
    new: {
      type: "boolean",
      description:
        "Start a fresh run even if one is already active for this ref, leaving the existing run untouched " +
        "(never abandons it). A workflow ref only — passing a run id with --new is a usage error.",
      default: false,
    },
    "skip-if-locked": {
      type: "boolean",
      description:
        "If another akm process already holds this run's engine lease, or state.db is busy with another " +
        "writer, skip gracefully (exit 0) instead of failing (exit 75). Use for high-frequency scheduled runs " +
        "so they don't pile up failures while a longer-running invocation is in progress.",
      default: false,
    },
  },
  async run({ args, rawArgs }) {
    const { runWorkflowSteps } = await import("../workflows/exec/run-workflow.js");
    const parameterFlags = parseWorkflowParameterFlags(rawArgs, args.target);
    const maxSteps = parseIntegerFlag(getStringArg(args, "max-steps"), "--max-steps", 1);
    const maxRetries = parseIntegerFlag(getStringArg(args, "max-retries"), "--max-retries", 0);
    const timeoutMs = parseWorkflowTimeout(getStringArg(args, "timeout"));
    const skipIfLocked = args["skip-if-locked"];
    const controller = new AbortController();
    let signalExitCode: number | undefined;
    const interrupt = (signal: "SIGINT" | "SIGTERM") => {
      signalExitCode = signal === "SIGINT" ? 130 : 143;
      controller.abort(new Error(`Workflow run interrupted by ${signal}.`));
    };
    const onSigint = () => interrupt("SIGINT");
    const onSigterm = () => interrupt("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    // The same deadline a scheduled workflow task arms (`tasks/runner.ts`),
    // sharing this controller with the signal handlers above.
    const deadline = armAbortDeadline(controller, {
      timeoutMs,
      reason: `Workflow run timed out after ${timeoutMs}ms.`,
    });
    try {
      let result: Awaited<ReturnType<typeof runWorkflowSteps>>;
      try {
        result = await runWorkflowSteps({
          target: args.target,
          parameterFlags,
          ...(maxSteps !== undefined ? { maxSteps } : {}),
          ...(maxRetries !== undefined ? { maxRetries } : {}),
          newRun: args.new,
          signal: controller.signal,
        });
      } catch (err) {
        // #948: `--skip-if-locked` extends improve's "another run already
        // holds this" skip semantics to `workflow run`. Only these two named,
        // retryable TransientError codes are eligible (#948 addendum — moved
        // off UsageError) — a bad flag or malformed input still fails loudly
        // even with the flag set.
        if (skipIfLocked && err instanceof TransientError && WORKFLOW_RUN_SKIP_REASONS[err.code]) {
          const reason = WORKFLOW_RUN_SKIP_REASONS[err.code];
          warn(`[workflow] ${err.message} skipping (--skip-if-locked)`);
          output("workflow-run", { ok: true, target: args.target, skipped: { reason, message: err.message } });
          return;
        }
        throw err;
      }
      // The abort is observed between steps, so a deadline landing in the run's
      // final bookkeeping fires on a run that then finishes. Reporting that as
      // timed out would send an operator to resume a run with nothing left to
      // resume — `tasks/runner.ts` suppresses the same case.
      const timedOut = deadline.timedOut() && result.run.status !== "completed";
      // `blocked` is a stopped, unverified run — a verification-judge failure
      // leaves it there for `akm workflow resume` — so it must not exit 0 and
      // read as success to a script (it maps to 1 for scheduled tasks too).
      const failed =
        result.run.status === "failed" || result.run.status === "blocked" || result.gateRejection || result.aborted;
      outputWithExitCode(
        "workflow-run",
        { ...result, ...(timedOut ? { timedOut: true as const } : {}) },
        failed ? (signalExitCode ?? EXIT_CODES.GENERAL) : undefined,
      );
    } finally {
      deadline.disarm();
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  },
});

const WORKFLOW_RUN_VALUE_FLAGS = new Set([
  "max-steps",
  "maxSteps",
  "max-retries",
  "maxRetries",
  "timeout",
  "format",
  "detail",
  "shape",
  "output",
]);
const WORKFLOW_RUN_BOOLEAN_FLAGS = new Set([
  "quiet",
  "verbose",
  "help",
  "no-quiet",
  "no-verbose",
  "new",
  "no-new",
  "skip-if-locked",
  "no-skip-if-locked",
]);

export function parseWorkflowParameterFlags(rawArgs: readonly string[], target: string): WorkflowParameterFlag[] {
  const flags: WorkflowParameterFlag[] = [];
  let targetSeen = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index] as string;
    if (token === "--") {
      throw new UsageError("`akm workflow run` does not accept positional arguments after `--`.", "INVALID_FLAG_VALUE");
    }
    if (!token.startsWith("-") || token === "-" || /^-\d/.test(token)) {
      if (!targetSeen) {
        if (token !== target) {
          throw new UsageError(
            "Workflow parameter flags must come after the workflow ref or run id.",
            "INVALID_FLAG_VALUE",
          );
        }
        targetSeen = true;
        continue;
      }
      throw new UsageError(`Unexpected positional workflow argument "${token}".`, "INVALID_FLAG_VALUE");
    }
    if (!token.startsWith("--")) continue;

    const body = token.slice(2);
    const equalsAt = body.indexOf("=");
    const name = equalsAt === -1 ? body : body.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? undefined : body.slice(equalsAt + 1);
    if (name === "params") {
      throw new UsageError(
        "--params was removed. Pass each declared workflow parameter as its own flag, for example `--version=1.2.3`.",
        "INVALID_FLAG_VALUE",
      );
    }
    if (WORKFLOW_RUN_VALUE_FLAGS.has(name)) {
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (WORKFLOW_RUN_BOOLEAN_FLAGS.has(name)) continue;
    if (!targetSeen) {
      throw new UsageError(
        "Workflow parameter flags must come after the workflow ref or run id.",
        "INVALID_FLAG_VALUE",
      );
    }

    if (inlineValue !== undefined) {
      flags.push({ name, value: inlineValue });
      continue;
    }
    const next = rawArgs[index + 1];
    if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
      flags.push({ name, value: next });
      index += 1;
    } else {
      flags.push({ name, value: true });
    }
  }
  return flags;
}

function parseIntegerFlag(
  raw: string | undefined,
  name: string,
  minimum: number,
  maximum?: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || value < minimum || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? `at least ${minimum}` : `from ${minimum} through ${maximum}`;
    throw new UsageError(`${name} must be an integer ${range}, got "${raw}".`, "INVALID_FLAG_VALUE");
  }
  return value;
}

function parseWorkflowTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(ms|s|m)?$/.exec(raw);
  if (!match) {
    throw new UsageError(`--timeout must be N, Nms, Ns, or Nm, got "${raw}".`, "INVALID_FLAG_VALUE");
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const timeoutMs = amount * multiplier;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKFLOW_MAX_TIMEOUT_MS) {
    throw new UsageError(
      `--timeout must resolve to 1 through ${WORKFLOW_MAX_TIMEOUT_MS} milliseconds, got "${raw}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  return timeoutMs;
}

// P3b Lane B (spec docs/plans/specs/p3b-child-executor.md §4.6): read-only
// compile+freeze introspection — zero durable writes, zero usage/event rows
// (row B-48). `--json` is deliberately NOT a flag anywhere in this CLI
// (B-N9); the global `--format json` is spliced on by `defineJsonCommand`.
const workflowPlanCommand = defineJsonCommand({
  meta: {
    name: "plan",
    description:
      "Compile and freeze a workflow WITHOUT publishing it: the canonical step graph, per-step frozen target " +
      "kinds, task/child expansion, input bindings, source read set, and lowering notices. Zero durable writes.",
  },
  args: {
    ref: { type: "positional", description: "Workflow ref (workflows/<name>)", required: true },
  },
  async run({ args }) {
    const result = await akmWorkflowPlan(args.ref);
    // json-by-default, like every other verb (#903). This used to default to
    // the human summary, which cost ~60 lines of branch: `args.format` cannot
    // detect "no format named" (citty parses per level, so a global
    // pre-subcommand `--format json` is eaten by the ROOT command and the leaf
    // reads undefined), so it had to route through `getParsedInvocation()`,
    // then fold in a persisted `output.format`, and then still leave a
    // resolved "json" on the text branch because that is indistinguishable
    // from "nothing configured". The last compromise meant an explicit
    // `--format json` silently did nothing for anyone whose config already
    // resolved to json. `--format text` still renders the summary through the
    // registered formatter; it is just no longer the unmarked default.
    output("workflow-plan", result);
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

export const workflowCommand = defineGroupCommand({
  meta: {
    name: "workflow",
    description: "Author, inspect, and execute step-by-step workflow assets",
  },
  subCommands: {
    status: workflowStatusCommand,
    list: workflowListCommand,
    create: workflowCreateCommand,
    resume: workflowResumeCommand,
    abandon: workflowAbandonCommand,
    run: workflowRunCommand,
    plan: workflowPlanCommand,
  },
  // No `defaultRun`: bare `akm workflow` is a usage error (exit 2), the
  // canonical bare-group behavior — owner ruling 12. Run `akm workflow list
  // --active` for what the bare form used to print. This group was previously
  // hand-rolled on `defineCommand` with its own `hasWorkflowSubcommand` guard,
  // which duplicated the subcommand names in a second hand-maintained set;
  // `defineGroupCommand` derives the guard from `subCommands` directly.
});
