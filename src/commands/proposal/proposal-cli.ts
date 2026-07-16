// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm proposal` command family (#225). Extracted verbatim from src/cli.ts
 * (WS6) so the God Module shrinks; the `main.subCommands.proposal` key and
 * every subcommand's args/output shape are byte-identical. Leaf handlers are
 * migrated to `defineJsonCommand`, which wraps the body in `runWithJsonErrors`
 * and emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * `runWithJsonErrors` form it replaces.
 */

import { parsePositiveIntFlag } from "../../cli/parse-args";
import { defineGroupCommand, defineJsonCommand, output } from "../../cli/shared";
import { resolveStashDir } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { resolveTriageJudgmentRunner } from "../../integrations/agent/runner";
import { installLlmUsagePersistenceIfAbsent } from "../../llm/usage-persist";
import { withLlmStage } from "../../llm/usage-telemetry";
import { resolveImproveStrategy } from "../improve/improve-strategies";
import { drainProposals } from "./drain";
import { resolveDrainPolicy } from "./drain-policies";
import {
  akmProposalAccept,
  akmProposalDiff,
  akmProposalList,
  akmProposalReject,
  akmProposalRevert,
  akmProposalShow,
  bulkAdjudicateProposals,
} from "./proposal";

/**
 * Parse + validate the shared bulk-adjudication filter flags
 * (`--max-diff-lines`, `--older-than`). Extracted from the two verbatim
 * copies that lived in the accept and reject bulk branches (WI-6.6).
 */
function parseBulkFilterFlags(args: Record<string, unknown>): { maxDiffLines?: number; olderThanMs?: number } {
  const rawMaxDiff = args["max-diff-lines"] ? Number.parseInt(String(args["max-diff-lines"]), 10) : undefined;
  if (rawMaxDiff !== undefined && (Number.isNaN(rawMaxDiff) || rawMaxDiff < 0)) {
    throw new UsageError("--max-diff-lines must be a non-negative integer", "INVALID_FLAG_VALUE");
  }
  const rawOlderThan = args["older-than"] ? Number.parseInt(String(args["older-than"]), 10) : undefined;
  if (rawOlderThan !== undefined && (Number.isNaN(rawOlderThan) || rawOlderThan < 0)) {
    throw new UsageError("--older-than must be a non-negative integer (days)", "INVALID_FLAG_VALUE");
  }
  return {
    maxDiffLines: rawMaxDiff,
    olderThanMs: rawOlderThan !== undefined ? rawOlderThan * 86_400_000 : undefined,
  };
}

function parseProposalStatus(raw: string | undefined): "pending" | "accepted" | "rejected" | "reverted" | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed === "pending" || trimmed === "accepted" || trimmed === "rejected" || trimmed === "reverted") {
    return trimmed;
  }
  throw new UsageError(
    `Invalid --status value: "${raw}". Expected one of: pending, accepted, rejected, reverted.`,
    "INVALID_FLAG_VALUE",
  );
}

const proposalListCommand = defineJsonCommand({
  meta: { name: "list", description: "List proposal queue entries" },
  args: {
    status: {
      type: "string",
      description: "Filter by status (pending|accepted|rejected|reverted)",
    },
    ref: { type: "string", description: "Filter by asset ref (type:name)" },
    type: { type: "string", description: "Filter by asset type" },
  },
  run({ args }) {
    const status = parseProposalStatus(args.status);
    const result = akmProposalList({
      status,
      ref: args.ref,
      type: args.type,
      includeArchive: status === "accepted" || status === "rejected" || status === "reverted",
    });
    output("proposal-list", result);
  },
});

