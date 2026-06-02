// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deterministic proposal-drain engine (Proposal-Queue Triage, Phase 1).
 *
 * Drains the *standing pending backlog* of proposals using a deterministic,
 * no-LLM policy keyed on generator (proposal `source`) and diff size. This is
 * the engine behind `akm proposal drain` and (later) the `triage` improve
 * pre-pass.
 *
 * Design (see docs/technical/proposal-triage-implementation-plan.md):
 *   - Reuses `listProposals` (no source filter — generator filtering is
 *     in-memory) and the `akmProposalAccept` / `akmProposalReject` wrappers from
 *     `proposal.ts` so the standard `promoted` / `rejected` events are emitted.
 *     It deliberately does NOT use `runAutoAcceptGate`, which is confidence-gated.
 *   - Backlog-only: `excludeIds` removes this-run's fresh proposals so triage
 *     never re-adjudicates the per-run auto-accept gate's decisions (decision #2).
 *   - Hard guardrails enforced in code: a `maxAccepts` ceiling checked *before*
 *     the promote loop (remainder → `skippedByCap`); `maxDiffLines` defers large
 *     accepts; `applyMode: "queue"` (the safe default) never promotes (stage
 *     only); `rejectEmpty` rejects empty / near-empty diffs.
 *   - The judgment tier (Phase 3) adjudicates the deferred items: when a
 *     `judgment` RunnerSpec is supplied the engine pre-fetches context (the live
 *     asset + sibling pending proposals for the same ref) into a prompt,
 *     dispatches it to the configured runner (llm → `chatCompletion`, agent →
 *     `runAgent`, sdk → `runOpencodeSdk`, mirroring `reflect.ts`'s switch), and
 *     performs the resulting accept / reject *itself* (the runner only judges).
 *     Items the runner cannot resolve — and any deferred items when no runner is
 *     configured — surface a `triage_deferred` event so "enabled, no agent"
 *     never silently looks like full success.
 *
 * The promote / reject functions and the runner dispatch are injectable
 * (mirrors `improve-auto-accept.ts` and reflect's dual test seams) so tests can
 * run the full engine without touching the filesystem or spawning a process.
 */

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../core/asset-ref";
import { resolveAssetPathFromName, TYPE_DIRS } from "../core/asset-spec";
import type { EventsContext } from "../core/events";
import { appendEvent } from "../core/events";
import { listProposals, type Proposal } from "../core/proposals";
import { info, warn } from "../core/warn";
import { type AgentRunResult, runAgent } from "../integrations/agent";
import type { RunnerSpec } from "../integrations/agent/runner";
import { runOpencodeSdk } from "../integrations/agent/sdk-runner";
import { type ChatMessage, chatCompletion, stripJsonFences } from "../llm/client";
import { akmProposalAccept, akmProposalReject } from "./proposal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single accept rule within a {@link DrainPolicy}. */
export interface DrainAcceptRule {
  /** Generator (proposal `source`) this rule matches, e.g. "extract". */
  generator: string;
  /** Accept only when the proposed content is <= this many lines. */
  maxDiffLines?: number;
  /** Accept only when the proposed content has >= this many body lines. */
  minContentLines?: number;
}

/** A deterministic triage policy: which generators auto-accept / defer. */
export interface DrainPolicy {
  name: string;
  /** Generators (with optional size bounds) whose proposals auto-accept. */
  accept: DrainAcceptRule[];
  /** Reject proposals whose diff is empty / near-empty. */
  rejectEmpty: boolean;
  /**
   * Generators whose mid-band / ambiguous items are deferred to the judgment
   * tier (Phase 3). For Phase 1 these simply land in `deferred[]` unprocessed.
   */
  defer: string[];
}

export type DrainDeferReason = "mid-band" | "possible-dup" | "possible-contradiction";

export interface DrainOptions {
  stashDir: string;
  policy: DrainPolicy;
  /** "queue" (default, safe) stages only and never promotes; "promote" accepts. */
  applyMode: "queue" | "promote";
  /** Hard per-run accept ceiling, enforced before the promote loop. */
  maxAccepts: number;
  /** When true, performs zero writes (no accept / reject). */
  dryRun: boolean;
  /** Fresh-this-run proposal ids to exclude (decision #2). */
  excludeIds?: Set<string>;
  /**
   * Optional global diff-line bound. Accepts whose content exceeds this are
   * deferred ("mid-band"), never promoted. Applied in addition to any per-rule
   * `maxDiffLines`.
   */
  maxDiffLines?: number;
  /**
   * Optional judgment tier (Phase 3). When a RunnerSpec is supplied the engine
   * adjudicates each deferred item through the runner and performs the resulting
   * accept / reject itself. `null` / absent leaves deferred items unresolved and
   * emits `triage_deferred`.
   */
  judgment?: RunnerSpec | null;
  eventsCtx?: EventsContext;
}

export interface DrainResult {
  /** Proposal ids promoted (accepted) this run. Empty in queue / dry-run mode. */
  promoted: string[];
  /** Proposal ids rejected (empty diffs) this run. Empty in dry-run mode. */
  rejected: string[];
  /** Proposals left for the judgment tier, with the reason they were deferred. */
  deferred: Array<{ id: string; reason: DrainDeferReason }>;
  /** Accept candidates dropped because the `maxAccepts` ceiling was reached. */
  skippedByCap: string[];
}

// Injectable test seams (mirrors improve-auto-accept.ts's promoteFn override).
export type PromoteFn = typeof akmProposalAccept;
export type RejectFn = typeof akmProposalReject;

/** A single verdict the judgment runner returns for a deferred proposal. */
export interface JudgmentVerdict {
  decision: "accept" | "reject" | "defer";
  reason: string;
}

/**
 * Injectable runner seams for the judgment tier, mirroring reflect's dual test
 * seams (`chat` for the LLM HTTP path, `runAgentFn` for the spawn path). Tests
 * inject a fake `chat` (llm-mode) or `runAgentFn` (agent-mode) so the dispatch
 * switch runs deterministically without a network call or a real process.
 */
export interface JudgmentSeams {
  /** Test seam for the `llm` runner kind — replaces `chatCompletion`. */
  chat?: (config: RunnerSpec & { kind: "llm" }, messages: ChatMessage[]) => Promise<string>;
  /** Test seam for the `agent` runner kind — replaces `runAgent`. */
  runAgentFn?: typeof runAgent;
  /** Test seam for the `sdk` runner kind — replaces `runOpencodeSdk`. */
  runSdkFn?: typeof runOpencodeSdk;
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** Strip a leading YAML frontmatter block (`---\n...\n---`) from content. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const after = content.indexOf("\n", end + 1);
  return after === -1 ? "" : content.slice(after + 1);
}

/** Number of non-empty body lines (frontmatter excluded). */
export function contentBodyLineCount(content: string): number {
  return stripFrontmatter(content)
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

/** Total line count of the proposed content (matches the bulk-accept measure). */
export function contentLineCount(content: string): number {
  return content.split("\n").length;
}

/** An empty / near-empty diff has no meaningful body content. */
export function isEmptyDiff(proposal: Proposal): boolean {
  const content = proposal.payload.content ?? "";
  if (content.trim().length === 0) return true;
  return contentBodyLineCount(content) === 0;
}

/**
 * Decide a deterministic verdict for a single backlog proposal under `policy`.
 * Returns `null` when no rule applies (the proposal is left pending untouched).
 */
export function classifyProposal(
  proposal: Proposal,
  policy: DrainPolicy,
  maxDiffLines?: number,
):
  | { verdict: "accept" }
  | { verdict: "reject"; reason: string }
  | { verdict: "defer"; reason: DrainDeferReason }
  | null {
  const content = proposal.payload.content ?? "";

  // Empty / near-empty diffs reject first (the reject-empty floor).
  if (policy.rejectEmpty && isEmptyDiff(proposal)) {
    return { verdict: "reject", reason: "empty diff" };
  }

  const rule = policy.accept.find((r) => r.generator === proposal.source);
  if (rule) {
    const lines = contentLineCount(content);
    const body = contentBodyLineCount(content);
    // Per-rule and global diff bounds defer large accepts (no silent rewrites).
    const effectiveMax = Math.min(
      rule.maxDiffLines ?? Number.POSITIVE_INFINITY,
      maxDiffLines ?? Number.POSITIVE_INFINITY,
    );
    if (lines > effectiveMax) {
      return { verdict: "defer", reason: "mid-band" };
    }
    if (rule.minContentLines !== undefined && body < rule.minContentLines) {
      // Too little content to confidently auto-accept — leave for judgment.
      return { verdict: "defer", reason: "mid-band" };
    }
    return { verdict: "accept" };
  }

  if (policy.defer.includes(proposal.source)) {
    return { verdict: "defer", reason: deferReasonForSource(proposal.source) };
  }

  // No matching rule — leave pending, untouched.
  return null;
}

function deferReasonForSource(source: string): DrainDeferReason {
  if (source === "distill") return "possible-dup";
  if (source === "consolidate") return "mid-band";
  return "mid-band";
}

// ---------------------------------------------------------------------------
// Judgment tier (Phase 3)
// ---------------------------------------------------------------------------

/** Read the live on-disk content of a proposal's target asset, if it exists. */
function readLiveAssetContent(stashDir: string, ref: string): string | undefined {
  try {
    const parsed = parseAssetRef(ref);
    const typeDir = TYPE_DIRS[parsed.type];
    if (!typeDir) return undefined;
    const typeRoot = path.join(stashDir, typeDir);
    const assetPath = resolveAssetPathFromName(parsed.type, typeRoot, parsed.name);
    if (!fs.existsSync(assetPath)) return undefined;
    return fs.readFileSync(assetPath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Pre-fetch the context the judgment runner needs to adjudicate one deferred
 * proposal: the proposed content, the live asset it would overwrite, and the
 * sibling pending proposals for the same ref (so a dedup verdict can compare).
 */
function prefetchJudgmentContext(
  stashDir: string,
  proposal: Proposal,
  pending: Proposal[],
): { liveAsset: string | undefined; siblings: Proposal[] } {
  const liveAsset = readLiveAssetContent(stashDir, proposal.ref);
  const siblings = pending.filter((p) => p.ref === proposal.ref && p.id !== proposal.id);
  return { liveAsset, siblings };
}

/** Build the judgment prompt with the proposed content + pre-fetched context. */
export function buildJudgmentPrompt(
  proposal: Proposal,
  reason: DrainDeferReason,
  ctx: { liveAsset: string | undefined; siblings: Proposal[] },
): string {
  const proposed = proposal.payload.content ?? "";
  const sections: string[] = [
    "You are adjudicating a pending knowledge-base proposal that the deterministic",
    "triage pass could not resolve. Decide whether to accept, reject, or defer it.",
    "",
    `Asset ref: ${proposal.ref}`,
    `Generator (source): ${proposal.source}`,
    `Deferred because: ${reason}`,
    "",
    "## Proposed content",
    "```",
    proposed,
    "```",
  ];

  if (ctx.liveAsset !== undefined) {
    sections.push("", "## Current live asset (would be overwritten on accept)", "```", ctx.liveAsset, "```");
  } else {
    sections.push("", "## Current live asset", "(none — this proposal would create a new asset)");
  }

  if (ctx.siblings.length > 0) {
    sections.push("", "## Other pending proposals for the same ref (dedup context)");
    for (const sib of ctx.siblings) {
      sections.push("", `### Sibling ${sib.id} (source: ${sib.source})`, "```", sib.payload.content ?? "", "```");
    }
  }

  sections.push(
    "",
    "## Your task",
    'Return ONLY a JSON object: {"decision": "accept" | "reject" | "defer", "reason": "<short reason>"}.',
    "- accept: the proposed content is a correct, valuable update worth committing.",
    "- reject: the proposal is wrong, a duplicate, or contradicts the live asset.",
    "- defer: you cannot decide from the provided context (leave it pending).",
    "Output the JSON object and nothing else.",
  );

  return sections.join("\n");
}

/** Parse a {@link JudgmentVerdict} from raw runner output. Lenient. */
export function parseJudgmentVerdict(raw: string): JudgmentVerdict | null {
  const cleaned = stripJsonFences(raw).trim();
  if (!cleaned) return null;
  // Find the first balanced-looking JSON object in the output.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const decision = (obj as { decision?: unknown }).decision;
  const reason = (obj as { reason?: unknown }).reason;
  if (decision !== "accept" && decision !== "reject" && decision !== "defer") return null;
  return { decision, reason: typeof reason === "string" ? reason : "" };
}

/**
 * Dispatch a single judgment prompt to the resolved runner. The switch mirrors
 * the canonical consumer at `reflect.ts:1060-1090`: llm → `chatCompletion`
 * (no filesystem), agent → `runAgent`, sdk → `runOpencodeSdk`.
 */
async function dispatchJudgment(
  runner: RunnerSpec,
  prompt: string,
  seams: JudgmentSeams,
): Promise<JudgmentVerdict | null> {
  let raw: string;
  switch (runner.kind) {
    case "llm": {
      const messages: ChatMessage[] = [{ role: "user", content: prompt }];
      raw = seams.chat
        ? await seams.chat(runner, messages)
        : await chatCompletion(runner.connection, messages, {
            ...(runner.timeoutMs !== undefined ? { timeoutMs: runner.timeoutMs } : {}),
          });
      break;
    }
    case "agent": {
      const run = seams.runAgentFn ?? runAgent;
      const result: AgentRunResult = await run(runner.profile, prompt, {
        stdio: "captured",
        parseOutput: "text",
        ...(runner.timeoutMs !== undefined ? { timeoutMs: runner.timeoutMs } : {}),
      });
      if (!result.ok) {
        warn(`[triage] judgment agent failed: ${result.error ?? result.reason ?? "unknown error"}`);
        return null;
      }
      raw = result.stdout;
      break;
    }
    case "sdk": {
      const run = seams.runSdkFn ?? runOpencodeSdk;
      const result: AgentRunResult = await run(runner.profile, prompt, {
        stdio: "captured",
        parseOutput: "text",
        ...(runner.timeoutMs !== undefined ? { timeoutMs: runner.timeoutMs } : {}),
      });
      if (!result.ok) {
        warn(`[triage] judgment sdk failed: ${result.error ?? result.reason ?? "unknown error"}`);
        return null;
      }
      raw = result.stdout;
      break;
    }
  }
  return parseJudgmentVerdict(raw);
}

interface JudgmentTierInput {
  stashDir: string;
  applyMode: "queue" | "promote";
  dryRun: boolean;
  runner: RunnerSpec;
  deferred: Array<{ id: string; reason: DrainDeferReason }>;
  pending: Proposal[];
  promoteFn: PromoteFn;
  rejectFn: RejectFn;
  seams: JudgmentSeams;
}

/**
 * Run the judgment tier over the deferred items. The runner only *judges*; the
 * engine performs the resulting accept (respecting `applyMode`) / reject write.
 * Returns the ids the engine promoted / rejected and the items still unresolved
 * (verdict "defer", parse failure, or a runner error).
 */
async function runJudgmentTier(input: JudgmentTierInput): Promise<{
  promoted: string[];
  rejected: string[];
  stillDeferred: Array<{ id: string; reason: DrainDeferReason }>;
}> {
  const byId = new Map(input.pending.map((p) => [p.id, p]));
  const promoted: string[] = [];
  const rejected: string[] = [];
  const stillDeferred: Array<{ id: string; reason: DrainDeferReason }> = [];

  for (const item of input.deferred) {
    const proposal = byId.get(item.id);
    if (!proposal) {
      stillDeferred.push(item);
      continue;
    }
    const ctx = prefetchJudgmentContext(input.stashDir, proposal, input.pending);
    const prompt = buildJudgmentPrompt(proposal, item.reason, ctx);

    let verdict: JudgmentVerdict | null;
    try {
      verdict = await dispatchJudgment(input.runner, prompt, input.seams);
    } catch (err) {
      warn(`[triage] judgment dispatch failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      stillDeferred.push(item);
      continue;
    }

    if (!verdict || verdict.decision === "defer") {
      stillDeferred.push(item);
      continue;
    }

    if (verdict.decision === "reject") {
      if (input.dryRun) {
        rejected.push(item.id);
        continue;
      }
      try {
        input.rejectFn({ stashDir: input.stashDir, id: item.id, reason: verdict.reason || "judgment: reject" });
        rejected.push(item.id);
      } catch (err) {
        warn(`[triage] judgment reject failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
        stillDeferred.push(item);
      }
      continue;
    }

    // decision === "accept" — gated on applyMode, exactly like the
    // deterministic accept path (queue mode never writes).
    if (input.applyMode !== "promote") {
      // Staged: a queue-mode run never promotes, so the item stays pending but
      // is no longer "unresolved" (the runner judged it). Report as deferred so
      // the staged accept is visible and a follow-up promote run picks it up.
      stillDeferred.push(item);
      continue;
    }
    if (input.dryRun) {
      promoted.push(item.id);
      continue;
    }
    try {
      await input.promoteFn({ stashDir: input.stashDir, id: item.id });
      promoted.push(item.id);
    } catch (err) {
      warn(`[triage] judgment promote failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      stillDeferred.push(item);
    }
  }

  return { promoted, rejected, stillDeferred };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Drain the standing pending backlog under a deterministic policy.
 *
 * @param opts       Drain options (policy, applyMode, ceilings, dry-run).
 * @param promoteFn  Injectable override for `akmProposalAccept` (test seam).
 * @param rejectFn   Injectable override for `akmProposalReject` (test seam).
 */
export async function drainProposals(
  opts: DrainOptions,
  promoteFn: PromoteFn = akmProposalAccept,
  rejectFn: RejectFn = akmProposalReject,
  judgmentSeams: JudgmentSeams = {},
): Promise<DrainResult> {
  const result: DrainResult = { promoted: [], rejected: [], deferred: [], skippedByCap: [] };

  const exclude = opts.excludeIds ?? new Set<string>();
  const pending = listProposals(opts.stashDir, { status: "pending" }).filter((p) => !exclude.has(p.id));

  // First, classify every proposal deterministically.
  const acceptIds: string[] = [];
  const rejectTargets: Array<{ id: string; reason: string }> = [];

  for (const proposal of pending) {
    const decision = classifyProposal(proposal, opts.policy, opts.maxDiffLines);
    if (decision === null) continue;
    if (decision.verdict === "accept") {
      acceptIds.push(proposal.id);
    } else if (decision.verdict === "reject") {
      rejectTargets.push({ id: proposal.id, reason: decision.reason });
    } else {
      result.deferred.push({ id: proposal.id, reason: decision.reason });
    }
  }

  // --- Reject empties (independent of the accept ceiling / applyMode) ---
  for (const target of rejectTargets) {
    if (opts.dryRun) {
      result.rejected.push(target.id);
      continue;
    }
    try {
      rejectFn({ stashDir: opts.stashDir, id: target.id, reason: target.reason });
      result.rejected.push(target.id);
    } catch (err) {
      warn(`[triage] reject failed for ${target.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Accept ceiling: enforced BEFORE the promote loop ---
  const withinCap = acceptIds.slice(0, Math.max(0, opts.maxAccepts));
  result.skippedByCap = acceptIds.slice(Math.max(0, opts.maxAccepts));
  if (result.skippedByCap.length > 0) {
    info(
      `[triage] accept ceiling reached: ${withinCap.length} promoted, ${result.skippedByCap.length} skipped by cap (maxAccepts=${opts.maxAccepts})`,
    );
  }

  // --- Promotion gate: applyMode "queue" never promotes (stage only) ---
  if (opts.applyMode === "promote" && !opts.dryRun) {
    info(`[triage] auto-promote active: ${withinCap.length} accepts allowed this run`);
    for (const id of withinCap) {
      try {
        await promoteFn({ stashDir: opts.stashDir, id });
        result.promoted.push(id);
      } catch (err) {
        warn(`[triage] promote failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (opts.applyMode === "promote" && opts.dryRun) {
    // Dry-run promote: report what would be promoted without writing.
    result.promoted.push(...withinCap);
  }
  // applyMode "queue": leave accept candidates pending (staged). No promotion.

  // --- Judgment tier (Phase 3): adjudicate the deferred items ---
  // Only runs when a RunnerSpec is configured. The runner returns a verdict; the
  // ENGINE performs the resulting accept (respecting applyMode) / reject write.
  if (opts.judgment && result.deferred.length > 0) {
    const tier = await runJudgmentTier({
      stashDir: opts.stashDir,
      applyMode: opts.applyMode,
      dryRun: opts.dryRun,
      runner: opts.judgment,
      deferred: result.deferred,
      pending,
      promoteFn,
      rejectFn,
      seams: judgmentSeams,
    });
    result.promoted.push(...tier.promoted);
    result.rejected.push(...tier.rejected);
    // Replace the deferred list with whatever the judgment tier could not
    // resolve (verdict "defer", staged queue-mode accepts, or runner failures).
    result.deferred = tier.stillDeferred;
  }

  emitDrainEvents(opts, result);

  return result;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function emitDrainEvents(opts: DrainOptions, result: DrainResult): void {
  const deferredByReason: Record<string, number> = {};
  for (const d of result.deferred) {
    deferredByReason[d.reason] = (deferredByReason[d.reason] ?? 0) + 1;
  }

  appendEvent(
    {
      eventType: "triage_drained",
      metadata: {
        promoted: result.promoted.length,
        rejected: result.rejected.length,
        deferredByReason,
        skippedByCap: result.skippedByCap.length,
        policy: opts.policy.name,
        applyMode: opts.applyMode,
        ...(opts.dryRun ? { dryRun: true } : {}),
      },
    },
    opts.eventsCtx ?? {},
  );

  // Surface any items still unresolved after the (optional) judgment tier so a
  // backlog of deferred items never silently looks like full success. This
  // fires both when no runner is configured AND when the judgment tier ran but
  // could not resolve every item (verdict "defer", staged queue accept, or a
  // runner error).
  if (result.deferred.length > 0) {
    appendEvent(
      {
        eventType: "triage_deferred",
        metadata: {
          deferred: result.deferred.length,
          deferredByReason,
          reason: opts.judgment ? "judgment tier left items unresolved" : "no judgment runner configured",
        },
      },
      opts.eventsCtx ?? {},
    );
  }
}