const proposalAcceptCommand = defineJsonCommand({
  meta: { name: "accept", description: "Accept a proposal and promote it into the stash" },
  args: {
    id: {
      type: "positional",
      description:
        "Proposal id (uuid / prefix) or asset ref (e.g. skill:akm-dream). Optional when --generator is provided.",
      required: false,
    },
    target: { type: "string", description: "Override the write target by source name" },
    // F-6 / #393: Batch accept by generator, diff size, or age.
    generator: {
      type: "string",
      description:
        "F-6: Bulk-accept all pending proposals from this generator (e.g. reflect, distill). Requires no positional id.",
    },
    "max-diff-lines": {
      type: "string",
      description:
        "F-6: When bulk-accepting, only accept proposals whose content is <= this many lines. Skips larger proposals.",
    },
    "older-than": {
      type: "string",
      description:
        "F-6: When bulk-accepting, only accept proposals created more than this many days ago (e.g. '7' for 7 days).",
    },
    "dry-run": {
      type: "boolean",
      description: "F-6: List proposals that would be bulk-accepted without accepting them.",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip confirmation prompt (required in non-interactive mode for bulk accept)",
      default: false,
    },
  },
  async run({ args }) {
    const generator = args.generator as string | undefined;
    // F-6 / #393: Bulk-accept when --generator is provided without a positional id.
    if (generator && !args.id) {
      const { confirmDestructive } = await import("../../cli/confirm.js");
      const confirmed = await confirmDestructive(
        `Bulk-accept all matching proposals from generator "${generator}"? This cannot be undone.`,
        { yes: args.yes === true || args["dry-run"] === true },
      );
      if (!confirmed) {
        process.stderr.write("Aborted.\n");
        return;
      }
      const { maxDiffLines, olderThanMs } = parseBulkFilterFlags(args);
      const { count, results } = await bulkAdjudicateProposals({
        action: "accept",
        generator,
        maxDiffLines,
        olderThanMs,
        dryRun: args["dry-run"] as boolean,
        target: args.target as string | undefined,
      });
      output("proposal-accept-batch", { accepted: count, results, dryRun: args["dry-run"] as boolean });
      return;
    }
    if (!args.id) {
      throw new UsageError(
        "Usage: akm proposal accept <id>  OR  akm proposal accept --generator <generator>",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    const result = await akmProposalAccept({ id: args.id as string, target: args.target as string | undefined });
    output("proposal-accept", result);
  },
});

const proposalRejectCommand = defineJsonCommand({
  meta: { name: "reject", description: "Reject a proposal and record the reason" },
  args: {
    id: {
      type: "positional",
      description:
        "Proposal id (uuid / prefix) or asset ref (e.g. skill:akm-dream). Optional when --generator is provided.",
      required: false,
    },
    reason: { type: "string", description: "Reason for rejection (required)" },
    // F-6 / #393: Batch reject by generator, diff size, or age.
    generator: {
      type: "string",
      description:
        "F-6: Bulk-reject all pending proposals from this generator (e.g. reflect, distill). Requires no positional id.",
    },
    "max-diff-lines": {
      type: "string",
      description:
        "F-6: When bulk-rejecting, only reject proposals whose content is <= this many lines. Skips larger proposals.",
    },
    "older-than": {
      type: "string",
      description:
        "F-6: When bulk-rejecting, only reject proposals created more than this many days ago (e.g. '7' for 7 days).",
    },
    "dry-run": {
      type: "boolean",
      description: "F-6: List proposals that would be bulk-rejected without rejecting them.",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip confirmation prompt (required in non-interactive mode)",
      default: false,
    },
  },
  async run({ args }) {
    const generator = args.generator as string | undefined;
    if (!args.reason || !String(args.reason).trim()) {
      throw new UsageError(
        "Usage: akm proposal reject <id> --reason '<reason>'  OR  akm proposal reject --generator <generator> --reason '<reason>'",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    // F-6 / #393: Bulk-reject when --generator is provided without a positional id.
    if (generator && !args.id) {
      const { confirmDestructive } = await import("../../cli/confirm.js");
      const confirmed = await confirmDestructive(
        `Bulk-reject all matching proposals from generator "${generator}"? This cannot be undone.`,
        { yes: args.yes === true || args["dry-run"] === true },
      );
      if (!confirmed) {
        process.stderr.write("Aborted.\n");
        return;
      }
      const { maxDiffLines, olderThanMs } = parseBulkFilterFlags(args);
      const { count, results } = await bulkAdjudicateProposals({
        action: "reject",
        generator,
        maxDiffLines,
        olderThanMs,
        dryRun: args["dry-run"] as boolean,
        reason: String(args.reason),
      });
      output("proposal-reject-batch", { rejected: count, results, dryRun: args["dry-run"] as boolean });
      return;
    }
    if (!args.id) {
      throw new UsageError(
        "Usage: akm proposal reject <id> --reason '<reason>'  OR  akm proposal reject --generator <generator> --reason '<reason>'",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    const { confirmDestructive } = await import("../../cli/confirm.js");
    const confirmed = await confirmDestructive(`Reject proposal "${args.id}"? This cannot be undone.`, {
      yes: args.yes === true,
    });
    if (!confirmed) {
      process.stderr.write("Aborted.\n");
      return;
    }
    const result = await akmProposalReject({ id: args.id as string, reason: String(args.reason) });
    output("proposal-reject", result);
  },
});

const proposalDiffCommand = defineJsonCommand({
  meta: { name: "diff", description: "Show the diff for a proposal (accepts full UUID, UUID prefix, or asset ref)" },
  args: {
    id: {
      type: "positional",
      description: "Proposal id (uuid / prefix) or asset ref (e.g. skill:akm-dream)",
      required: true,
    },
    target: { type: "string", description: "Override the write target by source name" },
  },
  run({ args }) {
    const result = akmProposalDiff({ id: args.id, target: args.target });
    output("proposal-diff", result);
  },
});

// Phase 6C (Advantage D6c): revert an accepted proposal.
//
// Exit codes (mapped by `runWithJsonErrors` from the typed errors thrown by
// `akmProposalRevert` / `revertProposal`):
//   0 — success; prior content restored.
//   1 — generic error (also used by `UsageError("INVALID_FLAG_VALUE")` and
//       `UsageError("MISSING_REQUIRED_ARGUMENT")` when the proposal is not
//       accepted, or no backup is available).
//   1 — `NotFoundError("FILE_NOT_FOUND")` when the proposal id does not resolve.
const proposalRevertCommand = defineJsonCommand({
  meta: {
    name: "revert",
    description:
      "Revert an accepted proposal: restore the prior asset content from the backup captured at promotion time. " +
      "Errors if the proposal is not accepted or has no backup (new-asset proposals leave no backup). " +
      "Accepts the full proposal UUID or the asset ref. UUID prefixes are not supported for archived proposals — use the full UUID.",
  },
  args: {
    id: {
      type: "positional",
      description:
        "Proposal id (full uuid) or asset ref (e.g. skill:akm-dream). UUID prefixes are not supported for archived proposals — use the full UUID.",
      required: true,
    },
    target: { type: "string", description: "Override the write target by source name" },
  },
  async run({ args }) {
    const result = await akmProposalRevert({
      id: args.id as string,
      target: args.target as string | undefined,
    });
    output("proposal-revert", result);
  },
});

// `proposal show` (#225): show a single proposal with its validation findings.
// `akmProposalShow` already backs `akm show proposal <id>` (now deprecated); this
// is the canonical noun-group entry point.
const proposalShowCommand = defineJsonCommand({
  meta: { name: "show", description: "Show a single proposal and its validation findings" },
  args: {
    id: {
      type: "positional",
      description: "Proposal id (uuid / prefix) or asset ref (e.g. skill:akm-dream)",
      required: true,
    },
  },
  run({ args }) {
    const result = akmProposalShow({ id: args.id as string });
    output("proposal-show", result);
  },
});

const proposalDrainCommand = defineJsonCommand({
  meta: {
    name: "drain",
    description: "Drain the standing pending proposal backlog using a deterministic triage policy",
  },
  args: {
    policy: {
      type: "string",
      description: "Built-in preset (personal-stash|conservative|manual) or path to a policy file",
    },
    "dry-run": {
      type: "boolean",
      description: "List what would be accepted/rejected/deferred without writing.",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip confirmation prompt (required in non-interactive mode for promotion).",
      default: false,
    },
    "max-accepts": {
      type: "string",
      description: "Hard per-run accept ceiling. Accepts beyond this are reported as skippedByCap.",
    },
    "max-diff-lines": {
      type: "string",
      description: "Defer (never promote) accepts whose proposed content exceeds this many lines.",
    },
    "older-than": {
      type: "string",
      description: "Only consider proposals created more than this many days ago.",
    },
    promote: {
      type: "boolean",
      description: "Promote (accept) matching proposals. Default is queue mode (stage only, no writes to assets).",
      default: false,
    },
    judgment: {
      type: "boolean",
      description:
        "Opt into the judgment tier (llm by default; agent/sdk per config) for deferred items. No-op with a logged triage_deferred summary when no runner is configured.",
      default: false,
    },
    strategy: {
      type: "string",
      description: "Read the triage block (policy, applyMode, ceilings, judgment) from this improve strategy.",
    },
  },
  async run({ args, rawArgs }) {
    if (rawArgs.some((arg) => arg === "--profile" || arg.startsWith("--profile="))) {
      throw new UsageError("proposal drain: --profile is retired; use --strategy.", "INVALID_FLAG_VALUE");
    }
    const stashDir = resolveStashDir();
    const cfg = loadConfig();

    // Phase 2: read the triage block from the named improve strategy. CLI flags
    // always override config; config supplies defaults for any flag omitted.
    const selectedStrategy = resolveImproveStrategy(args.strategy as string | undefined, cfg);
    const triageConfig = selectedStrategy.config.processes?.triage;

    const policy = resolveDrainPolicy((args.policy as string | undefined) ?? triageConfig?.policy);
    const dryRun = args["dry-run"] === true;
    const applyMode: "queue" | "promote" = args.promote === true ? "promote" : (triageConfig?.applyMode ?? "queue");

    const maxAccepts =
      parsePositiveIntFlag(args["max-accepts"] as string | undefined, "--max-accepts") ??
      triageConfig?.maxAcceptsPerRun ??
      25;
    const maxDiffLines =
      parsePositiveIntFlag(args["max-diff-lines"] as string | undefined, "--max-diff-lines") ??
      triageConfig?.maxDiffLines;

    const rawOlderThan = parsePositiveIntFlag(args["older-than"] as string | undefined, "--older-than");
    const olderThanMs = rawOlderThan !== undefined ? rawOlderThan * 86_400_000 : undefined;

    // Promotion in promote mode is destructive (commits to git, no batch revert).
    if (applyMode === "promote" && !dryRun) {
      const { confirmDestructive } = await import("../../cli/confirm.js");
      const confirmed = await confirmDestructive(
        `Drain and promote matching pending proposals under policy "${policy.name}"? Promotions commit to git and cannot be batch-reverted.`,
        { yes: args.yes === true },
      );
      if (!confirmed) {
        process.stderr.write("Aborted.\n");
        return;
      }
    }

    // `--older-than` is applied here as a pre-filter on excludeIds: ids that
    // are too fresh are excluded so the engine never touches them. This reads
    // the pending set once here; drainProposals reads the pending set again
    // internally, so a future engine-level olderThan option could remove this
    // second read (engine API owned by another agent — not changed here).
    let excludeIds: Set<string> | undefined;
    if (olderThanMs !== undefined) {
      const { listProposals } = await import("./repository");
      const now = Date.now();
      excludeIds = new Set(
        listProposals(stashDir, { status: "pending" })
          // Fail SAFE: exclude a proposal when its age cannot be computed
          // (NaN createdAt) OR it is too fresh. An unparseable createdAt must
          // never be treated as old enough to drain/promote.
          .filter((proposal) => {
            const age = now - new Date(proposal.createdAt).getTime();
            return Number.isNaN(age) || age < olderThanMs;
          })
          .map((proposal) => proposal.id),
      );
    }

    // Phase 3: resolve the judgment runner when --judgment is set. Default
    // mode is llm; falls back to defaults.llm when the triage block sets
    // no explicit engine selection. null when
    // nothing is configured → the engine leaves deferred items unresolved and
    // emits triage_deferred.
    const judgment =
      args.judgment === true
        ? resolveTriageJudgmentRunner(triageConfig?.judgment, cfg, triageConfig, selectedStrategy.config)
        : null;

    // #576: persist + attribute per-call LLM usage for the standalone drain
    // path. `IfAbsent` keeps an enclosing `akm improve` sink in charge when
    // drain runs as a sub-step; the disposer clears only a sink we installed.
    const disposeDrainUsageSink = installLlmUsagePersistenceIfAbsent();
    let result: Awaited<ReturnType<typeof drainProposals>>;
    try {
      result = await withLlmStage("drain", () =>
        drainProposals({
          stashDir,
          config: cfg,
          policy,
          applyMode,
          maxAccepts,
          dryRun,
          ...(maxDiffLines !== undefined ? { maxDiffLines } : {}),
          ...(excludeIds ? { excludeIds } : {}),
          judgment,
        }),
      );
    } finally {
      disposeDrainUsageSink();
    }

    output("proposal-drain", {
      schemaVersion: 1,
      ok: true,
      policy: policy.name,
      applyMode,
      dryRun,
      strategy: selectedStrategy.name,
      judgmentEngine: judgment?.engine ?? null,
      judgmentKind: judgment?.kind ?? null,
      promoted: result.promoted,
      rejected: result.rejected,
      deferred: result.deferred,
      skippedByCap: result.skippedByCap,
      staged: result.staged,
    });
  },
});

// ── proposal noun group (#225 / 0.8 CLI stabilization) ────────────────────────
//
// `akm proposal <verb>` is the canonical grammar in 0.8. The flat verbs
// (`proposals`/`accept`/`reject`/`diff`/`revert`) remain as deprecated aliases
// that warn to stderr and delegate to the same command bodies; they are removed
// in 0.9.0. Bare `akm proposal` behaves as `proposal list` (mirrors `akm env`).

export const proposalCommand = defineGroupCommand({
  meta: { name: "proposal", description: "Manage the proposal queue: list, show, diff, accept, reject, revert" },
  args: {
    status: {
      type: "string",
      description: "Filter by status (pending|accepted|rejected|reverted)",
    },
    ref: { type: "string", description: "Filter by asset ref (type:name)" },
    type: { type: "string", description: "Filter by asset type" },
  },
  subCommands: {
    list: proposalListCommand,
    show: proposalShowCommand,
    diff: proposalDiffCommand,
    accept: proposalAcceptCommand,
    reject: proposalRejectCommand,
    revert: proposalRevertCommand,
    drain: proposalDrainCommand,
  },
  // Default body fires only for bare `akm proposal [--status …]`.
  defaultRun({ args }) {
    const status = parseProposalStatus(args.status);
    const result = akmProposalList({
      status,
      ref: args.ref,
      type: args.type,
      includeArchive: status === "accepted" || status === "rejected" || status === "reverted",
    });
    output("proposal-list", result);
  },
});
